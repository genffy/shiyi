import chokidar from 'chokidar';
import fs from 'node:fs';
import { ShiYiDb } from './db.js';
import { syncLocalSources } from './sync.js';
import type { LocalSourceAdapter, LocalSourceFile } from './types.js';

export interface WatchEvent {
  source: string;
  path: string;
  action: 'upserted' | 'skipped';
}

/**
 * Watch local session directories; reparse incrementally 2s after a file settles.
 * Returns { stop, recent, onEvent }; recent feeds the recent-sync display of /api/stats.
 */
export function startWatcher(db: ShiYiDb, adapters: LocalSourceAdapter[]) {
  const dirs = [...new Set(adapters.filter((a) => !a.watchFiles).flatMap((a) => a.watchRoots()))];
  const recent: WatchEvent[] = [];
  const listeners = new Set<(e: WatchEvent) => void>();
  const aggregateRuns = new Map<LocalSourceAdapter, { running: boolean; pending: boolean }>();

  const findAdapter = (p: string) => adapters.find((a) => a.acceptsPath(p));

  const process = async (filePath: string) => {
    const adapter = findAdapter(filePath);
    if (!adapter) return;
    if (adapter.syncOnChange) {
      const state = aggregateRuns.get(adapter) ?? { running: false, pending: false };
      aggregateRuns.set(adapter, state);
      state.pending = true;
      if (state.running) return;
      state.running = true;
      try {
        while (state.pending) {
          state.pending = false;
          const [result] = await syncLocalSources(db, [adapter]);
          if (result?.parsed) push({ source: adapter.source, path: filePath, action: 'upserted' });
        }
      } finally {
        state.running = false;
      }
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return; // temp file or already deleted
    }
    const file: LocalSourceFile = { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
    const known = db.getRawFileInfo(adapter.source, filePath);
    if (known && known.raw_size === st.size && known.raw_mtime === st.mtimeMs) {
      push({ source: adapter.source, path: filePath, action: 'skipped' });
      return;
    }
    try {
      const session = await adapter.parseFile(filePath);
      if (session && session.messages.length > 0) {
        db.upsertSession(session, file);
        push({ source: adapter.source, path: filePath, action: 'upserted' });
      }
    } catch (e) {
      console.warn(`[watch] parse failed ${filePath}: ${(e as Error).message}`);
    }
  };

  const push = (e: WatchEvent) => {
    recent.unshift(e);
    recent.length = Math.min(recent.length, 50);
    for (const fn of listeners) fn(e);
  };

  const watcher = chokidar.watch(dirs, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    depth: 8,
    ignored: (p: string) => /(^|\/)\.(git|DS_Store)/.test(p) || p.endsWith('.sock'),
  });

  const ready = dirs.length ? new Promise<void>((resolve) => {
    watcher.on('ready', () => resolve());
  }) : Promise.resolve();

  watcher.on('add', process).on('change', process).on('error', (err: unknown) => {
    console.warn(`[watch] ${(err as Error).message}`);
  });

  const polledFiles = adapters.flatMap((a) => a.watchFiles?.() ?? []);
  for (const file of polledFiles) {
    fs.watchFile(file, { interval: 1000 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) void process(file);
    });
  }

  return {
    ready,
    recent,
    onEvent(fn: (e: WatchEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async stop() {
      for (const file of polledFiles) fs.unwatchFile(file);
      await watcher.close();
    },
  };
}
