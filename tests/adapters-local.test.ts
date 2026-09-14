import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/core/sources/claude-code.js';
import { CodexAdapter } from '../src/core/sources/codex.js';
import { GeminiCliAdapter } from '../src/core/sources/gemini-cli.js';

const tmpFiles: string[] = [];
function tmp(name: string, content: string): string {
  // some adapters key the native id off the file basename (e.g. claude session uuid), so keep the target name
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiyi-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  tmpFiles.push(dir);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true, recursive: true });
});

describe('ClaudeCodeAdapter.parseFile', () => {
  const sid = '11111111-1111-4111-8111-111111111111';
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: sid }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'AI generated title', sessionId: sid }),
    // human input: string content + origin.human
    JSON.stringify({
      type: 'user', isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z',
      cwd: '/Users/x/proj', sessionId: sid, origin: { kind: 'human' }, promptSource: 'typed',
      message: { role: 'user', content: 'speed up my build' },
    }),
    // tool result: array content, no origin -> must be filtered
    JSON.stringify({
      type: 'user', timestamp: '2026-09-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents...' }] },
    }),
    // CLI internal command wrapper -> filtered
    JSON.stringify({
      type: 'user', timestamp: '2026-09-01T10:00:02.000Z', origin: { kind: 'human' },
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    }),
    // sidechain (subagent) -> filtered
    JSON.stringify({
      type: 'assistant', isSidechain: true, timestamp: '2026-09-01T10:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent output' }] },
    }),
    // assistant: text + tool_use
    JSON.stringify({
      type: 'assistant', isSidechain: false, timestamp: '2026-09-01T10:00:04.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check the build config first.' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x/vite.config.ts' } },
        ],
      },
    }),
    // assistant: bare tool_use (no text) -> merged into the previous assistant message
    JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm build' } }] },
    }),
    // assistant: thinking-only block -> filtered
    JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T10:00:06.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
    }),
    // attachment -> filtered
    JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_delta' } }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T10:00:07.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Conclusion: enable the dep pre-bundling cache.' }] },
    }),
  ];

  it('extracts the right message sequence and filters noise', async () => {
    const f = tmp(`${sid}.jsonl`, lines.join('\n') + '\n');
    const s = await new ClaudeCodeAdapter().parseFile(f);
    expect(s).not.toBeNull();
    expect(s!.nativeId).toBe(sid);
    expect(s!.source).toBe('claude-code');
    expect(s!.title).toBe('AI generated title');
    expect(s!.project).toBe('/Users/x/proj');
    expect(s!.startedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(s!.endedAt).toBe('2026-09-01T10:00:07.000Z');

    const roles = s!.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'assistant']);

    // bare tool calls merged: first assistant message carries 2 tool calls
    const a1 = s!.messages[1]!;
    expect(a1.content).toBe('let me check the build config first.');
    expect(a1.toolCalls).toEqual([
      { name: 'Read', brief: '/x/vite.config.ts' },
      { name: 'Bash', brief: 'pnpm build' },
    ]);
  });

  it('falls back to the first user message as title when ai-title is absent', async () => {
    const noTitle = lines.filter((l) => !l.includes('ai-title'));
    const f = tmp(`${sid}.jsonl`, noTitle.join('\n') + '\n');
    const s = await new ClaudeCodeAdapter().parseFile(f);
    expect(s!.title).toBe('speed up my build');
  });
});

