import { stableId, toIso } from './json-utils.js';
import { truncate, type CommonMessage, type CommonSession, type SourceId } from '../types.js';

interface RoleChatMessage {
  role?: string;
  sender?: string;
  message?: unknown;
  content?: unknown;
  text?: unknown;
  create_time?: unknown;
  createTime?: unknown;
  created_at?: unknown;
}

interface RoleChatItem {
  id?: string;
  chat_id?: string;
  conversationId?: string;
  conversation_id?: string;
  title?: string;
  name?: string;
  create_time?: unknown;
  createTime?: unknown;
  created_at?: unknown;
  messages?: RoleChatMessage[];
  msg_list?: RoleChatMessage[];
  entries?: RoleChatMessage[];
}

function firstString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const key of ['text', 'content', 'message']) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  return '';
}

/**
 * Generic role-shaped conversation JSON parser, covering:
 * - grok.com official export (sender: human / message)
 * - userscript-exported Grok JSON (conversationId / messages)
 * - Kimi export (chat_id / messages / role)
 */
export function parseRoleChat(text: string, source: SourceId): CommonSession[] {
  const root = JSON.parse(text) as unknown;
  const o = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>;
  let items: RoleChatItem[] = [];
  if (Array.isArray(root)) items = root as RoleChatItem[];
  else if (Array.isArray(o['conversations'])) items = o['conversations'] as RoleChatItem[];
  else if (Array.isArray(o['chats'])) items = o['chats'] as RoleChatItem[];
  else if (Array.isArray(o['data'])) items = o['data'] as RoleChatItem[];
  else if (Array.isArray(o['items'])) items = o['items'] as RoleChatItem[];
  else if (o['messages'] || o['msg_list']) items = [root as RoleChatItem];

  const out: CommonSession[] = [];
  for (const item of items) {
    const rawMsgs = item.messages ?? item.msg_list ?? item.entries ?? [];
    const messages: CommonMessage[] = [];
    for (const m of rawMsgs) {
      const text = firstString(m.message ?? m.content ?? m.text).trim();
      if (!text) continue;
      const who = (m.role ?? m.sender ?? '').toLowerCase();
      const role = /human|user|我|me\b/.test(who) ? 'user' : 'assistant';
      messages.push({ role, content: text, createdAt: toIso(m.create_time ?? m.createTime ?? m.created_at) });
    }
    if (!messages.length) continue;
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const started =
      toIso(item.create_time) ?? toIso(item.createTime) ?? toIso(item.created_at) ?? messages[0]?.createdAt;
    out.push({
      nativeId: item.conversationId ?? item.conversation_id ?? item.chat_id ?? item.id ?? stableId(item.title ?? item.name ?? '', firstUser.slice(0, 200)),
      source,
      title: (item.title ?? item.name ?? '').toString().trim() || truncate(firstUser, 60) || '(untitled)',
      startedAt: started,
      endedAt: messages[messages.length - 1]?.createdAt ?? started,
      messages,
    });
  }
  return out;
}
