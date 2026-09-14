import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath } from './paths.js';
import { sessionKey, truncate, type CommonSession, type SourceId } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,   -- '<source>:<nativeId>'
  native_id     TEXT NOT NULL,
  source        TEXT NOT NULL,
  title         TEXT NOT NULL,
  project       TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  raw_path      TEXT,
  raw_size      INTEGER,
  raw_mtime     INTEGER,
  summary       TEXT,
  tags          TEXT,               -- JSON array, filled by LLM in phase 2
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_source_time ON sessions(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,    -- user | assistant
  content         TEXT NOT NULL,
  thinking        TEXT,             -- model reasoning (collapsed in the UI)
  tool_calls_json TEXT,
  created_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

-- full-text index: one row per session, body joins all user/assistant text
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);
`;

export interface SessionRow {
  id: string;
  native_id: string;
  source: SourceId;
  title: string;
  project: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  raw_path: string | null;
  raw_size: number | null;
  raw_mtime: number | null;
  summary: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  thinking: string | null;
  tool_calls_json: string | null;
  created_at: string | null;
}

export class ShiYiDb {
  readonly db: Database.Database;

  constructor(p = dbPath()) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** smooth upgrade for older databases: add later-introduced columns */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name)
    );
    if (!cols.has('thinking')) this.db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
  }

  close(): void {
    this.db.close();
  }

  /** file fingerprint recorded at last sync, used for incremental skipping */
  getRawFileInfo(source: SourceId, rawPath: string): { raw_size: number; raw_mtime: number } | undefined {
    const row = this.db
      .prepare('SELECT raw_size, raw_mtime FROM sessions WHERE source = ? AND raw_path = ?')
      .get(source, rawPath) as { raw_size: number; raw_mtime: number } | undefined;
    return row && row.raw_size != null && row.raw_mtime != null ? row : undefined;
  }

  upsertSession(session: CommonSession, raw?: { path: string; size: number; mtimeMs: number }): void {
    const id = sessionKey(session.source, session.nativeId);
    const body = session.messages
      .map((m) => m.content)
      .filter((c) => c.length > 0)
      .join('\n');

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions_fts WHERE session_id = ?').run(id);
      this.db
        .prepare(
          `INSERT INTO sessions (id, native_id, source, title, project, started_at, ended_at,
             message_count, raw_path, raw_size, raw_mtime, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, project = excluded.project,
             started_at = excluded.started_at, ended_at = excluded.ended_at,
             message_count = excluded.message_count,
             raw_path = excluded.raw_path, raw_size = excluded.raw_size,
             raw_mtime = excluded.raw_mtime, updated_at = excluded.updated_at`
        )
        .run(
          id,
          session.nativeId,
          session.source,
          session.title || truncate(body || '（无内容）', 60),
          session.project ?? null,
          session.startedAt ?? null,
          session.endedAt ?? null,
          session.messages.length,
          raw?.path ?? null,
          raw?.size ?? null,
          raw?.mtimeMs ?? null
        );
      const insertMsg = this.db.prepare(
        'INSERT INTO messages (session_id, seq, role, content, thinking, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      session.messages.forEach((m, i) => {
        insertMsg.run(
          id,
          i,
          m.role,
          m.content,
          m.thinking ?? null,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.createdAt ?? null
        );
      });
      this.db
        .prepare('INSERT INTO sessions_fts (session_id, title, body) VALUES (?, ?, ?)')
        .run(id, session.title || '', body);
    });
    tx();
  }

  listSessions(opts: {
    source?: SourceId;
    q?: string;
    limit?: number;
    offset?: number;
  }): { total: number; items: (SessionRow & { snippet?: string })[] } {
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.source) {
      where.push('source = @source');
      params.source = opts.source;
    }

    if (opts.q && opts.q.trim()) {
      return this.searchSessions(opts.q.trim(), opts.source, limit, offset);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM sessions ${whereSql}`).get(params) as { c: number }
    ).c;
    const items = this.db
      .prepare(
        `SELECT * FROM sessions ${whereSql} ORDER BY COALESCE(started_at, created_at) DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset }) as SessionRow[];
    return { total, items };
  }

  private searchSessions(
    q: string,
    source: SourceId | undefined,
    limit: number,
    offset: number
  ): { total: number; items: (SessionRow & { snippet?: string })[] } {
    // trigram needs >= 3 chars; shorter queries (e.g. two-char CJK words) fall back to LIKE
    if ([...q].length < 3) {
      const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
      const sourceSql = source ? 'AND s.source = @source' : '';
      const total = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM sessions s
             JOIN sessions_fts f ON f.session_id = s.id
             WHERE (s.title LIKE @like ESCAPE '\\' OR f.body LIKE @like ESCAPE '\\') ${sourceSql}`
          )
          .get({ like, source }) as { c: number }
      ).c;
      const items = this.db
        .prepare(
          `SELECT s.* FROM sessions s
           JOIN sessions_fts f ON f.session_id = s.id
           WHERE (s.title LIKE @like ESCAPE '\\' OR f.body LIKE @like ESCAPE '\\') ${sourceSql}
           ORDER BY COALESCE(s.started_at, s.created_at) DESC LIMIT @limit OFFSET @offset`
        )
        .all({ like, source, limit, offset }) as SessionRow[];
      return { total, items };
    }

    // wrap the FTS query in double quotes so user-typed connectives are not treated as syntax
    const match = `"${q.replace(/"/g, '""')}"`;
    const sourceSql = source ? 'AND s.source = @source' : '';
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM sessions s
           JOIN sessions_fts f ON f.session_id = s.id
           WHERE sessions_fts MATCH @match ${sourceSql}`
        )
        .get({ match, source }) as { c: number }
    ).c;
    const items = this.db
      .prepare(
        `SELECT s.*, snippet(sessions_fts, 2, '→', '←', '…', 24) AS snippet
         FROM sessions s
         JOIN sessions_fts f ON f.session_id = s.id
         WHERE sessions_fts MATCH @match ${sourceSql}
         ORDER BY COALESCE(s.started_at, s.created_at) DESC LIMIT @limit OFFSET @offset`
      )
      .all({ match, source, limit, offset }) as (SessionRow & { snippet: string })[];
    return { total, items };
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  getMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as MessageRow[];
  }

  sourceCounts(): { source: SourceId; count: number }[] {
    return this.db
      .prepare('SELECT source, COUNT(*) AS count FROM sessions GROUP BY source ORDER BY count DESC')
      .all() as { source: SourceId; count: number }[];
  }
}
