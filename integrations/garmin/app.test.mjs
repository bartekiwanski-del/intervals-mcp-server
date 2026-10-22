import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from './app.mjs';
import { createFetchHandler } from 'garmin-personal-mcp/dist/http.js';

const BASE = 'https://garmin.example.com';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const RESOURCE = BASE + '/mcp';
const CONFIG = { baseUrl:BASE, garminKey:'fake-garmin-key-for-tests-only', password:'test-owner-password-123456789', signingKey:'test-signing-key-not-a-real-secret-12345678901234567890' };
const verifier = 'verifier-for-test-only-012345678901234567890123456789';
const challenge = createHash('sha256').update(verifier).digest('base64url');
function request(path, { method='GET', data, form, token, headers={} } = {}) {
  return new Request(BASE + path, { method, headers:{
    ...(data ? {'content-type':'application/json'} : {}), ...(form ? {'content-type':'application/x-www-form-urlencoded'} : {}),
    ...(token ? {authorization:'Bearer ' + token} : {}), ...headers,
  }, body:data ? JSON.stringify(data) : form ? new URLSearchParams(form).toString() : undefined });
}
function app(config=CONFIG, options={}) { return createApplication(config, { mcpHandler:async () => Response.json({ allowed:true }), ...options }); }
async function register(handle, method='client_secret_post', overrides={}) {
  const response = await handle(request('/oauth/register', { method:'POST', data:{ redirect_uris:[REDIRECT], token_endpoint_auth_method:method, ...overrides } }));
  assert.equal(response.status, 201);
  return response.json();
}
async function authorize(handle, client, overrides={}) {
  const params = { client_id:client.client_id, redirect_uri:REDIRECT, response_type:'code', scope:'garmin:read',
    state:'original-state', resource:RESOURCE, code_challenge:challenge, code_challenge_method:'S256', ...overrides };
  const response = await handle(request('/oauth/authorize?' + new URLSearchParams(params)));
  assert.equal(response.status, 200);
  const html = await response.text();
  return { transaction:html.match(/name="transaction" value="([^"]+)"/)[1], cookie:response.headers.get('set-cookie').split(';')[0] };
}
async function approve(handle, login, password=CONFIG.password, headers={}) {
  return handle(request('/oauth/approve', { method:'POST', form:{ transaction:login.transaction, password }, headers:{ origin:BASE, cookie:login.cookie, ...headers } }));
}
async function codeFor(handle, client) {
  const response = await approve(handle, await authorize(handle, client));
  assert.equal(response.status, 303);
  const url = new URL(response.headers.get('location'));
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get('iss'), BASE);
  assert.equal(url.searchParams.get('state'), 'original-state');
  return url.searchParams.get('code');
}
async function exchange(handle, client, code, overrides={}) {
  return handle(request('/oauth/token', { method:'POST', form:{ grant_type:'authorization_code', client_id:client.client_id,
    client_secret:client.client_secret, code, redirect_uri:REDIRECT, code_verifier:verifier, resource:RESOURCE, ...overrides } }));
}
async function connected(handle) {
  const client = await register(handle);
  const response = await exchange(handle, client, await codeFor(handle, client));
  assert.equal(response.status, 200);
  return { client, tokens:await response.json() };
}

