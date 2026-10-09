import { ParseError, parseShareLink } from './core.mjs';
import { createCookieRequest } from './cookie-request.mjs';

const bodyLimit = 8 * 1024;

function json(value, status, headers = {}) {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });
}

function errorResponse(status, code, message, headers) {
  return json({ error: { code, message } }, status, headers);
}

function parseErrorStatus(error) {
  if (error.code === 'INVALID_URL') return 400;
  if (error.code === 'AUTH_EXPIRED') return 401;
  if (error.code === 'FEED_UNAVAILABLE') return 404;
  return 502;
}

async function readJson(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > bodyLimit) {
    return { tooLarge: true };
  }

  let reader;
  try {
    reader = request.body?.getReader();
  } catch {
    return { invalid: true };
  }
  if (!reader) return { invalid: true };

  const chunks = [];
  let length = 0;
  while (true) {
    let part;
    try {
      part = await reader.read();
    } catch {
      return { invalid: true };
    }
    const { done, value } = part;
    if (done) break;
    length += value.byteLength;
    if (length > bodyLimit) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { invalid: true };
  }
}

export function createApiHandler({ apiToken, yuanbaoCookie, fetchImpl = fetch }) {
  if (typeof apiToken !== 'string' || !apiToken.trim() || typeof yuanbaoCookie !== 'string' || !yuanbaoCookie.trim()) {
    throw new Error('Both API_TOKEN and YUANBAO_COOKIE must be configured.');
  }

  const request = createCookieRequest(yuanbaoCookie, fetchImpl);

  return async function handleApiRequest(incoming) {
    const url = new URL(incoming.url);
    if (url.pathname !== '/parse') {
      return errorResponse(404, 'NOT_FOUND', 'Not found.');
    }
    if (url.search) {
      return errorResponse(400, 'INVALID_REQUEST', 'Query parameters are not supported.');
    }
    if (incoming.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Use POST for /parse.', { allow: 'POST' });
    }

    const authorization = incoming.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!match || match[1] !== apiToken) {
      return errorResponse(401, 'API_UNAUTHORIZED', 'A valid bearer token is required.');
    }

    if (incoming.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    }

    const body = await readJson(incoming);
    if (body.tooLarge) {
      return errorResponse(413, 'BODY_TOO_LARGE', 'Request body must not exceed 8192 bytes.');
    }
    if (body.invalid || !body.value || typeof body.value.url !== 'string' || !body.value.url) {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body must be JSON with a non-empty url string.');
    }

    try {
      const data = await parseShareLink(body.value.url, { request });
      return json({ data }, 200);
    } catch (error) {
      if (error instanceof ParseError) {
        return errorResponse(parseErrorStatus(error), error.code, error.message);
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'The request could not be completed.');
    }
  };
}
