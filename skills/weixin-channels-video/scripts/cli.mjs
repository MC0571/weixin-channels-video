#!/usr/bin/env node
import { API_URLS, checkLogin, ParseError, parseShareLink } from '../../../src/core.mjs';
import { createCookieRequest } from '../../../src/cookie-request.mjs';
import { listChromeProfiles, resolveChromeProfile } from './chrome-profile.mjs';
import { readChromeCookieHeaders } from './cookie-process.mjs';
import { saveExistingFile, saveMedia } from './save-media.mjs';

const keychainNotice = 'The local Python helper may call /usr/bin/security via browser-cookie3 to request Chrome Safe Storage from macOS Keychain if matching encrypted cookies need decryption. The request is for Chrome Safe Storage itself; cookie matching is limited to yuanbao.tencent.com. “Allow” is for this request; “Always Allow” persists. You choose in the macOS prompt.';

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (!['profile', 'url', 'output'].includes(key) || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Invalid or incomplete option: ${argument}`);
    }
    options[key] = args[index + 1];
    index += 1;
  }
  return { options, positional };
}

async function selectedProfile(profileRef) {
  const profile = await resolveChromeProfile(profileRef);
  console.error(keychainNotice);
  return profile;
}

function localDownloadRequest(profile) {
  let cookieHeaders;
  return async (value, init = {}) => {
    const url = new URL(typeof value === 'string' ? value : value.href);
    let cookie = '';
    if (url.origin === new URL(API_URLS.userInfo).origin) {
      cookieHeaders ??= readChromeCookieHeaders(profile.cookieDb, [API_URLS.userInfo, API_URLS.parseShare]);
      const headers = await cookieHeaders;
      cookie = headers.get(`${url.origin}${url.pathname}`);
      if (cookie === undefined) throw new Error('No URL-matched Chrome cookie result is available.');
    }
    return createCookieRequest(cookie)(value, init);
  };
}

function printProfiles(profiles) {
  for (const { directory, name } of profiles) console.log(`${JSON.stringify(directory)}\t${JSON.stringify(name)}`);
}

async function run(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log('Usage: cli.mjs list-profiles | check-login [--profile <directory-or-name>] | download --url <share-link> --output <file> [--profile <directory-or-name>] | save-existing <source-file> --output <file>');
    return;
  }
  const { options, positional } = parseOptions(args);

  if (command === 'list-profiles') {
    if (args.length) throw new Error('list-profiles takes no options.');
    printProfiles(await listChromeProfiles());
    return;
  }
  if (command === 'check-login') {
    if (positional.length || options.url || options.output) throw new Error('check-login accepts only --profile.');
    const profile = await selectedProfile(options.profile);
    const cookies = await readChromeCookieHeaders(profile.cookieDb, [API_URLS.userInfo]);
    const result = await checkLogin(createCookieRequest(cookies.get(new URL(API_URLS.userInfo).href)));
    console.log(result.status);
    return;
  }
  if (command === 'download') {
    if (positional.length || !options.url || !options.output) throw new Error('download requires --url and --output.');
    const profile = await selectedProfile(options.profile);
    const request = localDownloadRequest(profile);
    const video = await parseShareLink(options.url, { request });
    const saved = await saveMedia(video.downloadUrl, options.output);
    console.log(`Saved ${saved.path} (${saved.bytes} bytes).`);
    return;
  }
  if (command === 'save-existing') {
    if (positional.length !== 1 || !options.output || options.profile || options.url) throw new Error('save-existing requires a source file and --output.');
    const saved = await saveExistingFile(positional[0], options.output);
    console.log(`Saved ${saved.path} (${saved.bytes} bytes).`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch((error) => {
  if (error instanceof ParseError) console.error(`${error.code}: ${error.message}`);
  else console.error(error?.message || 'Command failed.');
  process.exitCode = 1;
});
