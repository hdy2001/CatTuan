import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPiRuntime, RuntimeError } from './pi-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);

export async function readEnvFile(filename) {
  let text;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    entries[match[1]] = value;
  }
  return entries;
}

async function body(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RuntimeError('Request body too large', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new RuntimeError('Request body must be a JSON object'); }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** HTTP facade intentionally preserves CatTuan's run, SSE, stop and steer API. */
export function createPiGateway({ runtime, apiKey, heartbeatMs = 15000 } = {}) {
  if (!runtime || !apiKey) throw new Error('Pi gateway requires a runtime and API_SERVER_KEY');
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', runtime: 'pi', model: runtime.modelId });
      const actual = Buffer.from(req.headers.authorization || '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(res, 200, { object: 'list', data: [{ id: 'pi-agent', object: 'model', owned_by: 'cattuan', runtime: 'pi', underlying_model: runtime.modelId }] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const run = runtime.startRun(await body(req));
        return json(res, 200, { run_id: run.id, session_id: run.sessionId, status: run.status });
      }
      const route = url.pathname.match(/^\/v1\/runs\/([^/]+)\/(events|steer|stop)$/);
      if (!route) return json(res, 404, { error: 'Not found' });
      const [, id, operation] = route;
      const run = runtime.getRun(id);
      if (!run) return json(res, 404, { error: 'Run not found' });
      if (req.method === 'POST' && operation === 'stop') return json(res, 200, await runtime.stop(id));
      if (req.method === 'POST' && operation === 'steer') return json(res, 200, await runtime.steer(id, (await body(req)).input));
      if (req.method !== 'GET' || operation !== 'events') return json(res, 405, { error: 'Method not allowed' });
      const header = req.headers['last-event-id'];
      let lastSeq = header === undefined ? -1 : Number(header);
      if (!Number.isSafeInteger(lastSeq) || lastSeq < -1) throw new RuntimeError('Last-Event-ID must be an integer');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      streams.add(res);
      const send = (event) => {
        if (res.destroyed || res.writableEnded || event.seq <= lastSeq) return;
        lastSeq = event.seq;
        res.write(`id: ${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
        if (TERMINAL.has(event.event)) res.end();
      };
      run.listeners.add(send);
      for (const event of run.events) send(event);
      if (run.status !== 'running') res.end();
      const timer = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n'); }, heartbeatMs);
      timer.unref();
      res.on('close', () => { clearInterval(timer); run.listeners.delete(send); streams.delete(res); });
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else json(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Pi gateway request failed' });
    }
  });
  server.requestTimeout = 30000;
  return {
    server,
    async listen({ port = 8650, host = '127.0.0.1' } = {}) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      const stopped = server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      await runtime.close();
      for (const response of streams) response.end();
      server.closeIdleConnections();
      await stopped;
    },
  };
}

export async function main() {
  const home = path.resolve(process.env.PI_HOME || process.env.CATTUAN_HOME || path.join(ROOT, 'agent-home'));
  const template = await readEnvFile(path.join(ROOT, 'agent-home', '.env'));
  const own = await readEnvFile(path.join(home, '.env'));
  const env = { ...template, ...own, ...process.env };
  // Node's environment proxy support also covers Pi's model requests.
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  if (typeof http.setGlobalProxyFromEnv === 'function') http.setGlobalProxyFromEnv();
  if (!env.API_SERVER_KEY) throw new Error(`API_SERVER_KEY is missing in ${path.join(home, '.env')}`);
  const port = Number(env.API_SERVER_PORT || 8650);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_SERVER_PORT must be between 1 and 65535');
  const runtime = await createPiRuntime({ home, env });
  const gateway = createPiGateway({ runtime, apiKey: env.API_SERVER_KEY });
  try {
    await gateway.listen({ port, host: env.API_SERVER_HOST || '127.0.0.1' });
  } catch (error) { await runtime.close(); throw error; }
  console.log(`[pi] listening on ${env.API_SERVER_HOST || '127.0.0.1'}:${port} (${runtime.modelId})`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await gateway.close();
  };
  process.once('SIGTERM', () => stop().catch((error) => { console.error(`[pi] ${error.message}`); process.exitCode = 1; }));
  process.once('SIGINT', () => stop().catch((error) => { console.error(`[pi] ${error.message}`); process.exitCode = 1; }));
  return gateway;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[pi] ${error.message}`); process.exitCode = 1; });
}
