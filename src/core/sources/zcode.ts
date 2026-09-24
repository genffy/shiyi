import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { localSourceRoots } from '../paths.js';
import { truncate, type CommonMessage, type CommonSession, type LocalSourceAdapter, type LocalSourceFile, type ToolCallBrief } from '../types.js';

interface NativeSession {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
}

interface NativeRow {
  id: string;
  data: string;
  time_created: number;
}

interface NativeMessageData {
  role?: string;
  synthetic?: boolean;
  semantics?: { transcriptVisibility?: string };
}

interface NativePartData {
  type?: string;
  text?: string;
  synthetic?: boolean;
  mime?: string;
  tool?: string;
  state?: { input?: Record<string, unknown> };
}

function iso(ms: number): string | undefined {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toolBrief(part: NativePartData): ToolCallBrief {
  const input = part.state?.input;
  let brief = '';
  if (input && typeof input === 'object') {
    for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url']) {
      if (typeof input[key] === 'string') {
        brief = truncate(input[key], 80);
        break;
      }
    }
  }
  return { name: part.tool || 'tool', brief };
}

/** ZCode CLI stores user-visible sessions in one SQLite database, with messages split into parts. */
export class ZcodeAdapter implements LocalSourceAdapter {
  readonly source = 'zcode' as const;
  readonly syncOnChange = true;

  constructor(readonly dbFile = localSourceRoots().zcode) {}

  watchRoots(): string[] {
    return [path.dirname(this.dbFile)];
  }

  watchFiles(): string[] {
    return [this.dbFile, `${this.dbFile}-wal`];
  }

  acceptsPath(p: string): boolean {
    return p === this.dbFile || p === `${this.dbFile}-wal`;
  }

  listFiles(): LocalSourceFile[] {
    if (!fs.existsSync(this.dbFile)) return [];
    const db = new Database(this.dbFile, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id, time_updated FROM session WHERE parent_id IS NULL').all() as Array<{ id: string; time_updated: number }>;
      return rows.map((row) => ({ path: `${this.dbFile}#${encodeURIComponent(row.id)}`, size: 0, mtimeMs: row.time_updated }));
    } finally {
      db.close();
    }
  }

  async parseFile(filePath: string): Promise<CommonSession | null> {
    const prefix = `${this.dbFile}#`;
    if (!filePath.startsWith(prefix)) return null;
    const id = decodeURIComponent(filePath.slice(prefix.length));
    const db = new Database(this.dbFile, { readonly: true, fileMustExist: true });
    try {
      const session = db.prepare('SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ? AND parent_id IS NULL').get(id) as NativeSession | undefined;
      if (!session) return null;
      const rows = db.prepare('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY COALESCE(sequence, time_created), id').all(id) as NativeRow[];
      const parts = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY COALESCE(sequence, time_created), id').all(id) as Array<{ message_id: string; data: string }>;
      const partsByMessage = new Map<string, NativePartData[]>();
      for (const row of parts) {
        const part = parseJson<NativePartData>(row.data);
        if (!part || part.synthetic) continue;
        const group = partsByMessage.get(row.message_id) ?? [];
        group.push(part);
        partsByMessage.set(row.message_id, group);
      }

      const messages: CommonMessage[] = [];
      let pendingTools: ToolCallBrief[] = [];
      let pendingThinking: string[] = [];
      const attachPending = (message: CommonMessage) => {
        if (pendingTools.length) message.toolCalls = [...pendingTools, ...(message.toolCalls ?? [])];
        if (pendingThinking.length) message.thinking = [...pendingThinking, message.thinking].filter(Boolean).join('\n\n');
        pendingTools = [];
        pendingThinking = [];
      };
      const flushToPrevious = () => {
        const previous = [...messages].reverse().find((m) => m.role === 'assistant');
        if (previous) attachPending(previous);
      };

      for (const row of rows) {
        const data = parseJson<NativeMessageData>(row.data);
        if (!data || data.synthetic || data.semantics?.transcriptVisibility === 'hidden') continue;
        if (data.role !== 'user' && data.role !== 'assistant') continue;
        const messageParts = partsByMessage.get(row.id) ?? [];
        const content = messageParts
          .map((p) => p.type === 'text' ? p.text?.trim() : p.type === 'file' ? `[${p.mime?.startsWith('image/') ? '图片' : '文件'}]` : undefined)
          .filter((s): s is string => !!s)
          .join('\n\n');
        const thinking = messageParts.filter((p) => p.type === 'reasoning' && p.text?.trim()).map((p) => p.text!.trim()).join('\n\n');
        const tools = messageParts.filter((p) => p.type === 'tool').map(toolBrief);
        if (data.role === 'user') {
          flushToPrevious();
          if (content) messages.push({ role: 'user', content, createdAt: iso(row.time_created) });
          continue;
        }
        if (!content) {
          pendingTools.push(...tools);
          if (thinking) pendingThinking.push(thinking);
          continue;
        }
        const message: CommonMessage = { role: 'assistant', content, createdAt: iso(row.time_created) };
        if (tools.length) message.toolCalls = tools;
        if (thinking) message.thinking = thinking;
        attachPending(message);
        messages.push(message);
      }
      flushToPrevious();
      if (!messages.length) return null;
      const firstUser = messages.find((m) => m.role === 'user')?.content;
      return {
        nativeId: session.id,
        source: this.source,
        title: session.title?.trim() || truncate(firstUser ?? '', 60) || '（无标题）',
        project: session.directory,
        startedAt: iso(session.time_created),
        endedAt: iso(session.time_updated),
        messages,
      };
    } finally {
      db.close();
    }
  }
}
