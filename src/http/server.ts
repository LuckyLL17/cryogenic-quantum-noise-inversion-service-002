import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../domain/errors.ts';
import { analyzeExperiment } from '../application/analysis-service.ts';
import { cancel, get, submit } from '../application/job-store.ts';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > MAX_BODY_BYTES) throw new DomainError('REQUEST_TOO_LARGE', 'Request body exceeds 12 MiB', 413); chunks.push(part); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError('INVALID_JSON', 'Request body must be valid JSON', 400); }
}
function send(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }

export function createServer() {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', service: 'cryogenic-quantum-noise-inversion-service' });
      if (request.method === 'POST' && url.pathname === '/v1/experiments/preview') return send(response, 200, analyzeExperiment(await readJson(request)));
      if (request.method === 'POST' && url.pathname === '/v1/analyses') { const input = await readJson(request); return send(response, 202, submit(input, request.headers['idempotency-key']?.toString())); }
      const match = url.pathname.match(/^\/v1\/analyses\/([^/]+)(?:\/(cancel))?$/);
      if (match && request.method === 'GET' && !match[2]) return send(response, 200, get(match[1]));
      if (match && request.method === 'POST' && match[2] === 'cancel') return send(response, 200, cancel(match[1]));
      return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
    } catch (error) { const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unknown error', 500); return send(response, domain.status, { error: { code: domain.code, message: domain.message, details: domain.details } }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { const port = Number(process.env.PORT ?? 4387); createServer().listen(port, '127.0.0.1', () => console.log(`quantum analysis service listening on http://127.0.0.1:${port}`)); }
