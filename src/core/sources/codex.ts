import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { codexArchiveDir, localSourceRoots } from '../paths.js';
import { cleanInlineMarkup } from './json-utils.js';
import { truncate, type CommonMessage, type CommonSession, type LocalSourceAdapter, type LocalSourceFile, type ToolCallBrief } from '../types.js';

// rollout lines over 2MB are almost always base64 images/huge outputs; skip them
const MAX_LINE_BYTES = 2 * 1024 * 1024;

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    timestamp?: string;
    cwd?: string;
    type?: string;
    role?: string;
    message?: string;
    content?: Array<{ type?: string; text?: string }>;
    name?: string;
    arguments?: string;
  };
}

function walkJsonl(dir: string, depth = 0, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 5) walkJsonl(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function functionCallBrief(name: string, args: unknown): ToolCallBrief {
  let brief = '';
  if (typeof args === 'string' && args) {
    try {
      const o = JSON.parse(args) as Record<string, unknown>;
      const cmd = o['cmd'] ?? o['command'];
      if (typeof cmd === 'string' && cmd) brief = truncate(cmd, 80);
      else if (Array.isArray(cmd)) brief = truncate(cmd.filter((x) => typeof x === 'string').join(' '), 80);
      else {
        for (const key of ['file_path', 'path', 'pattern', 'query', 'url']) {
          const v = o[key];
          if (typeof v === 'string' && v) {
            brief = truncate(v, 80);
            break;
          }
        }
      }
    } catch {
      brief = truncate(String(args), 60);
    }
  }
  return { name, brief };
}

/** injected content mixed into response_item role=user (AGENTS.md, environment context, IDE state, internal context, …) */
const USER_MSG_NOISE = [
  /^#\s*AGENTS\.md instructions/,
  /^<permissions instructions>/,
  /^<environment_context>/i,
  /^<user_instructions>/,
  /^<turn_context>/,
  /^# Instructions for /,
  /^<codex_internal_context/,
  /^<ide_opened_file>/,
  /^# Context from my IDE setup/,
  /^<ide_selection>/,
];

/** messages starting with an image placeholder make poor titles */
const TITLE_NOISE = [/^<image\b/];

function isInjectedUserText(text: string): boolean {
  return USER_MSG_NOISE.some((re) => re.test(text));
}

/** Codex CLI local sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+ archived_sessions/) */
export class CodexAdapter implements LocalSourceAdapter {
  readonly source = 'codex' as const;

  watchRoots(): string[] {
    return [localSourceRoots().codex, codexArchiveDir()];
  }

  acceptsPath(p: string): boolean {
    return p.startsWith(localSourceRoots().codex) || p.startsWith(codexArchiveDir());
  }

  listFiles(): LocalSourceFile[] {
    const files = [
      ...walkJsonl(localSourceRoots().codex),
      ...walkJsonl(codexArchiveDir()),
    ];
    return files.map((p) => {
      const st = fs.statSync(p);
      return { path: p, size: st.size, mtimeMs: st.mtimeMs };
    });
  }

  async parseFile(filePath: string): Promise<CommonSession | null> {
    // filenames look like rollout-2026-05-27T19-46-39-<uuid>.jsonl; the uuid becomes nativeId (unanchored to tolerate renames/archived copies)
    const base = path.basename(filePath, '.jsonl');
    const m = base.match(/rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(.+)$/);
    const nativeId = m?.[1] || base;

    let cwd: string | undefined;
    const messages: CommonMessage[] = [];
    let pendingToolCalls: ToolCallBrief[] = [];
    // user turns come from two places: event_msg.user_message (newer) or response_item role=user (older/VSCode entry).
    // The former duplicates the latter when present, so pick one per file
    const userMsgEvents: CommonMessage[] = [];
    const userMsgItems: CommonMessage[] = [];
    let sawUserMsgEvent = false;

    const attachTools = () => {
      if (!pendingToolCalls.length) return;
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        last.toolCalls = [...(last.toolCalls ?? []), ...pendingToolCalls];
        pendingToolCalls = [];
      }
      // keep pending when no assistant message exists yet; attach to the nearest later one
    };

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.length > MAX_LINE_BYTES) continue;
      let o: CodexLine;
      try {
        o = JSON.parse(line) as CodexLine;
      } catch {
        continue;
      }
      const p = o.payload;
      if (!p) continue;

      if (o.type === 'session_meta') {
        cwd ??= p.cwd;
        continue;
      }

      // human input, two shapes (pick one per file; filter injections; clean inline cite/entity markup)
      if (o.type === 'event_msg' && p.type === 'user_message') {
        const text = cleanInlineMarkup(p.message ?? '').trim();
        if (!text || isInjectedUserText(text)) continue;
        sawUserMsgEvent = true;
        userMsgEvents.push({ role: 'user', content: text, createdAt: o.timestamp });
        continue;
      }

      if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = (p.content ?? [])
          .filter((c) => c?.type === 'input_text')
          .map((c) => c.text ?? '')
          .join('\n')
          .trim();
        if (!text || isInjectedUserText(text)) continue;
        userMsgItems.push({ role: 'user', content: text, createdAt: o.timestamp });
        continue;
      }

      if (o.type === 'response_item') {
        if (p.type === 'message' && p.role === 'assistant') {
          const text = cleanInlineMarkup(
            (p.content ?? [])
              .filter((c) => c?.type === 'output_text')
              .map((c) => c.text ?? '')
              .join('\n')
          ).trim();
          if (!text) continue;
          attachTools();
          messages.push({ role: 'assistant', content: text, createdAt: o.timestamp });
          attachTools();
        } else if (p.type === 'function_call' || p.type === 'web_search_call' || p.type === 'local_shell_call') {
          const name = p.name ?? p.type ?? 'tool';
          pendingToolCalls.push(functionCallBrief(name, p.arguments));
        }
        // reasoning / function_call_output / developer messages are never imported
      }
    }
    attachTools();

    const userMsgs = sawUserMsgEvent && userMsgEvents.length ? userMsgEvents : userMsgItems;
    const all = [...messages, ...userMsgs].sort((a, b) => {
      if (a.createdAt && b.createdAt) return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      return 0;
    });
    if (!all.length) return null;

    const titleSource =
      all.find((m) => m.role === 'user' && !TITLE_NOISE.some((re) => re.test(m.content)))?.content ??
      all.find((m) => m.role === 'user')?.content ??
      '';
    const startedAt = all[0]?.createdAt;
    const endedAt = all[all.length - 1]?.createdAt;

    return {
      nativeId,
      source: this.source,
      title: truncate(titleSource, 60) || truncate(all.find((m) => m.role === 'assistant')?.content ?? '', 60) || '（无标题）',
      project: cwd,
      startedAt,
      endedAt,
      messages: all,
    };
  }
}
