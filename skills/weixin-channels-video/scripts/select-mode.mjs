export async function selectExecution({ mode = 'auto', builtin, chrome, checkLogin }) {
  if (!['auto', 'builtin', 'chrome'].includes(mode)) throw new Error('Unknown execution mode.');
  if (typeof checkLogin !== 'function') throw new TypeError('checkLogin must be supplied by the shared core integration.');

  const choices = mode === 'auto' ? [['builtin', builtin], ['chrome', chrome]] : [[mode, mode === 'builtin' ? builtin : chrome]];
  let anonymous;

  for (const [name, candidate] of choices) {
    if (!candidate?.available) {
      if (mode !== 'auto') throw new Error(`Requested ${name} mode is unavailable.`);
      continue;
    }

    const request = candidate.getRequest ? await candidate.getRequest() : candidate.request;
    if (!request) throw new Error(`${name} mode did not provide a request adapter.`);
    const login = await checkLogin(request);
    if (login?.status !== 'authenticated' && login?.status !== 'anonymous') {
      throw new Error('Login check failed; execution mode selection stopped.');
    }
    const selected = { mode: name, request, login };
    if (login.status === 'authenticated' || mode !== 'auto') return selected;
    anonymous ??= selected;
  }

  if (anonymous) return anonymous;
  throw new Error('No supported execution mode is available.');
}
