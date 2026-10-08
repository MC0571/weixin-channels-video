import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('./cookie_reader.py', import.meta.url));

function cookieUrlKey(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

export function readChromeCookieHeaders(cookieDb, requestUrls) {
  if (!Array.isArray(requestUrls) || requestUrls.length === 0) throw new TypeError('At least one request URL is required.');
  return new Promise((resolve, reject) => {
    const args = [helperPath, '--cookie-db', cookieDb];
    for (const url of requestUrls) args.push('--url', url);
    const child = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(error.code === 'ENOENT' ? new Error('Python 3 was not found; install Python 3 and the skill requirements.') : new Error('Could not start the Chrome cookie helper.'));
    });
    child.on('close', (code) => {
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        if (diagnostic.includes('browser-cookie3 is missing') || diagnostic.includes('version mismatch')) {
          reject(new Error('browser-cookie3==0.20.1 is required; install the dependency listed in this skill\'s requirements.txt.'));
        } else if (diagnostic.includes('cookie-database-open-close-chrome') || diagnostic.includes('cookie-database-wal-pending-close-chrome')) {
          reject(new Error('Close Chrome to checkpoint its cookie database, then retry local mode.'));
        } else if (diagnostic.includes('cookie-database-open-check-failed') || diagnostic.includes('cookie-database-wal-check-failed')) {
          reject(new Error('Could not verify that Chrome’s cookie database is safe to read; close Chrome and retry.'));
        } else if (diagnostic.includes('cookie-database-unavailable-read-only')) {
          reject(new Error('Chrome cookies could not be opened read-only; close Chrome and retry.'));
        } else if (diagnostic.includes('Keychain access or cookie decryption failed')) {
          reject(new Error('Chrome Safe Storage access or cookie decryption failed.'));
        } else {
          reject(new Error('Chrome cookies could not be read; check the selected profile and Python environment.'));
        }
        return;
      }

      try {
        const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (!Array.isArray(result.cookiesByUrl) || result.cookiesByUrl.length !== requestUrls.length) {
          throw new Error();
        }
        const headers = new Map();
        for (let index = 0; index < requestUrls.length; index += 1) {
          const resultEntry = result.cookiesByUrl[index];
          if (resultEntry.url !== requestUrls[index] || !Array.isArray(resultEntry.cookies) || resultEntry.cookies.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== 'string'))) {
            throw new Error();
          }
          const cookie = resultEntry.cookies.map(([name, value]) => `${name}=${value}`).join('; ');
          if (/[\r\n]/.test(cookie)) throw new Error();
          headers.set(cookieUrlKey(requestUrls[index]), cookie);
        }
        resolve(headers);
      } catch {
        reject(new Error('Chrome cookie helper returned invalid data.'));
      }
    });
  });
}

export async function readChromeCookieHeader(cookieDb, requestUrl) {
  return (await readChromeCookieHeaders(cookieDb, [requestUrl])).get(cookieUrlKey(requestUrl));
}
