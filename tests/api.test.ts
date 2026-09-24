import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/server.js';
import { ShiYiDb } from '../src/core/db.js';

const cleanup: string[] = [];
function newDb(): ShiYiDb {
  const p = path.join(os.tmpdir(), `shiyi-api-${Date.now()}.db`);
  const db = new ShiYiDb(p);
  cleanup.push(p, `${p}-wal`, `${p}-shm`);
  return db;
}
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { force: true });
});

describe('API', () => {
  // CJK fixtures on purpose: exercise the trigram tokenizer and the <3-char LIKE fallback
  it('stats / session list / detail / search / sync / 404', async () => {
    const db = newDb();
    db.upsertSession({
      nativeId: 'api-1',
      source: 'claude-code',
      title: '内存泄漏排查',
      messages: [
        { role: 'user', content: '如何排查 Node 内存泄漏' },
        { role: 'assistant', content: '对比 heap snapshot 即可。' },
      ],
    });
    db.upsertSession({
      nativeId: 'api-2',
      source: 'codex',
      title: '另一个会话',
      messages: [{ role: 'user', content: '别的主题' }],
    });
    db.upsertSession({
      nativeId: 'z-1', source: 'zcode', title: '构建分析', project: '/work/demo', startedAt: '2026-09-24T10:00:00.000Z',
      messages: [
        { role: 'user', content: '检查构建' },
        { role: 'assistant', content: '构建正常', toolCalls: [{ name: 'Bash', brief: 'pnpm build' }] },
      ],
    });

    const app = await buildApp({ db, adapters: [] });

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(stats.statusCode).toBe(200);
    const statsBody = stats.json();
    expect(statsBody.total).toBe(3);
    expect(statsBody.sources.find((s: { source: string }) => s.source === 'zcode')).toMatchObject({ count: 1, label: 'ZCode' });

    const analytics = await app.inject({ method: 'GET', url: '/api/analytics?source=zcode' });
    expect(analytics.json()).toMatchObject({ sessions: 1, messages: 2, userMessages: 1, toolCalls: 1, projects: [{ project: '/work/demo', count: 1 }] });
    expect((await app.inject({ method: 'GET', url: '/api/analytics?source=unknown' })).statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: '/api/sessions?limit=1' });
    const listBody = list.json();
    expect(listBody.total).toBe(3);
    expect(listBody.items).toHaveLength(1);

    const filtered = await app.inject({ method: 'GET', url: '/api/sessions?source=codex' });
    expect(filtered.json().items[0]!.source).toBe('codex');

    // trigram full-text search
    const search = await app.inject({ method: 'GET', url: '/api/sessions?q=内存泄漏' });
    const searchBody = search.json();
    expect(searchBody.total).toBe(1);
    expect(searchBody.items[0]!.title).toBe('内存泄漏排查');
    expect(searchBody.items[0]!.snippet).toBeTruthy();

    // short query (<3 chars) falls back to LIKE
    const short = await app.inject({ method: 'GET', url: '/api/sessions?q=主题' });
    expect(short.json().total).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/api/sessions/${encodeURIComponent('claude-code:api-1')}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);

    const sync = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().results).toEqual([]);

    const missing = await app.inject({ method: 'GET', url: `/api/sessions/${encodeURIComponent('nope:404')}` });
    expect(missing.statusCode).toBe(404);
  });
});
