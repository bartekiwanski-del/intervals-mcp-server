import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const SCOPE = 'garmin:read';
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 86400;
const COOKIE = '__Host-garmin-login';
const random = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

function configurationIssues(config) {
  const fields = [
    ['MCP_SIGNING_KEY', config.signingKey, 40],
    ['MCP_LOGIN_PASSWORD', config.password, 16, 256],
    ['GARMIN_PERSONAL_API_KEY', config.garminKey, 10],
  ];
  return fields.flatMap(([field, value, minimum, maximum]) => {
    if (typeof value !== 'string' || !value || value.startsWith('__SET_')) return [{field, reason:'not_set'}];
    if (value.length < minimum) return [{field, reason:'too_short', minimum}];
    if (maximum && value.length > maximum) return [{field, reason:'too_long', maximum}];
    return [];
  });
}

const securityHeaders = {
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'x-content-type-options': 'nosniff',
  // no-referrer makes browser form POSTs send Origin: null, breaking the CSRF check.
  // same-origin preserves that check and omits referrers on the ChatGPT redirect.
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...securityHeaders, 'content-type':'application/json', ...extra } });
}

function page(title, body, status = 200, extra = {}) {
  return new Response(`<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:17px/1.55 system-ui,sans-serif;background:#f3f5f6;color:#142c35;margin:0;padding:24px}main{max-width:460px;margin:8vh auto;background:white;padding:32px;border-radius:18px;box-shadow:0 8px 40px #142c3510}h1{font-size:28px;line-height:1.2}p{color:#4b5e65}label{display:block;font-weight:600}input{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px;margin:8px 0 22px;border:1px solid #a9b7bc;border-radius:8px}button{font:inherit;padding:12px 18px;border:0;border-radius:8px;background:#176a58;color:white;cursor:pointer;width:100%}small{display:block;margin-top:18px;color:#65777d}code{overflow-wrap:anywhere}</style><main><h1>${escape(title)}</h1>${body}</main></html>`, { status, headers: { ...securityHeaders, 'content-type':'text/html; charset=utf-8', ...extra } });
}

function allowedRedirect(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.hash && !url.search &&
      (value === 'https://chatgpt.com/connector_platform_oauth_redirect' || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(value));
  } catch { return false; }
}

function parseParams(request, raw) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('invalid_request');
  const params = new URLSearchParams(raw);
  for (const name of new Set(params.keys())) if (params.getAll(name).length !== 1) throw new Error('invalid_request');
  return params;
}

