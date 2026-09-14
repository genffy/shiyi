import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShiYiDb } from '../src/core/db.js';
import { importFile } from '../src/core/import.js';
import { detectShareUrl, extractShareConversation, htmlToText, parseKimiShareApi } from '../src/core/sources/share.js';

const cleanup: string[] = [];
function tmp(name: string, content: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shiyi-share-'));
  const p = path.join(d, name);
  fs.writeFileSync(p, content);
  cleanup.push(d);
  return p;
}
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { force: true, recursive: true });
});

describe('share URL detection', () => {
  it('recognizes all providers', () => {
    expect(detectShareUrl('https://chatgpt.com/share/abc-123-def')!.provider).toBe('chatgpt');
    expect(detectShareUrl('https://kimi.moonshot.cn/share/xyz987')!.provider).toBe('kimi');
    expect(detectShareUrl('https://kimi.com/share/xyz987')!.provider).toBe('kimi');
    expect(detectShareUrl('https://grok.com/share/p/12345')!.urlId).toBe('p');
    expect(detectShareUrl('https://x.com/i/grok/share/00000000000000000000000000000000')).toEqual({
      provider: 'grok',
      urlId: '00000000000000000000000000000000',
    });
    expect(detectShareUrl('https://share.gemini.google/example-share-id')!.provider).toBe('gemini');
    expect(detectShareUrl('https://example.com/share/x')).toBeNull();
    expect(detectShareUrl('/Users/x/conversations.json')).toBeNull();
  });
});

describe('ChatGPT share page parsing', () => {
  const html = `<!doctype html>
<html><head><meta property="og:title" content="Database indexing basics - ChatGPT"><title>Database indexing basics</title></head>
<body>
<div class="chat-container">
  <div class="message" data-message-id="m1" data-message-author-role="user">
    <div>How does database indexing work?</div>
  </div>
  <div class="message" data-message-id="m2" data-message-author-role="assistant">
    <div>An index is a <b>sorted lookup structure</b>.<br>Steps are:</div>
    <ul><li>Create the index</li><li>Query planner uses it</li></ul>
  </div>
  <div class="message" data-message-id="m3" data-message-author-role="user">
    <div>Is it free?</div>
  </div>
  <div class="message" data-message-id="m4" data-message-author-role="assistant">
    <div>No, writes get slower &amp; free-text search is limited.</div>
  </div>
</div>
<script>window.__data = "ignored";</script>
</body></html>`;

  it('extracts turns via data-message-author-role', () => {
    const s = extractShareConversation('chatgpt', html, 'abc-123-def')!;
    expect(s).not.toBeNull();
    expect(s.nativeId).toBe('share-abc-123-def');
    expect(s.source).toBe('chatgpt');
    expect(s.title).toBe('Database indexing basics'); // og:title with " - ChatGPT" suffix stripped
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(s.messages[0]!.content).toBe('How does database indexing work?');
    expect(s.messages[1]!.content).toContain('sorted lookup structure');
    expect(s.messages[1]!.content).toContain('- Create the index');
    expect(s.messages[3]!.content).toContain('& free-text'); // entity decoding
    expect(s.messages[1]!.content).not.toContain('window.__data'); // script stripped
  });
});

describe('htmlToText', () => {
  it('decodes entities and strips tags', () => {
    expect(htmlToText('<p>a &lt;b&gt; c</p><p>d</p>')).toBe('a <b> c\nd');
    expect(htmlToText('&#x4e2d;&#25991;')).toBe('中文');
    expect(htmlToText('<script>var x="</div>";</script>ok')).toBe('ok');
  });
});

describe('share import', () => {
  it('client-rendered shell produces no junk session (null)', () => {
    // Real-world behavior: fetching a kimi share URL returns the marketing shell, which must be rejected
    const shell =
      '<html><head><meta property="og:title" content="Kimi AI"><body><div>Kimi K3 is out, built for agentic coding</div></body></html>';
    expect(extractShareConversation('kimi', shell, 'test-id')).toBeNull();
    // chatgpt client-rendered shell (no data-message-author-role) also returns null
    expect(extractShareConversation('chatgpt', '<html><body>shell</body></html>', 'x-id')).toBeNull();
  });

  it('importFile handles unreachable URLs gracefully', async () => {
    const db = new ShiYiDb(path.join(os.tmpdir(), `shiyi-url-${Date.now()}.db`) + '');
    const r = await importFile(db, 'https://chatgpt.com/share/nonexistent-id-test-00000000');
    // success or failure, the outcome is structurally complete and never throws
    expect(r).toHaveProperty('sessions');
    db.close();
  });
});

describe('Kimi GetChatShare API parsing', () => {
  // Structure mirrors a real share-page XHR payload observed in 2026-09 (fields trimmed, content synthetic)
  const api = {
    share: {
      id: 'share-uuid',
      createTime: '2026-08-27T07:39:00Z',
      chat: { id: 'chat-1', name: 'Caching strategies compared' },
      messages: [
        {
          role: 'user',
          createTime: '2026-08-27T07:39:01Z',
          blocks: [
            { messageId: '', text: { content: 'Content-Type: application/octet-stream\nCache-Control: no-store\nCompare caching strategies?' } },
          ],
        },
        {
          role: 'assistant',
          createTime: '2026-08-27T07:39:30Z',
          blocks: [
            { multiStage: { stages: [{ name: 'STAGE_NAME_THINKING' }] } },
            { stage: { name: 'STAGE_NAME_THINKING', status: 'STAGE_STATUS_END' } },
            { think: { content: 'The user asks about cache-aside vs write-through.', summary: 'Explaining caching' } },
            { think: { content: 'Now write the answer.' } },
            { tool: { toolCallId: 't1', name: 'web_search', args: '{"queries":["cache-aside vs write-through"]}' } },
            { text: { content: '## 1. Cache-aside\n\n**Idea**: the app manages the cache itself.' } },
          ],
        },
      ],
    },
  };

  it('separates thinking from content and keeps markdown source', () => {
    const s = parseKimiShareApi(api, 'share-uuid')!;
    expect(s.title).toBe('Caching strategies compared');
    expect(s.source).toBe('kimi');
    expect(s.messages).toHaveLength(2);
    const [u, a] = s.messages!;
    // transport noise lines stripped
    expect(u!.content).toBe('Compare caching strategies?');
    expect(u!.thinking).toBeUndefined();
    expect(a!.thinking).toBe('The user asks about cache-aside vs write-through.\n\nNow write the answer.');
    expect(a!.content).toBe('## 1. Cache-aside\n\n**Idea**: the app manages the cache itself.'); // markdown source intact
    expect(a!.toolCalls).toEqual([{ name: 'web_search', brief: 'cache-aside vs write-through' }]);
    expect(a!.createdAt).toBe('2026-08-27T07:39:30Z');
    expect(s.startedAt).toBe('2026-08-27T07:39:01Z');
    expect(s.endedAt).toBe('2026-08-27T07:39:30Z');
  });

  it('returns null for empty/invalid input', () => {
    expect(parseKimiShareApi({}, 'x')).toBeNull();
    expect(parseKimiShareApi({ share: { messages: [] } }, 'x')).toBeNull();
  });
});
