import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShiYiDb } from '../src/core/db.js';
import { importFile, processInbox } from '../src/core/import.js';
import { startWatcher } from '../src/core/watcher.js';
import type { CommonSession, LocalSourceAdapter, LocalSourceFile } from '../src/core/types.js';

const cleanup: string[] = [];
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `shiyi-watch-${tag}-`));
  cleanup.push(d);
  return d;
}
function newDb(): ShiYiDb {
  const p = path.join(tmpDir('db'), 't.db');
  const db = new ShiYiDb(p);
  cleanup.push(`${p}-wal`, `${p}-shm`);
  return db;
}

/** real adapter watching a temp dir */
class TmpAdapter implements LocalSourceAdapter {
  source = 'claude-code' as const;
  constructor(readonly dir: string) {}
  listFiles(): LocalSourceFile[] {
    return [];
  }
  async parseFile(p: string): Promise<CommonSession | null> {
    const content = fs.readFileSync(p, 'utf8');
    return {
      nativeId: path.basename(p, '.jsonl'),
      source: this.source,
      title: content.slice(0, 20),
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: 'ok: ' + content },
      ],
    };
  }
  watchRoots(): string[] {
    return [this.dir];
  }
  acceptsPath(p: string): boolean {
    return p.startsWith(this.dir) && p.endsWith('.jsonl');
  }
}

describe('watcher', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('auto-imports a newly created session file', async () => {
    const db = newDb();
    const dir = tmpDir('watch');
    const adapter = new TmpAdapter(dir);
    const watcher = startWatcher(db, [adapter]);
    await watcher.ready;

    fs.writeFileSync(path.join(dir, 'abc123.jsonl'), 'watcher integration test message');
    // awaitWriteFinish 2s settle + FSEvents may lag under parallel workers, poll up to 20s
    const deadline = Date.now() + 20000;
    let row: unknown;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      row = db.getSession('claude-code:abc123');
      if (row) break;
    }
    await watcher.stop();

    expect(row).toBeTruthy();
    const messages = db.getMessages('claude-code:abc123');
    expect(messages.map((m) => m.content)).toEqual([
      'watcher integration test message',
      'ok: watcher integration test message',
    ]);
    expect(watcher.recent[0]).toMatchObject({ source: 'claude-code', action: 'upserted' });
  }, 25000);
});

describe('inbox auto-processing', () => {
  const prevInbox = process.env.SHIYI_INBOX;
  afterEach(() => {
    if (prevInbox === undefined) delete process.env.SHIYI_INBOX;
    else process.env.SHIYI_INBOX = prevInbox;
  });

  it('recognized files move to imported/, unknown ones stay and report an error', async () => {
    const inbox = tmpDir('inbox');
    process.env.SHIYI_INBOX = inbox;
    const db = newDb();

    // 1) a recognizable grok markdown
    fs.writeFileSync(
      path.join(inbox, 'grok-note.md'),
      '# Grok excerpt\n## User\nwhat is trigram tokenization\n## Grok\na sliding 3-character window scheme…\n'
    );
    // 2) an unrecognizable file
    fs.writeFileSync(path.join(inbox, 'garbage.bin'), '\x00\x01not a export');

    const outcomes = await processInbox(db);
    expect(outcomes).toHaveLength(2);

    const ok = outcomes.find((o) => !o.error)!;
    expect(ok.source).toBe('grok');
    expect(ok.sessions).toBe(1);
    const bad = outcomes.find((o) => o.error)!;
    expect(bad.error).toBeTruthy();

    // success moved away, failure left in place
    expect(fs.existsSync(path.join(inbox, 'grok-note.md'))).toBe(false);
    expect(fs.readdirSync(path.join(inbox, 'imported')).length).toBe(1);
    expect(fs.existsSync(path.join(inbox, 'garbage.bin'))).toBe(true);

    // run again: garbage is retried and fails again (idempotent, never reports false success)
    const again = await processInbox(db);
    expect(again).toHaveLength(1);
    expect(again[0]!.error).toBeTruthy();
  });

  it('importFile accepts a bare Markdown file', async () => {
    const db = newDb();
    const f = path.join(tmpDir('md'), 'paste.md');
    fs.writeFileSync(f, '# Pasted note\nplain text without role markers.');
    const r = await importFile(db, f);
    expect(r.error).toBeUndefined();
    expect(r.source).toBe('grok');
    expect(r.sessions).toBe(1);
  });
});
