import { stableId, toIso } from './json-utils.js';
import { truncate, type CommonMessage, type CommonSession } from '../types.js';

interface GeminiEntry {
  role?: string;
  text?: string;
  content?: string;
  timestamp?: unknown;
}

interface GeminiConversation {
  title?: string;
  name?: string;
  create_time?: unknown;
  createTime?: unknown;
  time?: unknown;
  entries?: GeminiEntry[];
  messages?: GeminiEntry[];
}

/**
 * MyActivity.json from Google Takeout (My Activity -> Gemini Apps).
 * Several layout versions exist: {conversations:[...]}, [{conversations:[...]}], or a bare array.
 */
export function parseGeminiTakeout(text: string): CommonSession[] {
  const root = JSON.parse(text) as unknown;
  let convs: GeminiConversation[] = [];
  if (Array.isArray(root)) {
    convs = root.flatMap((r) => {
      const o = r as Record<string, unknown>;
      if (Array.isArray(o['conversations'])) return o['conversations'] as GeminiConversation[];
      if (o['title'] !== undefined && (o['entries'] || o['messages'])) return [r as GeminiConversation];
      return [];
    });
  } else if (root && typeof root === 'object') {
    const o = root as Record<string, unknown>;
    convs = Array.isArray(o['conversations'])
      ? (o['conversations'] as GeminiConversation[])
      : o['entries'] || o['messages']
        ? [root as GeminiConversation]
        : [];
  }

  const out: CommonSession[] = [];
  for (const c of convs) {
    const rawEntries = c.entries ?? c.messages ?? [];
    const messages: CommonMessage[] = [];
    for (const e of rawEntries) {
      const text = (e.text ?? e.content ?? '').toString().trim();
      if (!text) continue;
      const role = /user|human|我/i.test(e.role ?? '') ? 'user' : 'assistant';
      messages.push({ role, content: text, createdAt: toIso(e.timestamp) });
    }
    if (!messages.length) continue;
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const started = toIso(c.create_time) ?? toIso(c.createTime) ?? toIso(c.time) ?? messages[0]?.createdAt;
    out.push({
      nativeId: stableId(c.title ?? c.name ?? '', firstUser.slice(0, 200)),
      source: 'gemini-web',
      title: (c.title ?? c.name ?? '').toString().trim() || truncate(firstUser, 60) || '（无标题）',
      startedAt: started,
      endedAt: messages[messages.length - 1]?.createdAt ?? started,
      messages,
    });
  }
  return out;
}
