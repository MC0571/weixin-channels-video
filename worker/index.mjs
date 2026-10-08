import { createApiHandler } from '../src/api.mjs';

export default {
  fetch(request, env) {
    let handle;
    try {
      handle = createApiHandler({ apiToken: env.API_TOKEN, yuanbaoCookie: env.YUANBAO_COOKIE });
    } catch {
      return Response.json({
        error: {
          code: 'SERVER_MISCONFIGURED',
          message: 'Both API_TOKEN and YUANBAO_COOKIE must be configured.',
        },
      }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
    return handle(request);
  },
};