describe('CodexAdapter.parseFile', () => {
  const uuid = '019f8908-2254-7abc-9def-0123456789ab';
  const rolloutLines = [
    JSON.stringify({
      timestamp: '2026-07-22T08:54:00.000Z', type: 'session_meta',
      payload: { id: uuid, timestamp: '2026-07-22T08:53:59.557Z', cwd: '/Users/x/demo', originator: 'codex_vscode' },
    }),
    JSON.stringify({ timestamp: '2026-07-22T08:54:00.100Z', type: 'turn_context', payload: { model: 'gpt-5.4' } }),
    // injected noise: AGENTS.md arriving as a user_message event -> filtered
    JSON.stringify({
      timestamp: '2026-07-22T08:54:00.200Z', type: 'event_msg',
      payload: { type: 'user_message', message: '# AGENTS.md instructions for /Users/x/demo\n...' },
    }),
    // real human input
    JSON.stringify({
      timestamp: '2026-07-22T08:54:01.000Z', type: 'event_msg',
      payload: { type: 'user_message', message: 'review the scripts under apps/api/scripts' },
    }),
    // developer injection -> skipped
    JSON.stringify({
      timestamp: '2026-07-22T08:54:02.000Z', type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] },
    }),
    // tool call (brief taken from the cmd field)
    JSON.stringify({
      timestamp: '2026-07-22T08:54:03.000Z', type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status --short","workdir":"/Users/x/demo"}' },
    }),
    JSON.stringify({
      timestamp: '2026-07-22T08:54:05.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Inventory: the scripts fall into four groups.' }] },
    }),
    // reasoning -> skipped
    JSON.stringify({ timestamp: '2026-07-22T08:54:06.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } }),
    JSON.stringify({
      timestamp: '2026-07-22T08:54:07.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Conclusion: they cannot be deleted in bulk.' }] },
    }),
  ];

  it('event_msg path: extracts user/assistant/tool briefs, filters injections', async () => {
    const f = tmp(`rollout-2026-07-22T08-53-59-${uuid}.jsonl`, rolloutLines.join('\n') + '\n');
    const s = await new CodexAdapter().parseFile(f);
    expect(s).not.toBeNull();
    expect(s!.nativeId).toBe(uuid);
    expect(s!.project).toBe('/Users/x/demo');
    expect(s!.title).toBe('review the scripts under apps/api/scripts');

    const roles = s!.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'assistant']);
    // tool calls attach to the nearest following assistant message
    expect(s!.messages[1]!.toolCalls).toEqual([{ name: 'exec_command', brief: 'git status --short' }]);
    expect(s!.startedAt).toBe('2026-07-22T08:54:01.000Z');
    expect(s!.endedAt).toBe('2026-07-22T08:54:07.000Z');
  });

  it('RI path: without user_message events, falls back to filtered response_item user messages', async () => {
    const riOnly = [
      JSON.stringify({
        timestamp: '2026-05-01T00:00:00.000Z', type: 'session_meta',
        payload: { id: 'x', cwd: '/Users/x/other' },
      }),
      JSON.stringify({
        timestamp: '2026-05-01T00:00:01.000Z', type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x\n<INSTRUCTIONS>' }] },
      }),
      JSON.stringify({
        timestamp: '2026-05-01T00:00:02.000Z', type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review this branch for me' }] },
      }),
      JSON.stringify({
        timestamp: '2026-05-01T00:00:03.000Z', type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'starting the review.' }] },
      }),
    ];
    const f = tmp(`rollout-2026-05-01T00-00-00-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl`, riOnly.join('\n') + '\n');
    const s = await new CodexAdapter().parseFile(f);
    expect(s!.messages.map((m) => m.content)).toEqual(['review this branch for me', 'starting the review.']);
    expect(s!.title).toBe('review this branch for me');
    expect(s!.nativeId).toBe('aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('oversized lines (base64 image output) are skipped safely', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024 + 10);
    const lines = [
      ...rolloutLines.slice(0, 3),
      JSON.stringify({ timestamp: '2026-07-22T09:00:00.000Z', type: 'response_item', payload: { type: 'function_call_output', output: huge } }),
      ...rolloutLines.slice(3),
    ];
    const f = tmp(`rollout-2026-07-22T08-53-59-${uuid}.jsonl`, lines.join('\n') + '\n');
    const s = await new CodexAdapter().parseFile(f);
    expect(s!.messages.length).toBeGreaterThanOrEqual(3);
  });
});

describe('GeminiCliAdapter.parseFile', () => {
  it('maps user/model, skips info', async () => {
    const f = tmp(
      'session-2026-04-09T02-47-abc.json',
      JSON.stringify({
        sessionId: 'gemini-s1',
        startTime: '2026-04-09T02:47:38.639Z',
        lastUpdated: '2026-04-09T02:50:00.000Z',
        messages: [
          { type: 'info', content: '🟢 Connected to VS Code', timestamp: '2026-04-09T02:47:39.000Z' },
          { type: 'user', content: 'explain this config', timestamp: '2026-04-09T02:48:00.000Z' },
          { type: 'model', content: 'this is a TypeScript compiler config…', timestamp: '2026-04-09T02:49:00.000Z' },
        ],
      })
    );
    const s = await new GeminiCliAdapter().parseFile(f);
    expect(s).not.toBeNull();
    expect(s!.nativeId).toBe('gemini-s1');
    expect(s!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s!.title).toBe('explain this config');
  });

  it('sessions with only info/error return null', async () => {
    const f = tmp(
      'session-empty.json',
      JSON.stringify({ sessionId: 'e1', messages: [{ type: 'info', content: 'x' }] })
    );
    expect(await new GeminiCliAdapter().parseFile(f)).toBeNull();
  });
});
