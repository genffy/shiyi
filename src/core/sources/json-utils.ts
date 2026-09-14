import crypto from 'node:crypto';
import fs from 'node:fs';
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';

/** Stream-extract matching entries from a zip (no full inflate) */
export function extractZipEntries(zipPath: string, wanted: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, Uint8Array>();
    let pending = 0;
    let settled = false;

    const uz = new Unzip((file: UnzipFile) => {
      if (!wanted(file.name)) return;
      pending++;
      const chunks: Uint8Array[] = [];
      file.ondata = (err, data, final) => {
        if (err) {
          if (!settled) {
            settled = true;
            reject(new Error(`zip entry ${file.name} failed to inflate: ${err.message}`));
          }
          return;
        }
        chunks.push(data);
        if (final) {
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          out.set(file.name, merged);
          pending--;
        }
      };
      file.start();
    });
    uz.register(UnzipInflate);

    const rs = fs.createReadStream(zipPath);
    rs.on('data', (c) => {
      if (!settled) uz.push(c as Buffer, false);
    });
    rs.on('end', () => {
      if (settled) return;
      uz.push(new Uint8Array(0), true);
      const waitFor = () => {
        if (settled) return;
        if (pending === 0) {
          settled = true;
          resolve(out);
        } else {
          setTimeout(waitFor, 20);
        }
      };
      setTimeout(waitFor, 20);
    });
    rs.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

export function decodeUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

/**
 * Strip inline markup embedded in OpenAI/Codex text: wrapped by private-use chars
 * (U+E200..E2FF), e.g. \ue200entity\ue202["software","Electron",0]\ue201.
 * Remove complete spans first, then any leftover private-use chars.
 */
export function cleanInlineMarkup(text: string): string {
  return text
    .replace(/\ue200[^\ue201]*\ue201/g, '')
    .replace(/[\ue200-\ue2ff]/g, '');
}

/**
 * Split the elements of a top-level JSON array in a streaming fashion: scan balanced braces
 * (string-aware) and JSON.parse one element at a time, avoiding a single giant parse
 * (ChatGPT exports can exceed 1GB).
 */
export function* iterJsonArray(text: string): Generator<Record<string, unknown>> {
  let i = text.indexOf('[');
  if (i === -1) throw new Error('JSON array start not found');
  i++;
  const n = text.length;
  while (i < n) {
    // skip whitespace and commas
    while (i < n && /[\s,]/.test(text[i]!)) i++;
    if (i >= n || text[i] === ']') return;
    if (text[i] !== '{') throw new Error(`array element is not an object (offset ${i})`);
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    while (i < n) {
      const ch = text[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      i++;
    }
    if (depth !== 0) throw new Error('JSON array not closed');
    yield JSON.parse(text.slice(start, i)) as Record<string, unknown>;
  }
}

/** Stable id: sessions without a native id dedupe via a content hash */
export function stableId(...parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

/** Normalize assorted time fields to ISO 8601 */
export function toIso(t: unknown): string | undefined {
  if (t == null) return undefined;
  if (typeof t === 'number') {
    const ms = t > 1e12 ? t : t > 1e9 ? t * 1000 : NaN;
    if (!Number.isFinite(ms)) return undefined;
    return new Date(ms).toISOString();
  }
  if (typeof t === 'string') {
    if (/^\d+$/.test(t)) return toIso(Number(t));
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}
