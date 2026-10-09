import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createApiHandler } from '../src/api.mjs';

function toRequest(incoming) {
  const method = incoming.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(incoming);
  return new Request(new URL(incoming.url ?? '/', 'http://localhost'), {
    method,
    headers: incoming.headers,
    ...(body ? { body, duplex: 'half' } : {}),
  });
}

export function createNodeServer({ apiToken, yuanbaoCookie, fetchImpl } = {}) {
  const handle = createApiHandler({ apiToken, yuanbaoCookie, fetchImpl });

  return createServer(async (incoming, outgoing) => {
    let request;
    try {
      request = toRequest(incoming);
    } catch {
      const body = JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Request could not be read.' } });
      outgoing.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      outgoing.end(body);
      return;
    }

    try {
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      const body = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
      outgoing.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      outgoing.end(body);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createNodeServer({
    apiToken: process.env.API_TOKEN,
    yuanbaoCookie: process.env.YUANBAO_COOKIE,
  });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`API listening on port ${port}`));
}
