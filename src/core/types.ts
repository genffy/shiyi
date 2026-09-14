/** all supported session sources */
export type SourceId =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'chatgpt'
  | 'gemini-web'
  | 'kimi'
  | 'grok';

export const SOURCE_LABELS: Record<SourceId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  chatgpt: 'ChatGPT',
  'gemini-web': 'Gemini',
  kimi: 'Kimi',
  grok: 'Grok',
};

export interface ToolCallBrief {
  /** tool name, e.g. Edit / Bash / WebSearch */
  name: string;
  /** one-line brief, e.g. a file path or command */
  brief: string;
}

export interface CommonMessage {
  role: 'user' | 'assistant';
  /** extracted text (markdown source, rendered by the frontend) */
  content: string;
  /** model reasoning (Kimi think / Grok thinking_trace), collapsed by default in the UI */
  thinking?: string;
  /** ISO 8601, may be missing */
  createdAt?: string;
  /** tool-call briefs for this turn (usually attached to assistant messages) */
  toolCalls?: ToolCallBrief[];
}

export interface CommonSession {
  /** native id within the source (e.g. session uuid) */
  nativeId: string;
  source: SourceId;
  title: string;
  /** project name derived from the working dir (CLI sessions); empty for cloud sessions */
  project?: string;
  startedAt?: string;
  endedAt?: string;
  messages: CommonMessage[];
}

/** adapter for file-based local sources (Claude Code / Codex / Gemini CLI) */
export interface LocalSourceFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface LocalSourceAdapter {
  source: SourceId;
  listFiles(): LocalSourceFile[];
  /** parse one session file; null when unparseable */
  parseFile(path: string): Promise<CommonSession | null>;
  /** roots the watcher observes (must cover every path listFiles yields; keep unrelated dirs out) */
  watchRoots(): string[];
  /** whether a path belongs to this source (watcher callback) */
  acceptsPath(path: string): boolean;
}

export function sessionKey(source: SourceId, nativeId: string): string {
  return `${source}:${nativeId}`;
}

export function truncate(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}
