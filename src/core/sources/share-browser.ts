import type { CommonMessage, CommonSession } from '../types.js';
import { parseKimiShareApi, providerSource, type ShareProvider } from './share.js';

/** rendered message-container selectors per provider (wait conditions); grok uses API interception and needs no DOM wait */
const WAIT_SELECTORS: Record<ShareProvider, string> = {
  chatgpt: '[data-message-author-role]',
  kimi: '.share-content-list .segment',
  gemini: '.user-query-container, [class*="response-container"]',
  grok: '[data-testid="primaryColumn"]',
};

/** In-X Grok share page (x.com/i/grok/share):
 *  neither the initial HTML nor __INITIAL_STATE__ carries the conversation (hydration fetches it via
 *  page-authenticated GraphQL); calling api.x.com directly fails with Bad Authentication data, so the
 *  GrokShare response is intercepted in the page context instead */
interface GrokShareApi {
  data?: {
    grokShare?: {
      items?: Array<{
        message?: string;
        sender?: string;
        thinking_trace?: string;
        deepsearch_headers?: string;
      }>;
    };
  };
}

function cleanGrokMessage(text: string): string {
  return text
    .replace(/<\/?(grok|xai):[^>]+>/g, '')
    .replace(/<\/?argument(?:\s[^>]*)?>/g, '') // citation markers, e.g. <argument name="citation_id">2</argument>
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractGrokViaApi(
  page: import('playwright').Page,
  responsePromise: Promise<import('playwright').Response | null>
): Promise<CommonMessage[]> {
  const messages: CommonMessage[] = [];
  const res = await responsePromise;
  if (!res) return [];
  try {
    const body = (await res.json()) as GrokShareApi;
    for (const item of body.data?.grokShare?.items ?? []) {
      const role = item.sender === 'User' ? 'user' : item.sender === 'Agent' ? 'assistant' : null;
      const text = cleanGrokMessage(item.message ?? '');
      if (!role || !text) continue;
      const thinking = item.thinking_trace ? cleanGrokMessage(item.thinking_trace) : '';
      messages.push(thinking ? { role, content: text, thinking } : { role, content: text });
    }
  } catch {
    // unexpected response shape
  }
  return messages;
}

/**
 * In-page extraction logic, executed in the browser context as function-source strings (returns {title, segs, date?}).
 * Selectors verified against real share pages in 2026-09:
 * - chatgpt: the rendered DOM keeps data-message-author-role markers
 * - kimi: .segment-user / .segment-assistant alternate under .share-content-list
 * - gemini: outermost .user-query-container (strip the "You said" prefix) / .response-container
 */
const EXTRACTOR_SOURCES: Record<ShareProvider, string> = {
  chatgpt: `(function () {
    const segs = [];
    for (const el of document.querySelectorAll('[data-message-author-role]')) {
      const role = el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant';
      const text = (el.innerText || '').trim();
      if (text) segs.push({ role, text });
    }
    return { title: document.title.trim(), segs };
  })`,
  kimi: `(function () {
    const segs = [];
    for (const seg of document.querySelectorAll('.share-content-list .segment')) {
      const cls = typeof seg.className === 'string' ? seg.className : '';
      const role = /segment-user/.test(cls) ? 'user' : /segment-assistant/.test(cls) ? 'assistant' : '';
      if (!role) continue;
      const box = seg.querySelector('.segment-content-box, .segment-content');
      let text = box ? box.innerText : seg.innerText || '';
      text = text.replace(/^Used \\d+ tools,?\\s*/m, '');
      text = text
        .split('\\n')
        .filter((l) => !/^(Content-Type|Cache-Control|Transfer-Encoding|Content-Disposition):/.test(l))
        .join('\\n')
        .trim();
      if (text) segs.push({ role, text });
    }
    const titleEl = document.querySelector('.share-title');
    return { title: titleEl ? titleEl.textContent.trim() : document.title.trim(), segs };
  })`,
  gemini: `(function () {
    const outermost = (el, clsRe) => {
      let p = el.parentElement;
      while (p) {
        if (clsRe.test(typeof p.className === 'string' ? p.className : '')) return false;
        p = p.parentElement;
      }
      return true;
    };
    const userRe = /user-query-container/;
    const respRe = /(^|\\s)response-container(\\s|$)/;
    const segs = [];
    for (const el of document.querySelectorAll('.user-query-container, [class*="response-container"]')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const isUser = userRe.test(cls);
      const isResp = respRe.test(cls);
      if (!isUser && !isResp) continue;
      if (!outermost(el, isUser ? userRe : respRe)) continue;
      let t = (el.innerText || '').trim();
      if (isUser) {
        t = t.replace(/^(You said|你说)[:：]?\\s*/, '');
        const parts = t.split('\\n\\n');
        if (parts.length === 2 && parts[0].trim() === parts[1].trim()) t = parts[0].trim();
      }
      if (t) segs.push({ role: isUser ? 'user' : 'assistant', text: t });
    }
    let title = '';
    const h1 = document.querySelector('h1');
    if (h1) title = ((h1.innerText || '').split('\\n')[0] || '').trim();
    const body = document.body.innerText || '';
    let date;
    const en = body.match(/Created with [^\\n]*?\\b([A-Z][a-z]+ \\d{1,2}, \\d{4})/);
    const zh = body.match(/(\\d{4})年(\\d{1,2})月(\\d{1,2})日/);
    if (en) date = en[1];
    else if (zh) date = zh[1] + '-' + String(zh[2]).padStart(2, '0') + '-' + String(zh[3]).padStart(2, '0');
    return { title, segs, date };
  })`,
  grok: `(function () {
    const segs = [];
    for (const el of document.querySelectorAll('[class*="message-"], .conversation-turn')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const role = /user|human/i.test(cls) ? 'user' : /assistant|grok|ai/i.test(cls) ? 'assistant' : '';
      const text = (el.innerText || '').trim();
      if (role && text) segs.push({ role, text });
    }
    return { title: document.title.trim(), segs };
  })`,
};

interface ExtractResult {
  title: string;
  segs: Array<{ role: string; text: string }>;
  date?: string;
}

function toIsoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*https:\/\/\S+/g, '')
    .replace(/\s*(Created|Published)[^\n]*$/i, '')
    .replace(/\s*[|-]\s*(ChatGPT|Kimi|Grok|Gemini)\s*$/i, '')
    .trim();
}