function readCookie(request) {
  return (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
}

/** Single-owner gateway. Authenticated confidential OAuth clients use PKCE.
 * Registrations and tokens survive a restart; short-lived authorization codes do not.
 * Access is revoked globally by replacing the login password or signing key.
 */
export function createApplication(config, { mcpHandler, now = () => Date.now() } = {}) {
  const base = config.baseUrl.replace(/\/$/, '');
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.origin !== base) throw new Error('PUBLIC_URL must be an HTTPS origin');
  const resource = base + '/mcp';
  const issues = configurationIssues(config);
  const ready = issues.length === 0;
  const signingKey = new TextEncoder().encode(config.signingKey ?? '');
  const authVersion = createHmac('sha256', signingKey).update(`owner-password\0${config.password ?? ''}`).digest('base64url');
  const pending = new Map();
  const codes = new Map();
  const limits = new Map();
  const seconds = () => Math.floor(now() / 1000);

  function rate(name, maximum, window = 900) {
    const stamp = seconds();
    let item = limits.get(name);
    if (!item || item.until <= stamp) { item = { count:0, until:stamp + window }; limits.set(name, item); }
    item.count++;
    return item.count <= maximum;
  }
  function clean(map) { for (const [key, item] of map) if (item.expires <= seconds()) map.delete(key); }
  function storeItem(map, value, lifetime) {
    clean(map);
    if (map.size >= 500) throw new Error('temporarily_unavailable');
    const id = random();
    map.set(hash(id), { ...value, expires:seconds() + lifetime });
    return id;
  }
  async function sign(payload, type, lifetime) {
    let token = new SignJWT(payload).setProtectedHeader({ alg:'HS256', typ:type }).setIssuer(base).setIssuedAt(seconds()).setJti(random());
    if (lifetime) token = token.setExpirationTime(seconds() + lifetime);
    return token.sign(signingKey);
  }
  async function verify(token, type, audience) {
    const result = await jwtVerify(token, signingKey, { algorithms:['HS256'], typ:type, issuer:base, audience, currentDate:new Date(now()) });
    return result.payload;
  }
  const clientSecret = (id) => createHmac('sha256', signingKey).update('oauth-client-secret\0' + id).digest('base64url');
  async function client(id) {
    const data = await verify(id, 'garmin-client+jwt');
    if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.every(allowedRedirect)) throw new Error('invalid_client');
    return { id, ...data };
  }
  async function authenticateClient(request, params) {
    let id = params.get('client_id');
    let secret = params.get('client_secret');
    const authorization = request.headers.get('authorization');
    let method = 'client_secret_post';
    if (authorization) {
      if (!authorization.startsWith('Basic ') || secret) throw new Error('invalid_client');
      const value = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const colon = value.indexOf(':');
      if (colon < 1) throw new Error('invalid_client');
      const basicId = decodeURIComponent(value.slice(0, colon));
      if (id && id !== basicId) throw new Error('invalid_client');
      id = basicId;
      secret = decodeURIComponent(value.slice(colon + 1));
      method = 'client_secret_basic';
    }
    const c = await client(id);
    if (!secret || c.auth_method !== method || !equal(secret, clientSecret(id))) throw new Error('invalid_client');
    return c;
  }
  async function tokens(clientId) {
    const common = { sub:'owner', aud:resource, scope:SCOPE, client_id:clientId, ver:authVersion };
    return {
      access_token:await sign(common, 'at+jwt', ACCESS_SECONDS),
      token_type:'Bearer', expires_in:ACCESS_SECONDS, scope:SCOPE,
      refresh_token:await sign(common, 'garmin-refresh+jwt', REFRESH_SECONDS),
    };
  }
  const unauthenticated = () => json({ error:'unauthorized' }, 401, {
    'www-authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`,
  });

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== base) return json({ error:'invalid_host' }, 400);
      if (request.headers.has('origin') && ![base, 'https://chatgpt.com'].includes(request.headers.get('origin'))) return json({ error:'invalid_origin' }, 403);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/healthz') return json({ status:'running', configured:ready });
      // Report field names and validation rules only, never secret values or their actual lengths.
      if (request.method === 'GET' && path === '/readyz') return json({ ready, issues }, ready ? 200 : 503);
      if (request.method === 'GET' && path === '/') return page('Garmin Bartek', ready
        ? `<p>Połączenie Garmin jest skonfigurowane. Dodaj wtyczkę w ChatGPT, używając adresu:</p><p><code>${escape(resource)}</code></p><p>Wybierz logowanie OAuth i pozostaw pola Client ID oraz Client Secret puste. Zaloguj się hasłem ustawionym dla tej wtyczki.</p>`
        : '<p>Serwer jest uruchomiony. Dokończ konfigurację w panelu Render, wpisując klucz Garmin oraz hasło do tej wtyczki, a następnie wybierz „Save and deploy”.</p><p>Dostęp do danych pozostaje zablokowany do ukończenia konfiguracji.</p>');
      if (!ready) return json({ error:'setup_required' }, 503);
      if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
        return json({ resource, authorization_servers:[base], scopes_supported:[SCOPE], bearer_methods_supported:['header'], resource_name:'Garmin Bartek' });
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        return json({
          issuer:base, authorization_endpoint:base + '/oauth/authorize', token_endpoint:base + '/oauth/token',
          registration_endpoint:base + '/oauth/register', response_types_supported:['code'],
          grant_types_supported:['authorization_code','refresh_token'], scopes_supported:[SCOPE],
          token_endpoint_auth_methods_supported:['client_secret_post','client_secret_basic'],
          code_challenge_methods_supported:['S256'], authorization_response_iss_parameter_supported:true,
        });
      }
      if (request.method === 'POST' && path === '/oauth/register') {
        if (!rate('register', 100)) return json({ error:'temporarily_unavailable' }, 429);
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error:'invalid_client_metadata' }, 400);
        const data = await request.json();
        const method = data.token_endpoint_auth_method ?? 'client_secret_basic';
        if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 || data.redirect_uris.length > 5 ||
            !data.redirect_uris.every(allowedRedirect) || !['client_secret_post','client_secret_basic'].includes(method) ||
            (data.grant_types && (!Array.isArray(data.grant_types) || data.grant_types.some(x => !['authorization_code','refresh_token'].includes(x)))) ||
            (data.response_types && (!Array.isArray(data.response_types) || data.response_types.some(x => x !== 'code'))) ||
            (data.scope && data.scope !== SCOPE)) return json({ error:'invalid_client_metadata' }, 400);
        const id = await sign({ redirect_uris:data.redirect_uris, auth_method:method }, 'garmin-client+jwt');
        return json({ client_id:id, client_secret:clientSecret(id), client_id_issued_at:seconds(), client_secret_expires_at:0,
          redirect_uris:data.redirect_uris, token_endpoint_auth_method:method, grant_types:['authorization_code','refresh_token'],
          response_types:['code'], scope:SCOPE, client_name:'ChatGPT — Garmin Bartek' }, 201);
      }
      if (request.method === 'GET' && path === '/oauth/authorize') {
        if (!rate('authorize', 100)) return json({ error:'temporarily_unavailable' }, 429);
        const p = url.searchParams;
        for (const name of new Set(p.keys())) if (p.getAll(name).length !== 1) return json({ error:'invalid_request' }, 400);
        let c;
        try { c = await client(p.get('client_id')); } catch { return json({ error:'invalid_client' }, 400); }
        const redirect = p.get('redirect_uri');
        if (!allowedRedirect(redirect) || !c.redirect_uris.includes(redirect) || p.get('response_type') !== 'code' ||
            p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '') ||
            (p.has('resource') && p.get('resource') !== resource) ||
            (p.has('scope') && p.get('scope') !== SCOPE) || (p.get('state')?.length ?? 0) > 2048) return json({ error:'invalid_request' }, 400);
        const cookie = random();
        const id = storeItem(pending, { clientId:c.id, redirect, challenge:p.get('code_challenge'), state:p.get('state'), cookieHash:hash(cookie) }, 600);
        return page('Połącz Garmin z ChatGPT', `<p>Ta wtyczka pozwala ChatGPT odczytywać Twoje aktywności i dane regeneracyjne Garmin.</p><form method="post" action="/oauth/approve"><input type="hidden" name="transaction" value="${id}"><label for="password">Hasło do wtyczki Garmin Bartek</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="16" maxlength="256" required autofocus><button type="submit">Zaloguj i zezwól na odczyt</button></form><small>Użyj hasła ustawionego jako MCP_LOGIN_PASSWORD w Renderze.</small>`, 200, { 'set-cookie':`${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` });
      }
      if (request.method === 'POST' && path === '/oauth/approve') {
        if (request.headers.get('origin') !== base) return json({ error:'invalid_origin' }, 403);
        if (!rate('login', 20)) return page('Spróbuj później', '<p>Zbyt wiele prób logowania. Odczekaj 15 minut.</p>', 429);
        const p = parseParams(request, await request.text());
        clean(pending);
        const id = p.get('transaction') ?? '';
        const item = pending.get(hash(id));
        const cookie = readCookie(request);
        if (!item || !cookie || !equal(item.cookieHash, hash(cookie))) return page('Połączenie wygasło', '<p>Rozpocznij ponownie łączenie w ChatGPT.</p>', 400);
        if (!p.get('password') || p.get('password').length > 256 || !equal(p.get('password'), config.password)) return page('Nieprawidłowe hasło', '<p>Wróć do formularza i wpisz hasło do tej wtyczki.</p>', 401);
        pending.delete(hash(id));
        const code = storeItem(codes, item, 120);
        const redirect = new URL(item.redirect);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('iss', base);
        if (item.state !== null) redirect.searchParams.set('state', item.state);
        return new Response(null, { status:303, headers:{ ...securityHeaders, location:redirect.toString(), 'set-cookie':`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` } });
      }
      if (request.method === 'POST' && path === '/oauth/token') {
        if (!rate('token', 300)) return json({ error:'temporarily_unavailable' }, 429);
        const p = parseParams(request, await request.text());
        let c;
        try { c = await authenticateClient(request, p); } catch { return json({ error:'invalid_client' }, 401); }
        if (p.has('resource') && p.get('resource') !== resource) return json({ error:'invalid_target' }, 400);
        if (p.get('grant_type') === 'authorization_code') {
          clean(codes);
          const id = p.get('code') ?? '';
          const item = codes.get(hash(id));
          const verifier = p.get('code_verifier') ?? '';
          if (!item || item.clientId !== c.id || item.redirect !== p.get('redirect_uri') ||
              !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(hash(verifier), item.challenge)) return json({ error:'invalid_grant' }, 400);
          codes.delete(hash(id));
          return json(await tokens(c.id));
        }
        if (p.get('grant_type') === 'refresh_token') {
          try {
            const value = await verify(p.get('refresh_token'), 'garmin-refresh+jwt', resource);
            if (value.client_id !== c.id || value.sub !== 'owner' || value.ver !== authVersion || value.scope !== SCOPE) throw new Error('invalid_grant');
            if (p.has('scope') && p.get('scope') !== SCOPE) throw new Error('invalid_grant');
            return json(await tokens(c.id));
          } catch { return json({ error:'invalid_grant' }, 400); }
        }
        return json({ error:'unsupported_grant_type' }, 400);
      }
      if (path === '/mcp') {
        const authorization = request.headers.get('authorization') ?? '';
        if (!authorization.startsWith('Bearer ')) return unauthenticated();
        try {
          const value = await verify(authorization.slice(7), 'at+jwt', resource);
          if (value.sub !== 'owner' || value.ver !== authVersion || value.scope !== SCOPE || !value.client_id) throw new Error('invalid_token');
        } catch { return unauthenticated(); }
        if (!rate('mcp', 300, 60)) return json({ error:'rate_limited' }, 429);
        if (!mcpHandler) return json({ error:'not_configured' }, 503);
        const response = await mcpHandler(request);
        for (const [key, value] of Object.entries(securityHeaders)) response.headers.set(key, value);
        return response;
      }
      return json({ error:'not_found' }, 404);
    } catch {
      // Do not include provider errors, credentials, request bodies, or health data in logs/responses.
      return json({ error:'invalid_request' }, 400);
    }
  };
}
