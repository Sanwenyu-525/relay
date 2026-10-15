import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
/**
 * WEB_FETCH 公共网页只读适配器（M04/P17 首片，tool-adapters.md 第 3 节）。
 *
 * 边界与 FILE_READ 同构：读取幂等无副作用，类型化失败按 FAILED 结算并释放
 * claim，不产生 UNKNOWN；只接受 GET，不转发凭据/Cookie，不执行网页 JS，
 * 网页内容只是数据（UNTRUSTED_DATA，红线 12）。
 *
 * SSRF 防护（OWASP SSRF Prevention）：每一跳都重新标准化 URL、校验 scheme
 * 与连接 allowed_host、解析 DNS 并对全部返回地址做保留地址检查，然后直接
 * 连接已校验的地址（校验与连接绑定，防 DNS 重绑定）。重定向只跟随同主机。
 *
 * 源码对照缺口（按提示词要求记录）：.research/upstream/codex 的网络工具以
 * 审批门（network_approval）+ 沙箱策略约束网络访问，没有 URL/IP 级 SSRF 校验
 * 实现可复用；Pi/Vercel/LangChain 参考无满足本节准入的实现。本模块按
 * tool-adapters.md 第 3 节与 OWASP 指南自行实现，未引入第三方抓取依赖。
 */
export const WEB_TEXT_EXTRACTOR = 'web-text-extract-v1';
/** Production defaults (tool-adapters.md §3); tests may narrow them deterministically. */
export const PRODUCTION_WEB_FETCH_LIMITS = {
    maxRedirects: 3,
    hopTimeoutMs: 10_000,
    totalTimeoutMs: 30_000,
    maxBodyBytes: 5 * 1024 * 1024,
    maxTextChars: 131_072,
};
/** Connection config shape is SQL-guarded; this re-derives the typed view. */
export function readWebFetchConfig(config) {
    const host = config.allowed_host;
    if (typeof host !== 'string' || host === '') {
        throw new Error('WEB_FETCH connection config has no allowed_host');
    }
    return { allowedHost: host.toLowerCase(), allowPrivate: config.allow_private === true };
}
export async function webFetchExecute(op, invocation, options = {}) {
    const { signal, deadline } = options;
    const limits = { ...PRODUCTION_WEB_FETCH_LIMITS,
        ...(options.limits === undefined ? {} : options.limits) };
    if (signal?.aborted)
        throw new Error('Gateway dispatch aborted before web fetch');
    if (deadline !== undefined && deadline !== null && deadline.getTime() <= Date.now()) {
        return { outcome: 'FAILED',
            result: { reason: 'GATEWAY_DEADLINE_EXCEEDED', url: op.normalized_target } };
    }
    const config = readWebFetchConfig(op.connection_config);
    const budgetMs = deadline === undefined || deadline === null ? limits.totalTimeoutMs
        : Math.max(1, Math.min(limits.totalTimeoutMs, deadline.getTime() - Date.now()));
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const totalTimer = setTimeout(() => controller.abort(), budgetMs);
    try {
        const originalUrl = op.normalized_target;
        let url = new URL(originalUrl);
        for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
            const denied = validateHop(url, config);
            if (denied !== null) {
                return { outcome: 'FAILED',
                    result: { reason: 'GATEWAY_TARGET_DENIED', url: url.toString(), detail: denied } };
            }
            const resolved = await resolveAllowedAddresses(url, config);
            if (resolved.kind !== 'OK') {
                return { outcome: 'FAILED',
                    result: resolved.kind === 'DNS'
                        ? { reason: 'WEB_DNS_UNRESOLVED', url: url.toString(), error_code: resolved.code }
                        : { reason: 'GATEWAY_TARGET_DENIED', url: url.toString(),
                            address: resolved.address, detail: 'SSRF_FORBIDDEN_ADDRESS' } };
            }
            let response;
            try {
                response = await fetchHop(url, resolved.addresses[0], controller.signal, limits);
            }
            catch (error) {
                if (signal?.aborted)
                    throw new Error('Gateway dispatch aborted during web fetch');
                return { outcome: 'FAILED',
                    result: { reason: 'WEB_FETCH_UNAVAILABLE', url: url.toString(),
                        error_code: errorName(error) } };
            }
            if (isRedirectStatus(response.status)) {
                const location = response.headers.location;
                if (typeof location !== 'string' || location === '') {
                    return { outcome: 'FAILED',
                        result: { reason: 'WEB_REDIRECT_INVALID', url: url.toString(),
                            status: response.status } };
                }
                try {
                    url = new URL(location, url);
                }
                catch {
                    return { outcome: 'FAILED',
                        result: { reason: 'WEB_REDIRECT_INVALID', url: url.toString(),
                            status: response.status, location } };
                }
                continue;
            }
            return buildResult(op, invocation, response, url, originalUrl, limits);
        }
        return { outcome: 'FAILED',
            result: { reason: 'WEB_TOO_MANY_REDIRECTS', url: originalUrl, limit: limits.maxRedirects } };
    }
    finally {
        clearTimeout(totalTimer);
        signal?.removeEventListener('abort', onCallerAbort);
    }
}
function validateHop(url, config) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return 'SCHEME_NOT_ALLOWED';
    if (url.username !== '' || url.password !== '')
        return 'USERINFO_NOT_ALLOWED';
    if (url.hostname === '')
        return 'MISSING_HOST';
    if (url.hostname.toLowerCase() !== config.allowedHost)
        return 'HOST_NOT_ALLOWED';
    return null;
}
async function resolveAllowedAddresses(url, config) {
    let addresses;
    try {
        addresses = await lookup(url.hostname, { all: true, verbatim: true });
    }
    catch (error) {
        return { kind: 'DNS', code: error.code ?? 'DNS_LOOKUP_FAILED' };
    }
    if (addresses.length === 0)
        return { kind: 'DNS', code: 'DNS_EMPTY' };
    // Validate every resolved address: a round-robin that mixes public and
    // private records must not slip the private one past a first-match check.
    const forbidden = addresses.find((entry) => isForbiddenAddress(entry.address, config.allowPrivate));
    if (forbidden !== undefined)
        return { kind: 'FORBIDDEN', address: forbidden.address };
    return { kind: 'OK', addresses: addresses.map((entry) => entry.address) };
}
function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/** Connects to the validated address with SNI/Host from the URL, keeping the
 * address verification and the actual connection bound together. */