test('missing or placeholder secrets close data and authorization endpoints', async () => {
  for (const field of ['garminKey','password','signingKey']) {
    for (const value of ['', '__SET_IN_RENDER__']) {
      const handle = app({ ...CONFIG, [field]:value });
      assert.equal((await handle(request('/mcp'))).status, 503);
      assert.equal((await handle(request('/oauth/register', {method:'POST',data:{}}))).status, 503);
      assert.equal((await handle(request('/readyz'))).status, 503);
      assert.equal((await handle(request('/healthz'))).status, 200);
    }
  }
});
test('configuration diagnostics identify invalid fields without returning secrets', async () => {
  for (const [password, issue] of [
    ['', {field:'MCP_LOGIN_PASSWORD',reason:'not_set'}],
    ['__SET_IN_RENDER__', {field:'MCP_LOGIN_PASSWORD',reason:'not_set'}],
    ['short-password', {field:'MCP_LOGIN_PASSWORD',reason:'too_short',minimum:16}],
    ['x'.repeat(257), {field:'MCP_LOGIN_PASSWORD',reason:'too_long',maximum:256}],
  ]) {
    const response = await app({...CONFIG,password})(request('/readyz'));
    assert.equal(response.status,503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {ready:false,issues:[issue]});
    for (const secret of [password,CONFIG.garminKey,CONFIG.signingKey].filter(Boolean)) assert.equal(body.includes(secret),false);
  }
  const response = await app()(request('/readyz'));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ready:true,issues:[]});
});
test('OAuth metadata publishes PKCE, issuer identification and the exact resource', async () => {
  const handle = app();
  const auth = await (await handle(request('/.well-known/oauth-authorization-server'))).json();
  assert.equal(auth.issuer, BASE);
  assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
  assert.equal(auth.authorization_response_iss_parameter_supported, true);
  const resource = await (await handle(request('/.well-known/oauth-protected-resource/mcp'))).json();
  assert.equal(resource.resource, RESOURCE);
  assert.deepEqual(resource.authorization_servers, [BASE]);
  const response = await handle(request('/mcp'));
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
});
test('registration rejects foreign redirects, public clients and unsupported permissions', async () => {
  const handle = app();
  for (const override of [
    {redirect_uris:['https://attacker.example/callback']}, {redirect_uris:[REDIRECT + '?evil=1']},
    {redirect_uris:['https://chatgpt.com.attacker.example/connector_platform_oauth_redirect']},
    {redirect_uris:['https://attacker@chatgpt.com/connector_platform_oauth_redirect']},
    {token_endpoint_auth_method:'none'}, {scope:'garmin:write'}, {grant_types:['client_credentials']},
  ]) {
    const response = await handle(request('/oauth/register', { method:'POST', data:{redirect_uris:[REDIRECT], ...override} }));
    assert.equal(response.status, 400);
  }
});
test('complete confidential-client OAuth and PKCE flow permits a protected request', async () => {
  const handle = app();
  const {tokens} = await connected(handle);
  assert.equal(tokens.token_type, 'Bearer');
  const response = await handle(request('/mcp', {token:tokens.access_token}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {allowed:true});
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('owner approval requires the password, browser cookie and correct origin', async () => {
  const handle = app();
  const client = await register(handle);
  const login = await authorize(handle, client);
  assert.equal((await approve(handle, login, 'wrong-password')).status, 401);
  assert.equal((await approve(handle, login, CONFIG.password, {cookie:''})).status, 400);
  assert.equal((await approve(handle, login, CONFIG.password, {origin:'https://attacker.example'})).status, 403);
  assert.equal((await approve(handle, login)).status, 303);
  assert.equal((await approve(handle, login)).status, 400);
});
test('authorization rejects redirect substitution, plain PKCE and a foreign resource', async () => {
  const handle = app();
  const client = await register(handle);
  const base = {client_id:client.client_id, redirect_uri:REDIRECT, response_type:'code', code_challenge:challenge, code_challenge_method:'S256', scope:'garmin:read', resource:RESOURCE};
  for (const override of [{redirect_uri:'https://attacker.example'}, {code_challenge_method:'plain'}, {scope:'garmin:write'}, {resource:'https://attacker.example/mcp'}]) {
    const response = await handle(request('/oauth/authorize?' + new URLSearchParams({...base,...override})));
    assert.equal(response.status, 400);
  }
});
test('code exchange checks secret, verifier, resource, client, redirect and single use', async () => {
  const handle = app();
  const client = await register(handle);
  const other = await register(handle);
  const code = await codeFor(handle, client);
  for (const override of [{code_verifier:'x'.repeat(43)}, {redirect_uri:REDIRECT+'?x=1'}, {resource:'https://other.example/mcp'}]) {
    assert.equal((await exchange(handle, client, code, override)).status, 400);
  }
  assert.equal((await exchange(handle, client, code, {client_secret:'incorrect'})).status, 401);
  assert.equal((await exchange(handle, other, code)).status, 400);
  assert.equal((await exchange(handle, client, code)).status, 200);
  assert.equal((await exchange(handle, client, code)).status, 400);
});
test('client_secret_basic works as registered', async () => {
  const handle = app();
  const client = await register(handle, 'client_secret_basic');
  const code = await codeFor(handle, client);
  const response = await handle(request('/oauth/token', {method:'POST',form:{grant_type:'authorization_code',code,redirect_uri:REDIRECT,code_verifier:verifier,resource:RESOURCE},headers:{authorization:'Basic '+Buffer.from(encodeURIComponent(client.client_id)+':'+encodeURIComponent(client.client_secret)).toString('base64')}}));
  assert.equal(response.status, 200);
});
test('authorization codes expire', async () => {
  let clock = Date.now();
  const handle = app(CONFIG, {now:() => clock});
  const client = await register(handle);
  const code = await codeFor(handle, client);
  clock += 121000;
  assert.equal((await exchange(handle, client, code)).status, 400);
});
test('refresh works after process restart but requires client credentials', async () => {
  const {client,tokens} = await connected(app());
  const restarted = app();
  assert.equal((await restarted(request('/mcp', {token:tokens.access_token}))).status, 200);
  const form = {grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:tokens.refresh_token,resource:RESOURCE};
  assert.equal((await restarted(request('/oauth/token',{method:'POST',form}))).status, 200);
  assert.equal((await restarted(request('/oauth/token',{method:'POST',form:{...form,client_secret:'wrong'}}))).status, 401);
  assert.equal((await restarted(request('/oauth/token',{method:'POST',form:{...form,refresh_token:tokens.access_token}}))).status, 400);
});
test('expiry and password/key rotation invalidate the appropriate credentials', async () => {
  let clock = Date.now();
  const {client,tokens} = await connected(app(CONFIG, {now:() => clock}));
  clock += 3601000;
  const later = app(CONFIG, {now:() => clock});
  assert.equal((await later(request('/mcp', {token:tokens.access_token}))).status, 401);
  const form = {grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:tokens.refresh_token};
  assert.equal((await later(request('/oauth/token',{method:'POST',form}))).status, 200);
  const changed = app({...CONFIG,password:'a-completely-different-password'});
  assert.equal((await changed(request('/mcp',{token:tokens.access_token}))).status, 401);
  assert.equal((await changed(request('/oauth/token',{method:'POST',form}))).status, 400);
  const rotated = app({...CONFIG,signingKey:'another-signing-key-longer-than-forty-characters-test-only'});
  assert.equal((await rotated(request('/mcp',{token:tokens.access_token}))).status, 401);
  assert.equal((await rotated(request('/oauth/token',{method:'POST',form}))).status, 401);
});
test('wrong token types, tampering, foreign origins and hosts never reach Garmin', async () => {
  let calls = 0;
  const handle = app(CONFIG, {mcpHandler:async () => { calls++; return Response.json({}); }});
  const {client,tokens} = await connected(handle);
  for (const token of [client.client_id,tokens.refresh_token,tokens.access_token.slice(0,-8)+'badvalue','garbage']) assert.equal((await handle(request('/mcp',{token}))).status, 401);
  assert.equal((await handle(request('/mcp',{token:tokens.access_token,headers:{origin:'https://attacker.example'}}))).status, 403);
  assert.equal((await handle(new Request('https://attacker.example/mcp'))).status, 400);
  assert.equal(calls, 0);
});
test('login guessing is bounded', async () => {
  const handle = app();
  const login = await authorize(handle, await register(handle));
  for (let i=0;i<20;i++) assert.equal((await approve(handle,login,'wrong')).status, 401);
  assert.equal((await approve(handle,login,'wrong')).status, 429);
});
test('the actual upstream MCP catalog is available only after OAuth, without contacting Garmin', async () => {
  const internalToken = 'test-internal-gateway-token';
  const upstream = createFetchHandler({apiKey:CONFIG.garminKey,bearerToken:internalToken});
  const handle = app(CONFIG, {mcpHandler:request => { const headers=new Headers(request.headers); headers.set('authorization','Bearer '+internalToken); return upstream(new Request(request,{headers})); }});
  const {tokens} = await connected(handle);
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External network forbidden in test'); };
  try {
    const response = await handle(request('/mcp',{method:'POST',token:tokens.access_token,headers:{accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}}));
    assert.equal(response.status, 200);
    const {result} = await response.json();
    const names = result.tools.map(t => t.name);
    for (const expected of ['get_body_battery','get_sleep','get_hrv','get_heart_rate','get_stress','list_activities']) assert.ok(names.includes(expected),expected);
    assert.equal(names.length,25);
    for (const tool of result.tools) assert.equal(tool.annotations?.readOnlyHint,true,tool.name);
  } finally { globalThis.fetch = before; }
});
