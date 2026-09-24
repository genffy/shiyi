export type SourceId = 'claude-code' | 'codex' | 'gemini-cli' | 'zcode' | 'chatgpt' | 'gemini-web' | 'kimi' | 'grok';

export const SOURCE_LABELS: Record<SourceId, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  zcode: 'ZCode',
  chatgpt: 'ChatGPT',
  'gemini-web': 'Gemini',
  kimi: 'Kimi',
  grok: 'Grok',
};

export const SOURCE_COLORS: Record<SourceId, string> = {
  'claude-code': '#c96442',
  codex: '#7c5cfc',
  'gemini-cli': '#4285f4',
  zcode: '#15836a',
  chatgpt: '#10a37f',
  'gemini-web': '#4285f4',
  kimi: '#e0413f',
  grok: '#3f3f46',
};

export interface ToolCall {
  name: string;
  brief: string;
}

export interface SessionSummary {
  id: string;
  source: SourceId;
  title: string;
  project: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  snippet: string | null;
}

export interface SessionDetail {
  session: SessionSummary & { summary: string | null; tags: string | null; created_at: string; updated_at: string };
  messages: Array<{
    seq: number;
    role: 'user' | 'assistant';
    content: string;
    thinking: string | null;
    tool_calls: ToolCall[];
    created_at: string | null;
  }>;
}

export interface Stats {
  total: number;
  sources: Array<{ source: SourceId; count: number; label: string }>;
  watching?: boolean;
}

export interface SourceAnalytics {
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  activeDays: number;
  projects: Array<{ project: string; count: number }>;
  activity: Array<{ day: string; count: number }>;
}

export async function fetchAnalytics(source: SourceId): Promise<SourceAnalytics> {
  const r = await fetch(`/api/analytics?source=${encodeURIComponent(source)}`);
  if (!r.ok) throw new Error(`analytics ${r.status}`);
  return r.json();
}

export async function fetchStats(): Promise<Stats> {
  const r = await fetch('/api/stats');
  if (!r.ok) throw new Error(`stats ${r.status}`);
  return r.json();
}

export async function fetchSessions(params: {
  source?: SourceId | null;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; items: SessionSummary[] }> {
  const sp = new URLSearchParams();
  if (params.source) sp.set('source', params.source);
  if (params.q) sp.set('q', params.q);
  sp.set('limit', String(params.limit ?? 50));
  sp.set('offset', String(params.offset ?? 0));
  const r = await fetch(`/api/sessions?${sp}`);
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  return r.json();
}

export async function fetchSession(id: string): Promise<SessionDetail> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`session ${r.status}`);
  return r.json();
}

export async function postSync(): Promise<unknown> {
  const r = await fetch('/api/sync', { method: 'POST' });
  if (!r.ok) throw new Error(`sync ${r.status}`);
  return r.json();
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shortProject(project: string | null): string {
  if (!project) return '';
  const parts = project.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/');
}