function fetchHop(url, ipAddress, signal, limits) {
    const secure = url.protocol === 'https:';
    const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
    return new Promise((resolve, reject) => {
        const transport = secure ? https : http;
        const request = transport.request({
            host: ipAddress,
            ...(secure ? { servername: url.hostname } : {}),
            port,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: { host: url.host, accept: '*/*', connection: 'close' },
            signal,
        }, (response) => {
            const declared = Number(response.headers['content-length'] ?? Number.NaN);
            if (Number.isInteger(declared) && declared > limits.maxBodyBytes) {
                response.resume();
                reject(new Error(`WEB_BODY_TOO_LARGE: ${declared}`));
                return;
            }
            const chunks = [];
            let total = 0;
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > limits.maxBodyBytes) {
                    response.destroy();
                    reject(new Error(`WEB_BODY_TOO_LARGE: ${total}`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                resolve({ status: response.statusCode ?? 0, headers: response.headers,
                    body: Buffer.concat(chunks) });
            });
            response.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(limits.hopTimeoutMs, () => {
            request.destroy(new Error('WEB_HOP_TIMEOUT'));
        });
        request.end();
    });
}
function buildResult(op, invocation, response, url, originalUrl, limits) {
    if (response.status < 200 || response.status > 299) {
        return { outcome: 'FAILED',
            result: { reason: 'WEB_HTTP_STATUS', url: originalUrl, final_url: url.toString(),
                status: response.status } };
    }
    const contentType = typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type'].split(';')[0].trim().toLowerCase() : '';
    const sha256 = createHash('sha256').update(response.body).digest('hex');
    const textAvailable = contentType.startsWith('text/') ||
        contentType === 'application/json' || contentType === 'application/xml';
    let content = null;
    let extractor = null;
    let textTruncated = false;
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
        const extracted = extractWebText(response.body.toString('utf8'));
        textTruncated = extracted.length > limits.maxTextChars;
        content = textTruncated ? extracted.slice(0, limits.maxTextChars) : extracted;
        extractor = WEB_TEXT_EXTRACTOR;
    }
    else if (textAvailable) {
        const text = response.body.toString('utf8');
        textTruncated = text.length > limits.maxTextChars;
        content = textTruncated ? text.slice(0, limits.maxTextChars) : text;
    }
    return { outcome: 'SUCCEEDED',
        result: { url: originalUrl, final_url: url.toString(), status: response.status,
            content_type: contentType, bytes: response.body.length, sha256,
            fetched_at: new Date().toISOString(), extractor, content,
            text_truncated: textTruncated, text_available: textAvailable,
            invocation_id: invocation.id, operation_id: op.id } };
}
function errorName(error) {
    if (error instanceof Error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError')
            return 'TOTAL_TIMEOUT';
        if (error.message.startsWith('WEB_'))
            return error.message.split(':')[0] ?? 'WEB_ERROR';
        return error.code ?? error.name;
    }
    return 'UNKNOWN';
}
// ---------------------------------------------------------------------------
// Reserved-address blocklist (loopback, private, link-local, CGNAT, metadata,
// multicast/reserved). IPv4-mapped IPv6 is checked as its embedded IPv4.
// ---------------------------------------------------------------------------
export function isForbiddenAddress(address, allowPrivate) {
    if (allowPrivate)
        return false;
    const version = isIP(address);
    if (version === 4)
        return isForbiddenV4(address);
    if (version === 6)
        return isForbiddenV6(address);
    // Not a literal IP; treat unparseable resolver output as forbidden.
    return true;
}
function v4ToNumber(address) {
    const parts = address.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) ||
        part < 0 || part > 255))
        return -1;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function inV4Range(address, prefix, bits) {
    const base = v4ToNumber(prefix);
    const value = v4ToNumber(address);
    if (base < 0 || value < 0)
        return false;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
}
function isForbiddenV4(address) {
    return inV4Range(address, '0.0.0.0', 8) ||
        inV4Range(address, '10.0.0.0', 8) ||
        inV4Range(address, '100.64.0.0', 10) ||
        inV4Range(address, '127.0.0.0', 8) ||
        inV4Range(address, '169.254.0.0', 16) ||
        inV4Range(address, '172.16.0.0', 12) ||
        inV4Range(address, '192.0.0.0', 24) ||
        inV4Range(address, '192.0.2.0', 24) ||
        inV4Range(address, '192.88.99.0', 24) ||
        inV4Range(address, '192.168.0.0', 16) ||
        inV4Range(address, '198.18.0.0', 15) ||
        inV4Range(address, '198.51.100.0', 24) ||
        inV4Range(address, '203.0.113.0', 24) ||
        inV4Range(address, '224.0.0.0', 4) ||
        inV4Range(address, '240.0.0.0', 4);
}
function isForbiddenV6(address) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1')
        return true;
    if (value.startsWith('::ffff:')) {
        const embedded = value.slice(7);
        // Node renders mapped IPv4 as ::ffff:a.b.c.d; hex form also occurs.
        if (isIP(embedded) === 4)
            return isForbiddenV4(embedded);
        if (/^::ffff:[0-9a-f]{1,4}:([0-9a-f]{1,4})?$/u.test(value)) {
            const hex = value.slice(7).replaceAll(':', '');
            const high = parseInt(hex.slice(0, 4) ?? '0', 16);
            const low = parseInt(hex.slice(4, 8) ?? '0', 16);
            return isForbiddenV4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
        }
        return false;
    }
    const first = value.split(':')[0] ?? '';
    if (first === '')
        return false;
    const head = parseInt(first, 16);
    if (Number.isNaN(head))
        return true;
    if ((head & 0xfe00) === 0xfc00)
        return true; // fc00::/7 unique local
    if ((head & 0xffc0) === 0xfe80)
        return true; // fe80::/10 link-local
    if ((head & 0xff00) === 0xff00)
        return true; // ff00::/8 multicast
    if (value.startsWith('2001:db8:'))
        return true; // documentation
    if (value.startsWith('2001:0:'))
        return true; // teredo / 2001::/32
    return false;
}
// ---------------------------------------------------------------------------
// Deterministic text extraction for HTML bodies (web-text-extract-v1).
// ---------------------------------------------------------------------------
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
    trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
    ldquo: '\u201C', rdquo: '\u201D', laquo: '«', raquo: '»', middot: '·', bull: '•',
    times: '×', divide: '÷', plusmn: '±', deg: '°', sect: '§', para: '¶', euro: '€',
    pound: '£', yen: '¥', cent: '¢', sup2: '²', sup3: '³', frac12: '½', frac14: '¼',
    frac34: '¾', alpha: 'α', beta: 'β', gamma: 'γ', pi: 'π', mu: 'μ', omega: 'ω',
};
export function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (match, body) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        if (body.startsWith('#')) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
}
/** Strips comments, script/style blocks and tags, decodes entities and
 * collapses whitespace. Structure/semantics are NOT preserved on purpose:
 * the output is evidence text, not a rendering. */
export function extractWebText(html) {
    const text = html
        .replace(/<!--[\s\S]*?-->/gu, ' ')
        .replace(/<(script|style|noscript|svg|template|head|iframe|object)\b[\s\S]*?<\/\1\s*>/giu, ' ')
        .replace(/<\/(p|div|section|article|header|footer|main|aside|li|tr|dl|dt|dd|h[1-6]|ul|ol|table|blockquote|pre|form|fieldset|figure|figcaption)\s*>/giu, '\n')
        .replace(/<br\s*\/?>/giu, '\n')
        .replace(/<[^>]+>/gu, ' ');
    const decoded = decodeEntities(text);
    return decoded
        .split(/[ \t\r\f\v]+/u).join(' ')
        .replace(/ ?\n ?/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}
