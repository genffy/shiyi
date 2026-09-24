import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ShiYiDb } from '../src/core/db.js';
import { ZcodeAdapter } from '../src/core/sources/zcode.js';
import { syncLocalSources } from '../src/core/sync.js';
import { startWatcher } from '../src/core/watcher.js';

const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiyi-zcode-'));
  dirs.push(dir);
  const file = path.join(dir, 'db.sqlite');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, sequence INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, sequence INTEGER, data TEXT);
  `);
  const t = Date.UTC(2026, 8, 24);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('sess_main', 'Fix the build', '/work/project', null, t, t + 1000);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('sess_child', 'subagent work', '/work/project', 'sess_main', t, t + 1000);
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  message.run('m1', 'sess_main', t, 1, JSON.stringify({ role: 'user', semantics: { transcriptVisibility: 'visible' } }));
  part.run('p1', 'm1', 'sess_main', t, 1, JSON.stringify({ type: 'text', text: 'Please fix the build' }));
  message.run('m2', 'sess_main', t + 10, 2, JSON.stringify({ role: 'user', synthetic: true, semantics: { transcriptVisibility: 'hidden' } }));
  part.run('p2', 'm2', 'sess_main', t + 10, 2, JSON.stringify({ type: 'text', text: 'internal reminder' }));
  message.run('m3', 'sess_main', t + 20, 3, JSON.stringify({ role: 'assistant' }));
  part.run('p3', 'm3', 'sess_main', t + 20, 3, JSON.stringify({ type: 'reasoning', text: 'I should inspect the config.' }));
  part.run('p4', 'm3', 'sess_main', t + 20, 4, JSON.stringify({ type: 'tool', tool: 'Bash', state: { input: { command: 'pnpm build' } } }));
  message.run('m4', 'sess_main', t + 30, 4, JSON.stringify({ role: 'assistant', semantics: { transcriptVisibility: 'visible' } }));
  part.run('p5', 'm4', 'sess_main', t + 30, 5, JSON.stringify({ type: 'text', text: 'Build fixed.' }));
  message.run('m5', 'sess_child', t + 40, 1, JSON.stringify({ role: 'assistant' }));
  part.run('p6', 'm5', 'sess_child', t + 40, 1, JSON.stringify({ type: 'text', text: 'child result' }));
  return { db, file, t, adapter: new ZcodeAdapter(file) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ZcodeAdapter', () => {
  it('imports top-level visible conversation, reasoning and tool briefs', async () => {
    const { db, adapter, file, t } = fixture();
    const files = adapter.listFiles();
    expect(files).toHaveLength(1);
    expect(adapter.acceptsPath(`${file}-wal`)).toBe(true);
    const session = await adapter.parseFile(files[0]!.path);
    expect(session).toMatchObject({ nativeId: 'sess_main', source: 'zcode', title: 'Fix the build', project: '/work/project' });
    expect(session!.startedAt).toBe(new Date(t).toISOString());
    expect(session!.messages.map((m) => m.content)).toEqual(['Please fix the build', 'Build fixed.']);
    expect(session!.messages[1]!.thinking).toBe('I should inspect the config.');
    expect(session!.messages[1]!.toolCalls).toEqual([{ name: 'Bash', brief: 'pnpm build' }]);
    db.close();
  });

  it('syncs updated sessions incrementally and exposes analysis counts', async () => {
    const { db: native, adapter, t } = fixture();
    const shiyi = new ShiYiDb(path.join(path.dirname(adapter.dbFile), 'shiyi.db'));
    expect((await syncLocalSources(shiyi, [adapter]))[0]).toMatchObject({ files: 1, parsed: 1 });
    expect((await syncLocalSources(shiyi, [adapter]))[0]).toMatchObject({ skipped: 1 });
    expect(shiyi.sourceAnalytics('zcode')).toMatchObject({ sessions: 1, messages: 2, userMessages: 1, assistantMessages: 1, toolCalls: 1, activeDays: 1 });
    native.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(t + 2000, 'sess_main');
    native.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m6', 'sess_main', t + 2000, 5, JSON.stringify({ role: 'user' }));
    native.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p7', 'm6', 'sess_main', t + 2000, 6, JSON.stringify({ type: 'text', text: 'One more question' }));
    expect((await syncLocalSources(shiyi, [adapter]))[0]).toMatchObject({ parsed: 1 });
    expect(shiyi.getMessages('zcode:sess_main').map((m) => m.content)).toEqual(['Please fix the build', 'Build fixed.', 'One more question']);
    shiyi.close();
    native.close();
  });

  it('watcher rescans the database when a session changes', async () => {
    const { db: native, adapter, t } = fixture();
    const shiyi = new ShiYiDb(path.join(path.dirname(adapter.dbFile), 'shiyi.db'));
    await syncLocalSources(shiyi, [adapter]);
    const watcher = startWatcher(shiyi, [adapter]);
    await watcher.ready;
    native.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?').run('Updated title', t + 3000, 'sess_main');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && shiyi.getSession('zcode:sess_main')?.title !== 'Updated title') {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(shiyi.getSession('zcode:sess_main')?.title).toBe('Updated title');
    await watcher.stop();
    shiyi.close();
    native.close();
  }, 20000);
});
