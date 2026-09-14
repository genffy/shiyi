import { cleanInlineMarkup, iterJsonArray, stableId, toIso } from './json-utils.js';
import { truncate, type CommonMessage, type CommonSession } from '../types.js';

interface ChatGptNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: {
    author?: { role?: string };
    create_time?: number;
    content?: { content_type?: string; parts?: unknown[] };
  } | null;
}

interface ChatGptConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  conversation_id?: string;
  current_node?: string;
  mapping?: Record<string, ChatGptNode>;
}

function visibleChain(conv: ChatGptConversation): ChatGptNode[] {
  const mapping = conv.mapping ?? {};
  const chain: ChatGptNode[] = [];
  let cur = conv.current_node ? mapping[conv.current_node] : undefined;
  if (!cur) {
    // current_node missing: walk from the root taking the last child at each level (the newest branch)
    const root = Object.values(mapping).find((n) => !n.parent);
    let node: ChatGptNode | undefined = root;
    while (node) {
      chain.push(node);
      const kids = (node.children ?? []).map((id) => mapping[id]).filter(Boolean);
      node = kids.length ? kids[kids.length - 1] : undefined;
    }
    return chain;
  }
  while (cur) {
    chain.push(cur);
    cur = cur.parent ? mapping[cur.parent] : undefined;
  }
  return chain.reverse();
}

// entity/citation markup is handled uniformly by cleanInlineMarkup (see json-utils)
export function chatgptConversationToSession(convRaw: Record<string, unknown>): CommonSession | null {
  const conv = convRaw as unknown as ChatGptConversation;
  const messages: CommonMessage[] = [];
  for (const node of visibleChain(conv)) {
    const m = node.message;
    if (!m?.author?.role) continue;
    const role = m.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = cleanInlineMarkup(
      (m.content?.parts ?? [])
        .filter((p): p is string => typeof p === 'string')
        .join('\n')
    ).trim();
    if (!text) continue;
    messages.push({ role, content: text, createdAt: toIso(m.create_time) });
  }
  if (!messages.length) return null;

  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  return {
    nativeId: conv.conversation_id ?? stableId(conv.title ?? '', firstUser),
    source: 'chatgpt',
    title: conv.title?.trim() || truncate(firstUser, 60) || '(untitled)',
    startedAt: toIso(conv.create_time) ?? messages[0]?.createdAt,
    endedAt: toIso(conv.update_time) ?? messages[messages.length - 1]?.createdAt,
    messages,
  };
}

/** Parse the full conversations.json text (a bare array here; zip extraction happens upstream) */
export function* parseChatGptJson(text: string): Generator<CommonSession> {
  for (const conv of iterJsonArray(text)) {
    const s = chatgptConversationToSession(conv);
    if (s) yield s;
  }
}

interface CodexTurn {
  id?: string;
  role?: string;
  input_items?: Array<{ content?: Array<{ content_type?: string; text?: string }> }>;
  output_items?: Array<{ content?: Array<{ content_type?: string; text?: string }> }>;
}

/** codex.json inside a ChatGPT export (cloud Codex tasks): task -> turns; user turns live in input_items, assistant turns in output_items */
export function parseChatGptCodexJson(text: string): CommonSession[] {
  const tasks = JSON.parse(text) as unknown;
  if (!Array.isArray(tasks)) return [];

  const out: CommonSession[] = [];
  for (const taskRaw of tasks) {
    const task = taskRaw as { id?: string; title?: string; turns?: CodexTurn[] };
    const messages: CommonMessage[] = [];
    for (const turn of task.turns ?? []) {
      const role = turn.role === 'user' ? 'user' : turn.role === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const items = role === 'user' ? turn.input_items : turn.output_items;
      const text = cleanInlineMarkup(
        (items ?? []).flatMap((i) => i.content ?? [])
          .filter((c) => c.content_type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
      ).trim();
      if (!text) continue;
      messages.push({ role, content: text, createdAt: hexEpochFromTurnId(turn.id) });
    }
    if (!messages.length) continue;
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const started = messages[0]?.createdAt;
    out.push({
      nativeId: task.id ?? stableId(task.title ?? '', firstUser),
      source: 'codex',
      title: task.title?.trim() || truncate(firstUser, 60) || '(untitled)',
      startedAt: started,
      endedAt: messages[messages.length - 1]?.createdAt ?? started,
      messages,
    });
  }
  return out;
}

// turn ids look like task_e_68d17133000000000000000000000000~usertrn_e_68d171340000…: the first 8 hex chars after _e_ are epoch seconds
function hexEpochFromTurnId(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const m = id.match(/_e_([0-9a-f]{8})/);
  if (!m) return undefined;
  const sec = parseInt(m[1]!, 16);
  if (sec < 1577836800 || sec > 2051222400) return undefined; // sanity range 2020-2035
  return new Date(sec * 1000).toISOString();
}
