import fs from 'node:fs';
import path from 'node:path';
import { localSourceRoots } from '../paths.js';
import { truncate, type CommonMessage, type CommonSession, type LocalSourceAdapter, type LocalSourceFile } from '../types.js';

interface GeminiChat {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: Array<{ type?: string; content?: unknown; timestamp?: string }>;
}

/** Gemini CLI local sessions: ~/.gemini/tmp/<project>/chats/session-*.json (pretty-printed JSON) */
export class GeminiCliAdapter implements LocalSourceAdapter {
  readonly source = 'gemini-cli' as const;

  watchRoots(): string[] {
    return [localSourceRoots().geminiCli];
  }

  acceptsPath(p: string): boolean {
    return p.startsWith(localSourceRoots().geminiCli) && p.endsWith('.json');
  }

  listFiles(): LocalSourceFile[] {
    const root = localSourceRoots().geminiCli;
    const files: LocalSourceFile[] = [];
    let projectDirs: string[];
    try {
      projectDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
    } catch {
      return files;
    }
    for (const dir of projectDirs) {
      const chatsDir = path.join(dir, 'chats');
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(chatsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const p = path.join(chatsDir, e.name);
        const st = fs.statSync(p);
        files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return files;
  }

  async parseFile(filePath: string): Promise<CommonSession | null> {
    let chat: GeminiChat;
    try {
      chat = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GeminiChat;
    } catch {
      return null;
    }
    const messages: CommonMessage[] = [];
    for (const m of chat.messages ?? []) {
      if (m.type === 'user' || m.type === 'model') {
        const text = typeof m.content === 'string' ? m.content.trim() : '';
        if (text) messages.push({ role: m.type === 'user' ? 'user' : 'assistant', content: text, createdAt: m.timestamp });
      }
    }
    if (!messages.length) return null;

    const nativeId = chat.sessionId ?? path.basename(filePath, '.json');
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    return {
      nativeId,
      source: this.source,
      title: truncate(firstUser, 60) || '（无标题）',
      project: path.basename(path.dirname(path.dirname(filePath))),
      startedAt: chat.startTime ?? messages[0]?.createdAt,
      endedAt: chat.lastUpdated ?? messages[messages.length - 1]?.createdAt,
      messages,
    };
  }
}
