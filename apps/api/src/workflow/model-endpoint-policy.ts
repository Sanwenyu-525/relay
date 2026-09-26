import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ConfigError } from '../config/config.js';

export const DEFAULT_MODEL_BASE_URL = 'https://api.openai.com/v1';

/** A process-configured compatible endpoint is a single HTTPS origin and API path. */
export function parseModelBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ConfigError(['RELAY_MODEL_BASE_URL must be an absolute https URL']); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.hash !== '' || url.search !== '' || isIP(url.hostname) !== 0 ||
      url.hostname.endsWith('.') || !url.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid)$/iu.test(url.hostname)) {
    throw new ConfigError(['RELAY_MODEL_BASE_URL must be a public https host without credentials, query or fragment']);
  }
  return url.href.replace(/\/$/u, '');
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  return /^[23]/u.test(normalized) && !normalized.startsWith('2001:db8:') &&
    !normalized.startsWith('2001:0:') && !normalized.startsWith('2002:');
}

export interface ModelFetchDependencies {
  readonly fetch?: typeof fetch;
  readonly lookup?: (hostname: string) => Promise<readonly {
    address: string; family: number }[]>;
}

/** Redirects are rejected before fetch follows them; every SDK request must stay
 * under the configured API path. DNS is rechecked immediately before fetch.
 * The resolution and socket connect are not atomic, so this does not claim to
 * defend an operator-configured hostile DNS name against rebinding. */
export function guardedModelFetch(baseUrl: string,
  dependencies: ModelFetchDependencies = {}): typeof fetch {
  const allowed = new URL(baseUrl);
  const pathPrefix = allowed.pathname.replace(/\/$/u, '');
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== allowed.origin ||
        !(target.pathname === pathPrefix || target.pathname.startsWith(`${pathPrefix}/`)) ||
        target.username !== '' || target.password !== '' || target.hash !== '') {
      throw new Error('MODEL_ENDPOINT_NOT_ALLOWED');
    }
    const addresses = await (dependencies.lookup ??
      ((hostname: string) => lookup(hostname, { all: true })))(allowed.hostname);
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new Error('MODEL_ENDPOINT_NOT_PUBLIC');
    }
    const response = await (dependencies.fetch ?? fetch)(input, { ...init, redirect: 'error' });
    const finalUrl = response.url === '' ? null : new URL(response.url);
    if ((response.status >= 300 && response.status < 400) || response.redirected ||
        (finalUrl !== null && (finalUrl.origin !== allowed.origin ||
          !(finalUrl.pathname === pathPrefix ||
            finalUrl.pathname.startsWith(`${pathPrefix}/`))))) {
      throw new Error('MODEL_ENDPOINT_REDIRECTED');
    }
    return response.body !== null && response.headers.get('content-type')
      ?.toLowerCase().includes('text/event-stream') === true
      ? requireCompleteSse(response) : response;
  };
}

/** The SDK's ChatOpenAI.stream can otherwise accept a clean EOF with only a
 * partial SSE reply. Require the protocol's terminal marker before exposing
 * the stream as a completed model response. */
function requireCompleteSse(response: Response): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let doneMarker = false;
  const scan = (text: string): void => {
    pending += text;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      if (pending.slice(0, newline).trim() === 'data: [DONE]') doneMarker = true;
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
    if (pending.length > 2 * 1024 * 1024) throw new Error('MODEL_SSE_LINE_TOO_LARGE');
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          scan(decoder.decode());
          if (pending.trim() === 'data: [DONE]') doneMarker = true;
          if (!doneMarker) throw new Error('MODEL_STREAM_INCOMPLETE');
          controller.close();
          return;
        }
        scan(decoder.decode(next.value, { stream: true }));
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText,
    headers: response.headers });
}
