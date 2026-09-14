import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { ShiYiDb } from '../src/core/db.js';
import { importFile } from '../src/core/import.js';
import { parseGeminiTakeout } from '../src/core/sources/gemini-takeout.js';
import { parseConversationMarkdown } from '../src/core/sources/grok.js';
import { parseRoleChat } from '../src/core/sources/role-chat.js';
import { parseChatGptJson } from '../src/core/sources/chatgpt.js';

const tmpFiles: string[] = [];
function tmp(name: string, content: string | Uint8Array): string {
  const p = path.join(os.tmpdir(), `shiyi-test-${Date.now()}-${name}`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

describe('ChatGPT conversations.json', () => {
  const mapping = {
    root: { id: 'root', parent: null, children: ['u1'] },
    u1: { id: 'u1', parent: 'root', children: ['a1', 'a2'], message: { author: { role: 'user' }, create_time: 1700000000, content: { content_type: 'text', parts: ['original question'] } } },
    // stale branch from an edited/regenerated turn
    a1: { id: 'a1', parent: 'u1', children: [], message: { author: { role: 'assistant' }, create_time: 1700000001, content: { content_type: 'text', parts: ['old answer'] } } },
    a2: { id: 'a2', parent: 'u1', children: [], message: { author: { role: 'assistant' }, create_time: 1700000002, content: { content_type: 'text', parts: ['new answer (regenerated branch)'] } } },
  };
  const conv = {
    title: 'test conversation',
    create_time: 1700000000,
    update_time: 1700000002,
    conversation_id: 'conv-1',
    current_node: 'a2',
    mapping,
  };

  it('follows current_node to the latest branch', () => {
    const sessions = [...parseChatGptJson(JSON.stringify([conv]))];
    expect(sessions).toHaveLength(1);
    const contents = sessions[0]!.messages.map((m) => m.content);
    expect(contents).toEqual(['original question', 'new answer (regenerated branch)']);
    expect(sessions[0]!.nativeId).toBe('conv-1');
    expect(sessions[0]!.source).toBe('chatgpt');
  });

  it('falls back to the last child from root when current_node is missing', () => {
    const noCurrent = { ...conv, current_node: undefined };
    const sessions = [...parseChatGptJson(JSON.stringify([noCurrent]))];
    expect(sessions[0]!.messages.map((m) => m.content)).toEqual(['original question', 'new answer (regenerated branch)']);
  });

  it('imports a ChatGPT zip', async () => {
    const zip = zipSync({ 'conversations.json': new TextEncoder().encode(JSON.stringify([conv])) });
    const db = new ShiYiDb(tmp('chatgpt.db', ''));
    const r = await importFile(db, tmp('chatgpt.zip', zip));
    expect(r.error).toBeUndefined();
    expect(r.source).toBe('chatgpt');
    expect(r.sessions).toBe(1);
  });

  it('strips inline entity markup (private-use chars wrapping entity[...])', () => {
    const marked = {
      ...conv,
      conversation_id: 'conv-entity',
      mapping: {
        root: { id: 'root', parent: null, children: ['u1'] },
        u1: {
          id: 'u1', parent: 'root', children: [],
          message: {
            author: { role: 'assistant' }, create_time: 1700000000,
            content: { content_type: 'text', parts: ['built on \ue200entity\ue202["software", "Demo", 0]\ue201 stack'] },
          },
        },
      },
      current_node: 'u1',
    };
    const sessions = [...parseChatGptJson(JSON.stringify([marked]))];
    expect(sessions[0]!.messages[0]!.content).toBe('built on  stack');
  });
});

describe('ChatGPT codex.json (cloud Codex tasks)', () => {
  it('maps user turns from input_items, assistant turns from output_items, with epoch-hex ids', async () => {
    const json = JSON.stringify([
      {
        id: 'task_e_68d17133000000000000000000000000',
        title: 'Refactor the export module',
        turns: [
          {
            id: 'task_e_68d17133000000000000000000000000~usertrn_e_68d17134000000000000000000000000',
            role: 'user',
            input_items: [{ role: 'user', content: [{ content_type: 'text', text: 'refactor the export module' }] }],
          },
          {
            id: 'task_e_68d17133000000000000000000000000~assttrn_e_68d17134000000000000000000000001',
            role: 'assistant',
            output_items: [{ content: [{ content_type: 'text', text: '### Summary\n* split into helpers…' }] }],
          },
        ],
      },
    ]);
    const db = new ShiYiDb(tmp('codex-cloud.db', ''));
    const r = await importFile(db, tmp('codex.json', json));
    expect(r.error).toBeUndefined();
    expect(r.source).toBe('codex');
    expect(r.sessions).toBe(1);
    const row = db.getSession('codex:task_e_68d17133000000000000000000000000')!;
    expect(row.title).toBe('Refactor the export module');
    expect(row.started_at!.startsWith('2025-')).toBe(true);
    const msgs = db.getMessages(row.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]!.content).toBe('refactor the export module');
  });
});

describe('Gemini Takeout', () => {
  it('parses the conversations/entries structure', () => {
    const json = JSON.stringify({
      conversations: [
        {
          title: 'Gemini chat',
          create_time: 1710000000,
          entries: [
            { role: 'user', text: 'hi' },
            { role: 'model', text: 'hello, how can I help?' },
          ],
        },
      ],
    });
    const sessions = parseGeminiTakeout(json);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.source).toBe('gemini-web');
    expect(sessions[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(sessions[0]!.startedAt).toBe('2024-03-09T16:00:00.000Z');
  });

  it('imports a Takeout zip (My Activity/Gemini Apps/MyActivity.json)', async () => {
    const json = JSON.stringify({
      conversations: [
        { title: 'T', entries: [{ role: 'user', text: 'hi' }, { role: 'model', text: 'hello' }] },
      ],
    });
    const zip = zipSync({
      'Takeout/My Activity/Gemini Apps/MyActivity.json': new TextEncoder().encode(json),
      'Takeout/ignored.html': new TextEncoder().encode('<html></html>'),
    });
    const db = new ShiYiDb(tmp('gemini.db', ''));
    const r = await importFile(db, tmp('takeout.zip', zip));
    expect(r.source).toBe('gemini-web');
    expect(r.sessions).toBe(1);
  });
});

describe('Grok', () => {
  it('official export JSON (sender: human)', () => {
    const json = JSON.stringify({
      conversations: [
        {
          conversationId: 'g1',
          title: 'Grok chat',
          createTime: 1710000000000,
          messages: [
            { sender: 'human', message: 'summarize this', createTime: 1710000000000 },
            { sender: 'grok', message: 'sure, the summary is…', createTime: 1710000001000 },
          ],
        },
      ],
    });
    const sessions = parseRoleChat(json, 'grok');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(sessions[0]!.nativeId).toBe('g1');
  });

  it('userscript-exported Markdown (## User / ## Grok)', () => {
    const md = `# Rust ownership notes
## User
What is ownership?
## Grok
Ownership is Rust's core memory-management concept…
## User
How does borrowing differ?
## Grok
Borrowing does not transfer ownership…`;
    const sessions = parseConversationMarkdown(md, 'grok-export.md');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe('Rust ownership notes');
    expect(sessions[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(sessions[0]!.messages[0]!.content).toBe('What is ownership?');
  });

  // Chinese role markers (## 用户 / ## Kimi) exercise the CJK keyword coverage of the parser
  it('Kimi-style Markdown (## 用户 / ## Kimi, source forced via -s kimi)', () => {
    const md = `# Weekly report draft
## 用户
draft my weekly report
## Kimi
here is a draft based on your git log…
## 用户
add the release section
## Kimi
added.`;
    const sessions = parseConversationMarkdown(md, 'kimi-paste.md', 'kimi');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.source).toBe('kimi');
    expect(sessions[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('an H1 line inside a message body does not split the session', () => {
    const md = `# Architecture notes
## 用户
draw an architecture diagram
## Kimi
sure, three layers:

# Network layer

details of the network layer…

## 用户
continue
## Kimi
done.`;
    const sessions = parseConversationMarkdown(md, 'h1-collision.md', 'kimi');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(sessions[0]!.messages[1]!.content).toContain('# Network layer');
  });

  it('Markdown without role markers becomes a single note', () => {
    const sessions = parseConversationMarkdown('# Excerpt\na note without any role markers.', 'note.md');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages).toHaveLength(1);
    expect(sessions[0]!.messages[0]!.content).toContain('without any role markers');
  });
});

describe('Kimi (generic role structure)', () => {
  it('parses chat_id + messages', () => {
    const json = JSON.stringify({
      chats: [
        {
          chat_id: 'k1',
          title: 'Kimi chat',
          create_time: 1710000000,
          messages: [
            { role: 'user', content: 'draft my weekly report' },
            { role: 'assistant', content: 'here is a draft…' },
          ],
        },
      ],
    });
    const sessions = parseRoleChat(json, 'kimi');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.source).toBe('kimi');
    expect(sessions[0]!.nativeId).toBe('k1');
  });

  it('a bare JSON is auto-detected as kimi', async () => {
    const json = JSON.stringify({
      chats: [{ chat_id: 'k2', title: 'x', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] }],
    });
    const db = new ShiYiDb(tmp('kimi.db', ''));
    const r = await importFile(db, tmp('kimi-export.json', json));
    expect(r.source).toBe('kimi');
    expect(r.sessions).toBe(1);
  });
});

describe('import + search roundtrip', () => {
  // CJK fixture on purpose: exercises the trigram tokenizer with a Chinese query
  it('after upsert, FTS finds the session (CJK trigram)', async () => {
    const db = new ShiYiDb(tmp('roundtrip.db', ''));
    const json = JSON.stringify({
      conversations: [
        { conversationId: 'g9', title: '内存泄漏排查', messages: [{ sender: 'human', message: '如何排查 Node 内存泄漏' }, { sender: 'grok', message: '对比 heap snapshot 即可…' }] },
      ],
    });
    await importFile(db, tmp('g9.json', json));
    const r = db.listSessions({ q: '内存泄漏' });
    expect(r.total).toBe(1);
    expect(r.items[0]!.title).toBe('内存泄漏排查');
    expect(r.items[0]!.snippet).toBeTruthy();
  });
});
