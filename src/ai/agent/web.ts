import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_PAGE_BYTES = 1_500_000;
const MAX_PAGE_TEXT = 6_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type WebSearchResult = { title: string; url: string; snippet: string };

export type WebTools = {
  searchAvailable(): boolean;
  search(query: string): Promise<WebSearchResult[]>;
  readPage(url: string): Promise<{ url: string; title: string; text: string }>;
};

function ipv4Blocked(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isBlockedAddress(ip: string) {
  if (isIP(ip) === 4) return ipv4Blocked(ip);
  const value = ip.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('ff')
  );
}

async function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https pages can be read.');
  }
  if (url.username || url.password) {
    throw new Error('Web addresses with credentials are not allowed.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('Only standard web ports can be read.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/(^|\.)(localhost|internal|local|ts\.net)$/i.test(host)) {
    throw new Error('Private network addresses cannot be read.');
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error('Private network addresses cannot be read.');
  }
  return url;
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function htmlToText(html: string) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = html
    .replace(/<(head|script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

async function readLimited(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export async function readWebPage(raw: string, fetchImpl: typeof fetch = fetch) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'KODEX-Assistant/1.0 (+https://tmctechsolutions.com)',
        Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!next) throw new Error('The page redirected without an address.');
      url = await assertPublicUrl(new URL(next, url).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The page answered with status ${response.status}.`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (!/text\/|json|xml/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('That address is not a readable web page.');
    }
    const raw = await readLimited(response);
    const parsed = /html/i.test(type) ? htmlToText(raw) : { title: '', text: raw };
    return {
      url: url.toString(),
      title: parsed.title,
      text: parsed.text.slice(0, MAX_PAGE_TEXT),
    };
  }
  throw new Error('The page redirected too many times.');
}

function readResults(body: unknown): WebSearchResult[] {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const list = Array.isArray(root.results) ? root.results : Array.isArray(body) ? body : [];
  return list
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
      return {
        title: text(row.title),
        url: text(row.url) || text(row.link),
        snippet: (text(row.snippet) || text(row.content) || text(row.description)).slice(0, 400),
      };
    })
    .filter((row) => row.url)
    .slice(0, 6);
}

/** Search is provider-agnostic: KODEX_WEB_SEARCH_URL receives POST { query } and returns { results: [{ title, url, snippet }] }. */
export function createWebTools(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): WebTools {
  const searchUrl = env.KODEX_WEB_SEARCH_URL?.trim() ?? '';
  const searchToken = env.KODEX_WEB_SEARCH_TOKEN?.trim() || env.KODEX_TOKEN?.trim() || '';
  return {
    searchAvailable: () => Boolean(searchUrl),
    async search(query) {
      if (!searchUrl) throw new Error('Web search is not connected yet.');
      const response = await fetchImpl(searchUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'Content-Type': 'application/json',
          ...(searchToken ? { Authorization: `Bearer ${searchToken}` } : {}),
        },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) throw new Error(`Web search failed (${response.status}).`);
      return readResults(await response.json().catch(() => null));
    },
    readPage: (url) => readWebPage(url, fetchImpl),
  };
}
