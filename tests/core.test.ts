import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShiYiDb } from '../src/core/db.js';
import { exportMarkdown } from '../src/core/export.js';
import { syncLocalSources } from '../src/core/sync.js';
import { iterJsonArray, stableId, toIso } from '../src/core/sources/json-utils.js';
import { classifyJson } from '../src/core/sources/detect.js';
import type { CommonSession, LocalSourceAdapter, LocalSourceFile } from '../src/core/types.js';

const cleanup: string[] = [];
function tmpPath(name: string): string {
  const p = path.join(os.tmpdir(), `shiyi-core-${Date.now()}-${name}`);
  cleanup.push(p);
  return p;
}
function newDb(): ShiYiDb {
  const db = new ShiYiDb(tmpPath('t.db'));
  cleanup.push(db.db.name!, `${db.db.name}-wal`, `${db.db.name}-shm`);
  return db;
}
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { force: true, recursive: true });
});

/** controllable fake adapter: counts parses, content swappable via version */
class FakeAdapter implements LocalSourceAdapter {
  source = 'claude-code' as const;
  parseCount = 0;
  version = 0;

  constructor(private file: string) {}

  listFiles(): LocalSourceFile[] {
    const st = fs.statSync(this.file);
    return [{ path: this.file, size: st.size, mtimeMs: st.mtimeMs }];
  }
  async parseFile(p: string): Promise<CommonSession | null> {
    this.parseCount++;
    return {
      nativeId: 'fake-1',
      source: this.source,
      title: `v${this.version} title`,
      messages: [
        { role: 'user', content: `v${this.version} question`, createdAt: '2026-09-01T00:00:00.000Z' },
        { role: 'assistant', content: `v${this.version} answer`, createdAt: '2026-09-01T00:00:01.000Z' },
      ],
    };
  }
  watchRoots(): string[] {
    return [];
  }
  acceptsPath(): boolean {
    return false;
  }
}

describe('sync incremental engine', () => {
  it('skips unchanged files; reparses on change; upsert leaves no duplicate messages', async () => {
    const file = tmpPath('s.jsonl');
    fs.writeFileSync(file, '{"a":1}\n');
    const db = newDb();
    const adapter = new FakeAdapter(file);

    let stats = await syncLocalSources(db, [adapter]);
    expect(stats[0]!.parsed).toBe(1);

    // same fingerprint -> skipped
    stats = await syncLocalSources(db, [adapter]);
    expect(stats[0]!.skipped).toBe(1);
    expect(adapter.parseCount).toBe(1);

    // simulate an append (size/mtime change) -> reparse and replace old messages
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
    await new Promise((r) => setTimeout(r, 10));
    adapter.version = 1;
    stats = await syncLocalSources(db, [adapter]);
    expect(stats[0]!.parsed).toBe(1);

    const row = db.getSession('claude-code:fake-1')!;
    expect(row.title).toBe('v1 title');
    expect(db.getMessages(row.id).map((m) => m.content)).toEqual(['v1 question', 'v1 answer']);
  });

  it('full=true wipes local-source rows and rebuilds', async () => {
    const file = tmpPath('s2.jsonl');
    fs.writeFileSync(file, '{"a":1}\n');
    const db = newDb();
    const adapter = new FakeAdapter(file);
    await syncLocalSources(db, [adapter]);
    const stats = await syncLocalSources(db, [adapter], { full: true });
    expect(stats[0]!.parsed).toBe(1);
    expect(db.sourceCounts()[0]!.count).toBe(1);
  });

  it('parse errors count as failed; listFiles errors do not break other sources', async () => {
    const file = tmpPath('s3.jsonl');
    fs.writeFileSync(file, '{"a":1}\n');
    const db = newDb();

    const throwing: LocalSourceAdapter = {
      source: 'codex',
      listFiles: () => [{ path: file, size: 1, mtimeMs: 1 }],
      parseFile: async () => {
        throw new Error('boom');
      },
      watchRoots: () => [],
      acceptsPath: () => false,
    };
    let stats = await syncLocalSources(db, [throwing]);
    expect(stats[0]!.failed).toBe(1);

    const brokenScan: LocalSourceAdapter = {
      source: 'gemini-cli',
      listFiles: () => {
        throw new Error('dir gone');
      },
      parseFile: async () => null,
      watchRoots: () => [],
      acceptsPath: () => false,
    };
    stats = await syncLocalSources(db, [brokenScan, new FakeAdapter(file)]);
    expect(stats[0]!.files).toBe(0);
    expect(stats[1]!.parsed).toBe(1);
  });
});

