import path from 'node:path';
import { stableId } from './json-utils.js';
import { truncate, type CommonMessage, type CommonSession, type SourceId } from '../types.js';

const USER_MARK = /^(?:#{1,4}\s*)?(?:\*\*)?\s*(user|me|human|我|用户|提问)(?:\*\*)?\s*[:：]/i;
const AI_MARK =
  /^(?:#{1,4}\s*)?(?:\*\*)?\s*(grok|kimi|deepseek|glm|chatgpt|claude|gemini|assistant|ai|bot|model|助手|回答)(?:\*\*)?\s*[:：]/i;
const HEADING = /^(?:#{1,2})\s+(.+)$/;
const HEADING_USER = /^(user|me|human|我|用户|提问)$/i;
const HEADING_AI = /^(grok|kimi|deepseek|glm|chatgpt|claude|gemini|assistant|ai|bot|model|助手|回答)$/i;

/**
 * Generic conversation Markdown parser: Grok/Kimi sessions exported by userscripts or browser
 * extensions, or manually pasted conversation Markdown (role markers like "## User" / "## 用户" /
 * "**Kimi**:" / "AI：" are all recognized).
 * Without any role marker the whole file is stored as a single note.
 */
export function parseConversationMarkdown(
  text: string,
  filename: string,
  source: SourceId = 'grok'
): CommonSession[] {
  const lines = text.split('\n');

  // An H1 is a session boundary if and only if the next non-empty line is a role-marker heading
  // (## User / ## Kimi etc.); otherwise it is an H1 inside a message body (e.g. a markdown heading
  // in a Kimi answer) and is kept as content
  const isRoleHeading = (l: string | undefined): boolean => {
    if (!l) return false;
    const h = l.match(HEADING);
    if (!h) return false;
    const label = h[1]!.trim();
    return HEADING_USER.test(label) || HEADING_AI.test(label);
  };
  const nextNonEmpty = (i: number): string | undefined => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim()) return lines[j];
    return undefined;
  };
  const isBoundary = (i: number): boolean => {
    if (!/^#\s+/.test(lines[i]!)) return false;
    return isRoleHeading(nextNonEmpty(i));
  };

  const blocks: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } = { title: '', lines: [] };
  const flush = () => {
    if (current.lines.some((l) => l.trim())) blocks.push(current);
  };
  // A lone H1 at the top of the file (not a boundary) becomes the whole-file title
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx >= 0 && /^#\s+/.test(lines[firstIdx]!) && !isBoundary(firstIdx)) {
    current.title = lines[firstIdx]!.replace(/^#\s+/, '').trim();
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === firstIdx && current.title) continue;
    if (isBoundary(i)) {
      flush();
      current = { title: line.replace(/^#\s+/, '').trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  if (!blocks.length) return [];

  const sessions: CommonSession[] = [];
  for (const block of blocks) {
    const messages: CommonMessage[] = [];
    let role: 'user' | 'assistant' | null = null;
    let buf: string[] = [];

    const pushMsg = () => {
      const content = buf.join('\n').trim();
      if (content && role) messages.push({ role, content });
      buf = [];
    };

    for (const line of block.lines) {
      const h = line.match(HEADING);
      if (h) {
        const label = h[1]!.trim();
        if (HEADING_USER.test(label)) {
          pushMsg();
          role = 'user';
          continue;
        }
        if (HEADING_AI.test(label)) {
          pushMsg();
          role = 'assistant';
          continue;
        }
        // other sub-headings stay in the current turn's text
        buf.push(line);
        continue;
      }
      if (USER_MARK.test(line)) {
        pushMsg();
        role = 'user';
        buf.push(line.replace(USER_MARK, '').trimStart());
      } else if (AI_MARK.test(line)) {
        pushMsg();
        role = 'assistant';
        buf.push(line.replace(AI_MARK, '').trimStart());
      } else {
        buf.push(line);
      }
    }
    pushMsg();

    const title = block.title || truncate(messages.find((m) => m.role === 'user')?.content ?? '', 60) || '（无标题）';
    if (!messages.length) {
      // no role markers: the whole block becomes a single note
      const content = block.lines.join('\n').trim();
      if (content) {
        sessions.push({
          nativeId: stableId(filename, title, content.slice(0, 200)),
          source,
          title,
          messages: [{ role: 'user', content }],
        });
      }
      continue;
    }
    sessions.push({
      nativeId: stableId(filename, title, messages[0]!.content.slice(0, 100)),
      source,
      title,
      startedAt: messages[0]?.createdAt,
      endedAt: messages[messages.length - 1]?.createdAt,
      messages,
    });
  }
  return sessions;
}

export function grokNativeIdFromPath(p: string): string {
  return path.basename(p, path.extname(p));
}
