#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { ShiYiDb } from '../core/db.js';
import { dbPath, inboxDir } from '../core/paths.js';
import { syncLocalSources } from '../core/sync.js';
import { ClaudeCodeAdapter } from '../core/sources/claude-code.js';
import { CodexAdapter } from '../core/sources/codex.js';
import { GeminiCliAdapter } from '../core/sources/gemini-cli.js';
import { ZcodeAdapter } from '../core/sources/zcode.js';
import { SOURCE_LABELS, type LocalSourceAdapter, type SourceId } from '../core/types.js';

const program = new Command();

program.name('shiyi').description('shiyi（拾遗）— unify AI chat sessions into a personal knowledge base').version('0.1.0');

function localAdapters(): LocalSourceAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiCliAdapter(), new ZcodeAdapter()];
}

program
  .command('sync')
  .description('incrementally sync local session sources (Claude Code / Codex / Gemini CLI / ZCode) and process cloud exports in inbox/')
  .option('--full', 'ignore incremental state, wipe local sources and reparse everything (use after parser-rule upgrades)')
  .action(async (opts: { full?: boolean }) => {
    const db = new ShiYiDb();
    try {
      const stats = await syncLocalSources(db, localAdapters(), { full: opts.full });
      for (const s of stats) {
        const label = SOURCE_LABELS[s.source as SourceId] ?? s.source;
        console.log(
          `${label.padEnd(12)} ${String(s.files).padStart(4)} files  parsed ${s.parsed}  skipped ${s.skipped}` +
            (s.failed ? `  failed ${s.failed}` : '') +
            `  (${(s.durationMs / 1000).toFixed(1)}s)`
        );
      }
      const { processInbox } = await import('../core/import.js');
      const outcomes = await processInbox(db);
      for (const o of outcomes) {
        if (o.error) console.log(`inbox        ${path.basename(o.file)}: ${o.error}`);
        else console.log(`inbox        ${path.basename(o.file)} → ${SOURCE_LABELS[o.source!] ?? o.source} imported ${o.sessions} session(s)`);
      }
    } finally {
      db.close();
    }
  });

program
  .command('import')
  .description('import cloud export files (ChatGPT zip / Gemini Takeout zip / Kimi / Grok md·json) or share links')
  .argument('<file...>', 'export file or URL paths')
  .option('-s, --source <source>', 'force the source (kimi/grok), skipping auto-detection')
  .action(async (files: string[], opts: { source?: string }) => {
    const force = opts.source as SourceId | undefined;
    if (force && !SOURCE_LABELS[force as SourceId]) {
      console.error(`--source must be one of: ${Object.keys(SOURCE_LABELS).join(' / ')}`);
      process.exitCode = 1;
      return;
    }
    const { importFile } = await import('../core/import.js');
    const db = new ShiYiDb();
    try {
      for (const f of files) {
        const r = await importFile(db, f, force);
        if (r.error) {
          console.error(`${f}: ${r.error}`);
          process.exitCode = 1;
        } else {
          console.log(`${f} → ${SOURCE_LABELS[r.source!] ?? r.source} imported ${r.sessions} session(s)`);
        }
      }
    } finally {
      db.close();
    }
  });

program
  .command('serve')
  .description('start the local web server (with file-watching auto-sync)')
  .option('-p, --port <number>', 'port', '7420')
  .option('--no-watch', 'disable file watching')
  .action(async (opts: { port: string; watch: boolean }) => {
    const { buildApp } = await import('../api/server.js');
    const { startWatcher } = await import('../core/watcher.js');
    const db = new ShiYiDb();
    const adapters = localAdapters();
    let watcher: Awaited<ReturnType<typeof startWatcher>> | null = null;
    if (opts.watch) {
      watcher = startWatcher(db, adapters);
      console.log('file watching enabled: claude/codex/gemini-cli/zcode session changes are imported automatically');
    }
    const app = await buildApp({
      db,
      adapters,
      watchInfo: () => ({ watching: !!watcher, recent_sync: watcher?.recent.slice(0, 10) ?? [] }),
    });
    const port = Number(opts.port);
    await app.listen({ port, host: '127.0.0.1' });
    console.log(`shiyi（拾遗）running at http://127.0.0.1:${port}  (database ${dbPath()})`);
  });

program
  .command('export')
  .description('export sessions as Markdown files (drop-in for Obsidian)')
  .requiredOption('-o, --out <dir>', 'output directory')
  .option('-s, --source <source>', 'only export the given source')
  .option('--overwrite', 'overwrite existing files (default skips same-name files)')
  .action(async (opts: { out: string; source?: string; overwrite?: boolean }) => {
    const { exportMarkdown } = await import('../core/export.js');
    const source = opts.source as SourceId | undefined;
    const db = new ShiYiDb();
    try {
      const r = exportMarkdown(db, { out: opts.out, source, overwrite: opts.overwrite });
      console.log(`exported ${r.exported} session(s) to ${r.dir}${r.skipped ? ` (skipped ${r.skipped} existing)` : ''}`);
    } finally {
      db.close();
    }
  });

program
  .command('status')
  .description('show session counts per source in the current database')
  .action(() => {
    const db = new ShiYiDb();
    try {
      const counts = db.sourceCounts();
      if (!counts.length) {
        console.log(`database is empty (${dbPath()}), run shiyi sync first`);
        return;
      }
      for (const { source, count } of counts) {
        console.log(`${(SOURCE_LABELS[source] ?? source).padEnd(12)} ${count} session(s)`);
      }
      console.log(`\ndatabase: ${dbPath()}`);
      console.log(`inbox:   ${inboxDir()}`);
    } finally {
      db.close();
    }
  });

program.parseAsync();
