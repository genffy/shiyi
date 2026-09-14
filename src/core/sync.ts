import { ShiYiDb } from './db.js';
import type { LocalSourceAdapter } from './types.js';

export interface SourceSyncStats {
  source: string;
  files: number;
  parsed: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/** Incremental sync: compare size/mtime recorded at last import and skip unchanged files; full=true wipes local sources and rebuilds. */
export async function syncLocalSources(
  db: ShiYiDb,
  adapters: LocalSourceAdapter[],
  opts: { full?: boolean } = {}
): Promise<SourceSyncStats[]> {
  if (opts.full) {
    db.db.prepare("DELETE FROM sessions WHERE raw_path IS NOT NULL").run();
  }
  const all: SourceSyncStats[] = [];
  for (const adapter of adapters) {
    const started = performance.now();
    const stats: SourceSyncStats = { source: adapter.source, files: 0, parsed: 0, skipped: 0, failed: 0, durationMs: 0 };
    let files;
    try {
      files = adapter.listFiles();
    } catch (e) {
      console.warn(`[${adapter.source}] failed to scan directory: ${(e as Error).message}`);
      stats.durationMs = performance.now() - started;
      all.push(stats);
      continue;
    }
    stats.files = files.length;
    for (const f of files) {
      const known = db.getRawFileInfo(adapter.source, f.path);
      if (known && known.raw_size === f.size && known.raw_mtime === f.mtimeMs) {
        stats.skipped++;
        continue;
      }
      try {
        const session = await adapter.parseFile(f.path);
        if (session && session.messages.length > 0) {
          db.upsertSession(session, { path: f.path, size: f.size, mtimeMs: f.mtimeMs });
          stats.parsed++;
        } else {
          stats.skipped++;
        }
      } catch (e) {
        stats.failed++;
        console.warn(`[${adapter.source}] parse failed ${f.path}: ${(e as Error).message}`);
      }
    }
    stats.durationMs = performance.now() - started;
    all.push(stats);
  }
  return all;
}