describe('json-utils', () => {
  it('iterJsonArray: braces and escaped quotes inside strings', () => {
    const text = '[{"a":"contains } brace","b":"escaped \\"quote{","c":{"nested":1}}, {"d":2}, {"e":"[{[junk}stuff"}]';
    const items = [...iterJsonArray(text)];
    expect(items).toHaveLength(3);
    expect(items[0]!['c']).toEqual({ nested: 1 });
    expect(items[2]!['e']).toBe('[{[junk}stuff');
  });

  it('iterJsonArray: error cases', () => {
    expect(() => [...iterJsonArray('{"not":"array"}')]).toThrow();
    expect(() => [...iterJsonArray('[{"a":1')]).toThrow();
  });

  it('toIso: seconds/millis/numeric strings/ISO/garbage', () => {
    expect(toIso(1710000000)).toBe('2024-03-09T16:00:00.000Z');
    expect(toIso(1710000000000)).toBe('2024-03-09T16:00:00.000Z');
    expect(toIso('1710000000')).toBe('2024-03-09T16:00:00.000Z');
    expect(toIso('2026-09-01T00:00:00Z')).toBe('2026-09-01T00:00:00.000Z');
    expect(toIso('garbage')).toBeUndefined();
    expect(toIso(42)).toBeUndefined();
    expect(toIso(null)).toBeUndefined();
  });

  it('stableId determinism', () => {
    expect(stableId('a', 'b')).toBe(stableId('a', 'b'));
    expect(stableId('a', 'b')).not.toBe(stableId('a', 'c'));
  });
});

describe('detect.classifyJson', () => {
  it('ChatGPT signatures', () => {
    expect(classifyJson('[{"mapping":{},"conversation_id":"x"}]').kind).toBe('chatgpt-json');
    expect(classifyJson('[]', '/tmp/conversations.json').kind).toBe('chatgpt-json');
  });
  it('Gemini path hint wins', () => {
    expect(classifyJson('{"conversations":[]}', 'My Activity/Gemini Apps/MyActivity.json').kind).toBe('gemini-takeout-json');
  });
  it('field scoring: sender+message -> grok, chat_id -> kimi', () => {
    expect(classifyJson('{"conversations":[{"messages":[{"sender":"human","message":"hi"}]}]}')).toEqual({
      kind: 'role-chat-json',
      roleSource: 'grok',
    });
    expect(classifyJson('{"chats":[{"chat_id":"k1","messages":[{"role":"user","content":"q"}]}]}')).toEqual({
      kind: 'role-chat-json',
      roleSource: 'kimi',
    });
  });
});

describe('Markdown export', () => {
  it('frontmatter + turns + collapsed tool calls + same-name skip', () => {
    const db = newDb();
    db.upsertSession({
      nativeId: 'exp-1',
      source: 'claude-code',
      title: 'build/optimize: test',
      project: '/x/proj',
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T10:05:00.000Z',
      messages: [
        { role: 'user', content: 'optimize the build', createdAt: '2026-09-01T10:00:00.000Z' },
        {
          role: 'assistant',
          content: 'two steps to optimize.',
          toolCalls: [
            { name: 'Bash', brief: 'pnpm build' },
            { name: 'Edit', brief: '/x/vite.config.ts' },
          ],
          createdAt: '2026-09-01T10:05:00.000Z',
        },
      ],
    });

    const out = tmpPath('out');
    const r1 = exportMarkdown(db, { out });
    expect(r1.exported).toBe(1);
    const file = fs.readdirSync(out).find((f) => f.endsWith('.md'))!;
    expect(file).toMatch(/^2026-09-01-build-optimize-test\.md$/);

    const text = fs.readFileSync(path.join(out, file), 'utf8');
    expect(text).toContain('source: claude-code');
    expect(text).toContain('title: "build/optimize: test"');
    expect(text).toContain('project: /x/proj');
    expect(text).toContain('## 我 · 2026-09-01 10:00');
    expect(text).toContain('## 助手 · 2026-09-01 10:05');
    expect(text).toContain('2 次工具调用');
    expect(text).toContain('`Bash` — pnpm build');

    // export again: same-name file skipped
    const r2 = exportMarkdown(db, { out });
    expect(r2.exported).toBe(0);
    expect(r2.skipped).toBe(1);
  });
});
