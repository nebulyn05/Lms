const RAW_TARGET_URL = process.env.TARGET_URL || 'https://lms.rocket-soft.org';
const BUILD_MARKER = 'node-handler-body-read-fix-2026-10-23';
const FROM = 'Rocket';
const TO = 'YourBrand';
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 25000;
const BLOCKED_BRAND_ASSET_PATH = /(?:^|\/)logo\.svg$/i;
const FAVICON_PATH = /(?:^|\/)(?:favicon(?:[-_]\d+x\d+)?\.(?:ico|png|jpe?g|gif|svg|webp)|favicon\/[^/?#]+\.(?:ico|png|jpe?g|gif|svg|webp)|apple-touch-icon(?:-\d+x\d+)?\.png|icon-\d+x\d+\.png)$/i;

const TARGET = (() => {
  const raw = String(RAW_TARGET_URL).trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TARGET_URL must use http or https');
  return url;
})();

function incomingUrl(request) {
  return new URL(String(request.url || '/'), 'http://vercel.local');
}

function upstreamUrl(request) {
  const incoming = incomingUrl(request);
  return new URL(TARGET.origin + incoming.pathname + incoming.search);
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*Domain=[^;]*/i, '')
    .replace(/;\s*SameSite=None/i, '; SameSite=Lax');
}

function copyHeaders(upstream) {
  const out = new Headers();
  const blocked = new Set([
    'connection','keep-alive','proxy-authenticate','proxy-authorization',
    'te','trailer','transfer-encoding','upgrade','host','content-length',
    'content-encoding','location','set-cookie'
  ]);
  for (const [name, value] of upstream.headers) {
    if (!blocked.has(name.toLowerCase())) out.set(name, value);
  }
  return out;
}

function readIncomingBody(request) {
  if (request.body == null) {
    const length = Number(request.headers?.['content-length'] || 0);
    const hasTransferEncoding = Boolean(request.headers?.['transfer-encoding']);
    if (length <= 0 && !hasTransferEncoding) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }
  if (Buffer.isBuffer(request.body)) return Promise.resolve(request.body);
  if (typeof request.body === 'string') return Promise.resolve(request.body);
  // Vercel's Node request parser may already have parsed JSON/form bodies.
  if (typeof request.body === 'object') {
    const contentType = String(request.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return Promise.resolve(new URLSearchParams(request.body).toString());
    }
    return Promise.resolve(JSON.stringify(request.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readBodyOnce(response, log) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        chunks.push(Buffer.from(value));
        totalBytes += value.byteLength;
        if (totalBytes === value.byteLength) {
          log('body_first_chunk', { bytes: value.byteLength });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  log('body_read_complete', { bytes: totalBytes });
  return Buffer.concat(chunks, totalBytes);
}

export const runtime = 'nodejs';
export const maxDuration = 60;

// @vercel/node expects the Node (req, res) handler signature. Do not return
// a Web Response from this handler: the Node runtime ignores that return value.
export default async function handler(request, response) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const log = (event, extra = {}) => console.log(JSON.stringify({
    requestId, event, build: BUILD_MARKER, elapsedMs: Date.now() - started, ...extra
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let upstream;

  try {
    const original = upstreamUrl(request);
    const method = String(request.method || 'GET').toUpperCase();
    let currentMethod = method;
    let currentBody = ['GET', 'HEAD'].includes(method) ? undefined : await readIncomingBody(request);
    let current = original;
    const cookieJar = [];
    const pathname = incomingUrl(request).pathname;

    log('proxy_start', { method, path: pathname, upstreamUrl: original.toString() });

    // Suppress upstream branding assets consistently, including requests made
    // directly by login pages rather than only links in the document head.
    if (FAVICON_PATH.test(pathname) || BLOCKED_BRAND_ASSET_PATH.test(pathname)) {
      log('brand_asset_blocked', { path: pathname });
      response.writeHead(204, { 'cache-control': 'public, max-age=3600' });
      response.end();
      return;
    }

    for (let redirectNumber = 0; redirectNumber <= MAX_REDIRECTS; redirectNumber++) {
      log('fetch_before', { url: current.toString(), redirectNumber });
      const fetchHeaders = new Headers();
      for (const name of ['accept', 'accept-language', 'content-type', 'user-agent', 'cookie', 'authorization']) {
        const value = request.headers?.[name];
        if (typeof value === 'string' && value) fetchHeaders.set(name, value);
      }

      upstream = await fetch(current, {
        method: currentMethod,
        headers: fetchHeaders,
        body: currentBody,
        redirect: 'manual',
        signal: controller.signal
      });

      log('fetch_after', {
        status: upstream.status,
        location: upstream.headers.get('location'),
        contentType: upstream.headers.get('content-type'),
        redirectNumber
      });

      const cookies = typeof upstream.headers.getSetCookie === 'function'
        ? upstream.headers.getSetCookie()
        : [];
      for (const cookie of cookies) {
        const pair = cookie.split(';', 1)[0];
        const name = pair.split('=', 1)[0];
        const index = cookieJar.findIndex(existing => existing.split('=', 1)[0] === name);
        if (index >= 0) cookieJar[index] = pair;
        else cookieJar.push(pair);
      }

      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get('location');
      if (!location) break;

      const next = new URL(location, current);
      if (next.origin !== TARGET.origin) {
        log('redirect_blocked_external', { location: next.toString() });
        break;
      }

      // Match browser redirect semantics: POST + 301/302 and non-HEAD + 303
      // become GET. Only 307/308 preserve the original method and body.
      if ((upstream.status === 301 || upstream.status === 302) && currentMethod === 'POST') {
        currentMethod = 'GET';
        currentBody = undefined;
      } else if (upstream.status === 303 && currentMethod !== 'HEAD') {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      current = next;
    }

    const headers = copyHeaders(upstream);
    const finalCookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];
    for (const cookie of finalCookies) headers.append('set-cookie', rewriteCookie(cookie));

    // Expose cookies encountered during same-origin redirects as separate cookies.
    for (const pair of cookieJar) {
      headers.append('set-cookie', rewriteCookie(pair + '; Path=/'));
    }

    const location = upstream.headers.get('location');
    if (location) {
      const next = new URL(location, current);
      headers.set('location', next.origin === TARGET.origin
        ? next.pathname + next.search + next.hash
        : next.toString());
    }

    const headerSnapshot = {};
    for (const [name, value] of upstream.headers) {
      if (['content-length','content-encoding','transfer-encoding','connection','cache-control','server'].includes(name.toLowerCase())) {
        headerSnapshot[name] = value;
      }
    }
    log('body_inspect', { headers: headerSnapshot, finalUrl: current.toString() });

    let body = method === 'HEAD' ? Buffer.alloc(0) : await readBodyOnce(upstream, log);

    // Rebrand textual upstream responses without touching binary assets.
    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    const isTextual = /^(text\\/|application\\/(?:json|javascript|x-javascript|xml|xhtml\\+xml|graphql|ld\\+json))/.test(contentType);
    if (body.length && FROM && isTextual) {
      const originalText = body.toString('utf8');
      const brandedText = originalText.split(FROM).join(TO);
      if (brandedText !== originalText) {
        body = Buffer.from(brandedText, 'utf8');
        log('brand_text_replaced', { from: FROM, to: TO, contentType, bodyBytes: body.byteLength });
      }
    }
    const responseHeaders = Object.fromEntries(headers.entries());
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (setCookies.length) responseHeaders['set-cookie'] = setCookies;

    log('response_ready', {
      status: upstream.status,
      finalUrl: current.toString(),
      contentType: upstream.headers.get('content-type'),
      bodyBytes: body.byteLength
    });

    response.writeHead(upstream.status, upstream.statusText, responseHeaders);
    response.end(body);
  } catch (error) {
    log('failure', {
      errorName: error?.name,
      errorMessage: error?.name === 'AbortError'
        ? `Upstream request/body exceeded ${REQUEST_TIMEOUT_MS}ms timeout`
        : error?.message,
      stack: error?.stack
    });

    if (!response.headersSent) {
      response.statusCode = error?.name === 'AbortError' ? 504 : 502;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        error: 'Proxy failure',
        message: error?.name === 'AbortError'
          ? `Upstream request/body exceeded ${REQUEST_TIMEOUT_MS}ms timeout`
          : error?.message || 'Unknown error',
        requestId
      }));
    } else {
      response.destroy(error);
    }
  } finally {
    clearTimeout(timer);
  }
}
