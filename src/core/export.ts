import fs from 'node:fs';
import path from 'node:path';
import { ShiYiDb, type SessionRow } from './db.js';
import { SOURCE_LABELS, type SourceId } from './types.js';

export interface ExportOptions {
  out: string;
  source?: SourceId;
  /** overwrite existing files (default skips) */
  overwrite?: boolean;
}

function slugify(title: string): string {
  return (
    title
      .replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

function sessionMarkdown(row: SessionRow, body: string): string {
  const fm = [
    '---',
    `source: ${row.source}`,
    `title: ${JSON.stringify(row.title)}`,
    row.project ? `project: ${row.project}` : null,
    row.started_at ? `started_at: ${row.started_at}` : null,
    row.ended_at ? `ended_at: ${row.ended_at}` : null,
    `messages: ${row.message_count}`,
    `tags: ${row.tags ? JSON.stringify(JSON.parse(row.tags)) : '[]'}`,
    `shiyi_id: ${row.id}`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');
  return `${fm}\n\n# ${row.title}\n\n${body.trim()}\n`;
}

function renderBody(
  messages: Array<{ role: string; content: string; thinking?: string | null; tool_calls_json: string | null; created_at: string | null }>
): string {
  const parts: string[] = [];
  for (const m of messages) {
    const ts = m.created_at ? ` · ${m.created_at.slice(0, 16).replace('T', ' ')}` : '';
    parts.push(`## ${m.role === 'user' ? 'Me' : 'Assistant'}${ts}\n\n${m.content}\n`);
    if (m.thinking) {
      parts.push(`<details><summary>Thinking</summary>\n\n${m.thinking}\n\n</details>\n`);
    }
    if (m.tool_calls_json) {
      const calls = JSON.parse(m.tool_calls_json) as Array<{ name: string; brief: string }>;
      if (calls.length) {
        parts.push(
          `<details><summary>${calls.length} tool calls</summary>\n\n${calls
            .map((c) => `- \`${c.name}\`${c.brief ? ` — ${c.brief}` : ''}`)
            .join('\n')}\n\n</details>\n`
        );
      }
    }
  }
  return parts.join('\n');
}

/** Export all (or one source's) sessions as Markdown files; returns exported/skipped counts */
export function exportMarkdown(db: ShiYiDb, opts: ExportOptions): { exported: number; skipped: number; dir: string } {
  const { total } = db.listSessions({ source: opts.source, limit: 1 });
  const step = 200;
  let exported = 0;
  let skipped = 0;
  fs.mkdirSync(opts.out, { recursive: true });

  for (let offset = 0; offset < total; offset += step) {
    const { items } = db.listSessions({ source: opts.source, limit: step, offset });
    for (const row of items) {
      const date = (row.started_at ?? row.created_at ?? '').slice(0, 10) || 'unknown';
      let name = `${date}-${slugify(row.title)}.md`;
      let p = path.join(opts.out, name);
      if (fs.existsSync(p) && !opts.overwrite) {
        // likely a re-export: same name is skipped, differing content gets a numeric suffix
        skipped++;
        continue;
      }
      if (fs.existsSync(p)) {
        let i = 2;
        while (fs.existsSync(p)) p = path.join(opts.out, `${date}-${slugify(row.title)}-${i++}.md`);
      }
      const messages = db.getMessages(row.id);
      fs.writeFileSync(p, sessionMarkdown(row, renderBody(messages)), 'utf8');
      exported++;
    }
  }
  return { exported, skipped, dir: opts.out };
}

export function sourceLabel(source: SourceId): string {
  return SOURCE_LABELS[source] ?? source;
}