/**
 * Render a share page headlessly and extract the conversation (the fully automatic path for client-rendered pages).
 * Requires playwright + chromium (pnpm add playwright && pnpm exec playwright install chromium).
 */
export async function extractViaBrowser(provider: ShareProvider, url: string, urlId: string): Promise<CommonSession | null> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });
    // grok's GraphQL fires the instant navigation starts; the listener must be registered before goto
    const grokResponse = page
      .waitForResponse((res) => /\/graphql\/.+\/GrokShare/.test(res.url()) && res.status() === 200, {
        timeout: 20000,
      })
      .catch(() => null);
    // kimi fetches conversation data via the GetChatShare XHR (markdown source + separated thinking); listen early too
    const kimiResponse =
      provider === 'kimi'
        ? page
            .waitForResponse((res) => /ChatService\/GetChatShare/.test(res.url()) && res.status() === 200, {
              timeout: 20000,
            })
            .catch(() => null)
        : null;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(WAIT_SELECTORS[provider]!, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500); // let the message stream finish rendering

    let messages: CommonMessage[] = [];
    let title = '';
    let date: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    if (provider === 'grok') {
      messages = await extractGrokViaApi(page, grokResponse);
      if (!messages.length) {
        // fallback: DOM extraction when API interception fails
        const data = (await page.evaluate(`(${EXTRACTOR_SOURCES.grok!})()`)) as ExtractResult;
        messages = (data.segs ?? [])
          .filter((s) => s.role === 'user' || s.role === 'assistant')
          .map((s) => ({ role: s.role as 'user' | 'assistant', content: s.text }));
      }
      title = messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? '';
    } else if (provider === 'kimi' && kimiResponse) {
      const res = await kimiResponse;
      const session = res ? parseKimiShareApi(await res.json(), urlId) : null;
      if (session) {
        messages = session.messages;
        title = session.title;
        startedAt = session.startedAt;
        endedAt = session.endedAt;
      }
      if (!messages.length) {
        // fallback: DOM extraction when API interception fails (no thinking separation; rendered text only)
        const data = (await page.evaluate(`(${EXTRACTOR_SOURCES.kimi!})()`)) as ExtractResult;
        messages = (data.segs ?? [])
          .filter((s) => s.role === 'user' || s.role === 'assistant')
          .map((s) => ({ role: s.role as 'user' | 'assistant', content: s.text }));
        title = data.title;
        date = data.date;
      }
    } else {
      const data = (await page.evaluate(`(${EXTRACTOR_SOURCES[provider]!})()`)) as ExtractResult;
      messages = (data.segs ?? [])
        .filter((s) => s.role === 'user' || s.role === 'assistant')
        .map((s) => ({ role: s.role as 'user' | 'assistant', content: s.text }));
      title = data.title;
      date = data.date;
    }
    if (!messages.length) return null;

    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    startedAt ??= toIsoDate(date);
    endedAt ??= startedAt;
    return {
      nativeId: `share-${urlId}`,
      source: providerSource(provider),
      title: cleanTitle(title) || firstUser.slice(0, 60) || '(untitled)',
      startedAt,
      endedAt,
      messages,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function isPlaywrightMissingError(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  return /playwright|Executable doesn't exist|Run "playwright install/i.test(msg);
}
