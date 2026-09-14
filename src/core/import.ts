import fs from 'node:fs';
import path from 'node:path';
import { ShiYiDb } from './db.js';
import { inboxDir } from './paths.js';
import { parseChatGptCodexJson, parseChatGptJson } from './sources/chatgpt.js';
import { classifyJson } from './sources/detect.js';
import { parseGeminiTakeout } from './sources/gemini-takeout.js';
import { parseConversationMarkdown } from './sources/grok.js';
import { decodeUtf8, extractZipEntries } from './sources/json-utils.js';
import { parseRoleChat } from './sources/role-chat.js';
import { detectShareUrl, extractShareConversation } from './sources/share.js';
import type { CommonSession, SourceId } from './types.js';

export interface ImportOutcome {
  file: string;
  source?: SourceId;
  sessions: number;
  error?: string;
}

function isZip(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b; // 'PK'
  } catch {
    return false;
  }
}

async function parseZip(p: string, force?: SourceId): Promise<CommonSession[]> {
  // extract candidate entries in one pass: conversations.json / MyActivity.json / other json (grok official export)
  const entries = await extractZipEntries(p, (name) => name.toLowerCase().endsWith('.json'));
  const sessions: CommonSession[] = [];

  const chatgptEntry = [...entries.keys()].find((n) => n.toLowerCase().endsWith('conversations.json'));
  if (chatgptEntry) {
    for (const s of parseChatGptJson(decodeUtf8(entries.get(chatgptEntry)!))) sessions.push(s);
    if (sessions.length) return sessions;
  }

  const geminiEntry = [...entries.keys()].find((n) => /myactivity\.json$/i.test(n) && /gemini/i.test(n));
  if (geminiEntry) {
    sessions.push(...parseGeminiTakeout(decodeUtf8(entries.get(geminiEntry)!)));
    if (sessions.length) return sessions;
  }

  // remaining JSON entries: codex.json (cloud Codex tasks) or the grok official export (or the forced source)
  const roleSource: SourceId = force ?? 'grok';
  for (const [name, data] of entries) {
    if (name === chatgptEntry || name === geminiEntry) continue;
    const text = decodeUtf8(data);
    try {
      if (classifyJson(text, name).kind === 'chatgpt-codex-json') {
        sessions.push(...parseChatGptCodexJson(text));
      } else {
        sessions.push(...parseRoleChat(text, roleSource));
      }
    } catch {
      // skip non-JSON entries
    }
  }
  return sessions;
}

function parsePlainFile(p: string, force?: SourceId): CommonSession[] {
  const ext = path.extname(p).toLowerCase();
  const text = fs.readFileSync(p, 'utf8');

  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    // default to grok (the dominant output of Enhanced Grok Export and similar scripts); -s kimi overrides
    return parseConversationMarkdown(text, path.basename(p), force ?? 'grok');
  }

  // .json / .jsonl / others
  const detection = classifyJson(text, path.basename(p));
  switch (detection.kind) {
    case 'chatgpt-json':
      return [...parseChatGptJson(text)];
    case 'chatgpt-codex-json':
      return parseChatGptCodexJson(text);
    case 'gemini-takeout-json':
      try {
        return parseGeminiTakeout(text);
      } catch {
        return [];
      }
    default: {
      const source = force ?? detection.roleSource ?? 'grok';
      if (ext === '.jsonl') {
        // line-delimited objects (a plausible Kimi shape)
        const out: CommonSession[] = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            out.push(...parseRoleChat(line, source));
          } catch {
            // ignore broken lines
          }
        }
        return out;
      }
      return parseRoleChat(text, source);
    }
  }
}

/** Fetch a share-link page and parse it: HTTP fast path first (SSR pages), then headless-browser rendering (client-rendered pages) */
async function importFromUrl(db: ShiYiDb, url: string): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { file: url, sessions: 0 };
  const share = detectShareUrl(url);
  if (!share) {
    outcome.error = 'unsupported share link (supported: chatgpt.com/share, kimi.com/share, grok.com/share, share.gemini.google)';
    return outcome;
  }
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      const session = extractShareConversation(share.provider, html, share.urlId);
      if (session && session.messages.length) {
        db.upsertSession(session);
        return { ...outcome, source: session.source, sessions: 1 };
      }
    }
  } catch {
    // HTTP path failed (network/bot wall); continue with the browser path
  }

  // client-rendered page: render headlessly and extract (playwright is lazily loaded; hint when missing)
  try {
    const mod = await import('./sources/share-browser.js');
    try {
      const session = await mod.extractViaBrowser(share.provider, url, share.urlId);
      if (session) {
        db.upsertSession(session);
        return { ...outcome, source: session.source, sessions: 1 };
      }
      outcome.error = 'no conversation found after rendering (the link may be expired or require login)';
    } catch (e) {
      outcome.error = mod.isPlaywrightMissingError(e)
        ? `browser rendering required: pnpm add playwright && pnpm exec playwright install chromium (${(e as Error).message})`
        : `browser rendering failed: ${(e as Error).message}`;
    }
  } catch (e) {
    outcome.error = `browser rendering required: pnpm add playwright && pnpm exec playwright install chromium (${(e as Error).message})`;
  }
  return outcome;
}

/** Import one cloud export file (zip/md/json/jsonl) or share link, deduplicated by (source, nativeId) */
export async function importFile(db: ShiYiDb, filePath: string, force?: SourceId): Promise<ImportOutcome> {
  if (/^https?:\/\//i.test(filePath)) return importFromUrl(db, filePath);
  const outcome: ImportOutcome = { file: filePath, sessions: 0 };
  try {
    const sessions = isZip(filePath) ? await parseZip(filePath, force) : parsePlainFile(filePath, force);
    if (!sessions.length) {
      outcome.error = 'no sessions recognized (no known export format matched)';
      return outcome;
    }
    const source = force ?? sessions[0]!.source;
    for (const s of sessions) db.upsertSession(s);
    outcome.source = source;
    outcome.sessions = sessions.length;
  } catch (e) {
    outcome.error = (e as Error).message;
  }
  return outcome;
}

/** Process every new file in inbox/; successful imports move to inbox/imported/ */
export async function processInbox(db: ShiYiDb): Promise<ImportOutcome[]> {
  const dir = inboxDir();
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const outcomes: ImportOutcome[] = [];
  const importedDir = path.join(dir, 'imported');
  for (const f of files) {
    if (!f.isFile() || f.name.startsWith('.')) continue;
    const p = path.join(dir, f.name);
    const result = await importFile(db, p);
    outcomes.push(result);
    if (!result.error) {
      fs.mkdirSync(importedDir, { recursive: true });
      fs.renameSync(p, path.join(importedDir, `${new Date().toISOString().slice(0, 10)}-${f.name}`));
    }
  }
  return outcomes;
}
