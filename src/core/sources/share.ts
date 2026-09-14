import { stableId } from './json-utils.js';
import { truncate, type CommonMessage, type CommonSession, type SourceId } from '../types.js';

export type ShareProvider = 'chatgpt' | 'kimi' | 'grok' | 'gemini';

const SHARE_URL_PATTERNS: Array<{ provider: ShareProvider; re: RegExp }> = [
  { provider: 'chatgpt', re: /^https?:\/\/chatgpt\.com\/share\/([a-f0-9-]+)/i },
  { provider: 'kimi', re: /^https?:\/\/(?:www\.)?(?:kimi\.moonshot\.cn|kimi\.com)\/share\/([\w-]+)/i },
  { provider: 'grok', re: /^https?:\/\/(?:www\.)?(?:grok\.com\/share\/([\w-]+)|x\.com\/i\/grok\/share\/([a-f0-9]+))/i },
  { provider: 'gemini', re: /^https?:\/\/share\.gemini\.google\/([\w-]+)/i },
];

export function detectShareUrl(url: string): { provider: ShareProvider; urlId: string } | null {
  for (const { provider, re } of SHARE_URL_PATTERNS) {
    const m = url.trim().match(re);
    if (m) {
      const urlId = m.slice(1).find((g) => g !== undefined);
      if (urlId) return { provider, urlId };
    }
  }
  return null;
}

export function providerSource(provider: ShareProvider): SourceId {
  return provider === 'chatgpt' ? 'chatgpt' : provider === 'gemini' ? 'gemini-web' : provider;
}

/** Minimal HTML -> text (good enough for SSR share pages; avoids a DOM dependency) */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|pre|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, n: string) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return '';
      }
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return htmlToText(og[1]!);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return htmlToText(t[1]!);
  return '';
}

function mergeConsecutive(messages: CommonMessage[]): CommonMessage[] {
  const out: CommonMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push(m);
  }
  return out;
}

/** ChatGPT share page: message blocks carry data-message-author-role="user|assistant" */
function extractChatGptShare(html: string): CommonMessage[] {
  const positions: Array<{ role: 'user' | 'assistant'; idx: number }> = [];
  const re = /data-message-author-role="(user|assistant)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) positions.push({ role: m[1] as 'user' | 'assistant', idx: m.index });
  if (!positions.length) return [];

  const messages: CommonMessage[] = [];
  for (let i = 0; i < positions.length; i++) {
    // the next segment starts at the '<' of the tag containing the next marker, keeping the next message's opening tag out
    const end = i + 1 < positions.length ? html.lastIndexOf('<', positions[i + 1]!.idx) : html.length;
    const seg = html.slice(positions[i]!.idx, end);
    const gt = seg.indexOf('>');
    if (gt === -1) continue;
    const text = htmlToText(seg.slice(gt + 1));
    if (text) messages.push({ role: positions[i]!.role, content: text });
  }
  return mergeConsecutive(messages);
}

// kept for reference: whole-page text fallback is only for local HTML/MD files, never for share URLs (shells would produce junk)

/** transport-layer noise on the Kimi share page: occasional pseudo HTTP headers in user text */
const KIMI_NOISE_LINE = /^(Content-Type|Cache-Control|Transfer-Encoding|Content-Disposition):/;

interface KimiShareApi {
  share?: {
    chat?: { name?: string };
    createTime?: string;
    messages?: Array<{
      role?: string;
      createTime?: string;
      blocks?: Array<Record<string, unknown>>;
    }>;
  };
}

/** pull a one-line readable brief out of tool-call args (a JSON string) */
function kimiToolBrief(args: unknown): string {
  if (typeof args !== 'string' || !args) return '';
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    for (const key of ['queries', 'query', 'keywords', 'keyword', 'file_name', 'filename', 'path', 'url', 'pattern']) {
      const v = a[key];
      if (typeof v === 'string' && v) return truncate(v, 60);
      if (Array.isArray(v) && v.length && typeof v[0] === 'string') return truncate(v[0]!, 60);
    }
  } catch {
    // args is not JSON; truncate as-is
    return truncate(args, 60);
  }
  return '';
}

/**
 * Parse the Kimi share page's GetChatShare API response (raw JSON intercepted in the browser).
 * Assistant blocks arrive as multiStage/stage metadata, think (reasoning), tool (tool calls), text (markdown source).
 */
export function parseKimiShareApi(raw: unknown, urlId: string): CommonSession | null {
  const share = (raw as KimiShareApi)?.share;
  const items = share?.messages ?? [];
  if (!items.length) return null;

  const messages: CommonMessage[] = [];
  for (const m of items) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const texts: string[] = [];
    const thinks: string[] = [];
    const tools: Array<{ name: string; brief: string }> = [];
    for (const b of m.blocks ?? []) {
      if (typeof b['text'] === 'object' && b['text']) {
        const c = (b['text'] as { content?: unknown }).content;
        if (typeof c === 'string' && c.trim()) texts.push(c);
      } else if (typeof b['think'] === 'object' && b['think']) {
        const c = (b['think'] as { content?: unknown }).content;
        if (typeof c === 'string' && c.trim()) thinks.push(c);
      } else if (typeof b['tool'] === 'object' && b['tool']) {
        const t = b['tool'] as { name?: unknown; args?: unknown };
        if (typeof t.name === 'string' && t.name) tools.push({ name: t.name, brief: kimiToolBrief(t.args) });
      }
    }
    const content = texts
      .join('\n\n')
      .split('\n')
      .filter((l) => !KIMI_NOISE_LINE.test(l))
      .join('\n')
      .trim();
    if (!content && !thinks.length) continue;
    messages.push({
      role: m.role,
      content: content || '(no content)',
      ...(thinks.length ? { thinking: thinks.join('\n\n').trim() } : {}),
      ...(tools.length ? { toolCalls: tools } : {}),
      ...(m.createTime ? { createdAt: m.createTime } : {}),
    });
  }
  if (!messages.length) return null;

  const firstUser = messages.find((x) => x.role === 'user')?.content ?? '';
  return {
    nativeId: `share-${urlId}`,
    source: 'kimi',
    title: share?.chat?.name?.trim() || truncate(firstUser, 60) || '(untitled)',
    startedAt: messages[0]?.createdAt ?? share?.createTime,
    endedAt: messages[messages.length - 1]?.createdAt ?? share?.createTime,
    messages,
  };
}

/**
 * Extract a conversation from share-page HTML.
 * Observed (2026-09): ChatGPT/Kimi/Gemini share pages are all client-rendered; plain HTTP gets only the app shell.
 * So only structured extraction is attempted (currently just ChatGPT's SSR markers); when nothing is found,
 * return null and let the caller give clear guidance — never store shell text as a note.
 */
export function extractShareConversation(
  provider: ShareProvider,
  html: string,
  urlId: string
): CommonSession | null {
  const title = extractTitle(html) || `Shared session ${urlId.slice(0, 8)}`;
  if (provider !== 'chatgpt') return null; // kimi/grok/gemini await structured rules (need real rendered-DOM traits)
  const messages = extractChatGptShare(html);
  if (!messages.length) return null;

  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  return {
    nativeId: `share-${urlId}`,
    source: providerSource(provider),
    title: title.replace(/\s*[|-]\s*(ChatGPT|Kimi|Grok).*$/i, '').trim() || truncate(firstUser, 60) || '(untitled)',
    startedAt: undefined,
    endedAt: undefined,
    messages,
  };
}

export { stableId };
