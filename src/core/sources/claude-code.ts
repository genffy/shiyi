import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { localSourceRoots } from '../paths.js';
import {
  truncate,
  type CommonMessage,
  type CommonSession,
  type LocalSourceAdapter,
  type LocalSourceFile,
  type ToolCallBrief,
} from '../types.js';

const MAX_LINE_BYTES = 5 * 1024 * 1024;

interface ClaudeLine {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  origin?: { kind?: string };
  aiTitle?: string;
  sessionId?: string;
}

function briefFromInput(name: string, input: unknown): ToolCallBrief {
  let brief = '';
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'skill']) {
      const v = o[key];
      if (typeof v === 'string' && v) {
        brief = v.split('\n')[0]!;
        break;
      }
    }
    if (!brief) brief = truncate(JSON.stringify(input), 60);
  }
  return { name, brief };
}

function extractText(content: unknown): { text: string; toolCalls: ToolCallBrief[] } {
  if (typeof content === 'string') return { text: content, toolCalls: [] };
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const texts: string[] = [];
  const toolCalls: ToolCallBrief[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') texts.push(b['text']);
    else if (b['type'] === 'tool_use') toolCalls.push(briefFromInput(String(b['name'] ?? ''), b['input']));
  }
  return { text: texts.join('\n'), toolCalls };
}

/** Claude Code local sessions: ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl */
export class ClaudeCodeAdapter implements LocalSourceAdapter {
  readonly source = 'claude-code' as const;

  watchRoots(): string[] {
    return [localSourceRoots().claude];
  }

  acceptsPath(p: string): boolean {
    return p.startsWith(localSourceRoots().claude) && p.endsWith('.jsonl');
  }

  listFiles(): LocalSourceFile[] {
    const root = localSourceRoots().claude;
    const files: LocalSourceFile[] = [];
    let projectDirs: string[] = [];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => path.join(root, d.name));
    } catch {
      return files;
    }
    for (const dir of projectDirs) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const p = path.join(dir, entry.name);
        const st = fs.statSync(p);
        files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return files;
  }

  async parseFile(filePath: string): Promise<CommonSession | null> {
    const nativeId = path.basename(filePath, '.jsonl');
    let projectDir: string | undefined;

    let aiTitle = '';
    const messages: CommonMessage[] = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let pendingAssistantToolCalls: ToolCallBrief[] = [];

    const flushAssistantTools = () => {
      if (pendingAssistantToolCalls.length && messages.length) {
        const last = messages[messages.length - 1]!;
        if (last.role === 'assistant') {
          last.toolCalls = [...(last.toolCalls ?? []), ...pendingAssistantToolCalls];
        }
        pendingAssistantToolCalls = [];
      }
    };

    for await (const line of rl) {
      if (line.length > MAX_LINE_BYTES) continue;
      let o: ClaudeLine;
      try {
        o = JSON.parse(line) as ClaudeLine;
      } catch {
        continue;
      }

      if (o.cwd && !projectDir) projectDir = o.cwd;
      if (o.type === 'ai-title' && o.aiTitle) {
        aiTitle = o.aiTitle;
        continue;
      }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.isSidechain) continue;

      const content = o.message?.content;
      if (o.type === 'user') {
        const originKind = o.origin?.kind;
        // human input: plain-string content, or explicit origin.kind=human;
        // tool results arrive as block arrays without origin and are naturally excluded
        const isHuman =
          (typeof content === 'string' && (originKind === 'human' || originKind === undefined)) ||
          (originKind === 'human' && Array.isArray(content));
        if (!isHuman) continue;
        const text = Array.isArray(content)
          ? content
              .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'text')
              .map((b) => String((b as Record<string, unknown>)['text'] ?? ''))
              .join('\n')
          : String(content ?? '');
        const trimmed = text.trim();
        // CLI internal command wrappers and pasted background noise
        if (!trimmed || trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command') || trimmed.startsWith('Caveat:')) continue;
        flushAssistantTools();
        messages.push({ role: 'user', content: trimmed, createdAt: o.timestamp });
      } else {
        const { text, toolCalls } = extractText(content);
        if (!text && !toolCalls.length) continue;
        const last = messages[messages.length - 1];
        if (text) {
          flushAssistantTools();
          messages.push({ role: 'assistant', content: text, createdAt: o.timestamp });
          if (toolCalls.length) messages[messages.length - 1]!.toolCalls = toolCalls;
          continue;
        }
        // bare tool-call turns: merge into the adjacent assistant text message, or hold if none yet
        if (last?.role === 'assistant') {
          last.toolCalls = [...(last.toolCalls ?? []), ...toolCalls];
        } else {
          pendingAssistantToolCalls.push(...toolCalls);
        }
        continue;
      }
    }
    flushAssistantTools();

    const firstTs = messages.find((m) => m.createdAt)?.createdAt;
    const lastTs = [...messages].reverse().find((m) => m.createdAt)?.createdAt;
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';

    return {
      nativeId,
      source: this.source,
      title: aiTitle || truncate(firstUser, 60) || '(untitled)',
      project: projectDir ?? unmngeProjectDir(path.basename(path.dirname(filePath))),
      startedAt: firstTs,
      endedAt: lastTs,
      messages,
    };
  }
}

/** '-Users-name-workspace-foo' -> '/Users/name/workspace/foo' (fallback when cwd is missing) */
function unmngeProjectDir(name: string): string {
  return '/' + name.replace(/^-+/, '').replace(/-/g, '/');
}
