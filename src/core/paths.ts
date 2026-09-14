import os from 'node:os';
import path from 'node:path';

/** shiyi's own data directory (database etc.); SHIYI_HOME overrides */
export function shiyiHome(): string {
  return process.env.SHIYI_HOME ?? path.join(os.homedir(), '.shiyi');
}

export function dbPath(): string {
  return process.env.SHIYI_DB ?? path.join(shiyiHome(), 'shiyi.db');
}

/** drop directory for cloud export packages */
export function inboxDir(): string {
  return process.env.SHIYI_INBOX ?? path.join(shiyiHome(), 'inbox');
}

/** root directories of the local session sources */
export function localSourceRoots(): Record<'claude' | 'codex' | 'geminiCli', string> {
  const home = os.homedir();
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    geminiCli: path.join(home, '.gemini', 'tmp'),
  };
}

export function codexArchiveDir(): string {
  return path.join(os.homedir(), '.codex', 'archived_sessions');
}
