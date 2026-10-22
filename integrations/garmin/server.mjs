import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createFetchHandler } from 'garmin-personal-mcp/dist/http.js';
import { createApplication } from './app.mjs';

const baseUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
if (!baseUrl) throw new Error('PUBLIC_URL or RENDER_EXTERNAL_URL is required');
const config = {
  baseUrl, garminKey:process.env.GARMIN_PERSONAL_API_KEY,
  password:process.env.MCP_LOGIN_PASSWORD, signingKey:process.env.MCP_SIGNING_KEY,
};
const internalToken = randomBytes(32).toString('base64url');
const upstream = createFetchHandler({ apiKey:config.garminKey || '__SET_IN_RENDER__', bearerToken:internalToken });
const app = createApplication(config, { mcpHandler:async (request) => {
  const headers = new Headers(request.headers);
  headers.set('authorization', 'Bearer ' + internalToken);
  try { return await upstream(new Request(request, { headers })); }
  catch { return Response.json({ error:'garmin_unavailable' }, { status:502 }); }
}});

const server = createServer(async (incoming, outgoing) => {
  try {
    // Limit bodies and do not reconstruct the origin from untrusted forwarded headers.
    if (incoming.headers.host !== new URL(baseUrl).host) {
      outgoing.writeHead(400); outgoing.end('Invalid host'); return;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 65536) { outgoing.writeHead(413); outgoing.end(); return; }
      chunks.push(chunk);
    }
    const url = new URL(incoming.url, baseUrl);
    if (url.origin !== baseUrl.replace(/\/$/, '')) { outgoing.writeHead(400); outgoing.end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(url, { method:incoming.method, headers,
      body:['GET','HEAD'].includes(incoming.method) ? undefined : Buffer.concat(chunks) });
    const response = await app(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type':'application/json' });
    outgoing.end('{"error":"server_error"}');
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('Garmin gateway started'));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 20000).unref();
});
