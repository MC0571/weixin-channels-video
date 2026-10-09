import { openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const api = 'https://chromewebstore.googleapis.com';
const maxUploadPolls = 30;
const uploadPollDelayMs = 5_000;
const activeSubmissionStates = new Set(['PENDING_REVIEW', 'STAGED']);
const publishedStates = new Set(['PUBLISHED', 'PUBLISHED_TO_TESTERS']);
const recognizedSubmissionStates = new Set([
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
]);

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseVersion(version) {
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error('Invalid Chrome extension manifest version');
  }
  return version.split('.').map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function channelVersions(revision) {
  if (!Array.isArray(revision?.distributionChannels)) return [];
  return revision.distributionChannels
    .map((channel) => channel?.crxVersion)
    .filter((version) => typeof version === 'string');
}

function hasVersion(revision, version) {
  return channelVersions(revision).includes(version);
}

function assertItemStatus(status, itemName, itemId) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('Chrome Web Store returned an invalid item status');
  }
  if (status.name !== itemName || status.itemId !== itemId) {
    throw new Error('Chrome Web Store returned a status for a different item');
  }
}

async function requestJson(path, { token, method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body instanceof Blob ? { 'Content-Type': 'application/zip' } : {}),
        ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`Chrome Web Store ${method} request failed before a response was received`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Chrome Web Store ${method} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || result?.error) {
    const code = typeof result?.error?.status === 'string' ? `, ${result.error.status}` : '';
    throw new Error(`Chrome Web Store ${method} failed (HTTP ${response.status}${code})`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`Chrome Web Store ${method} returned an invalid response`);
  }
  return result;
}

function hasAcceptedVersion(status, version) {
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;
  return (hasVersion(published, version) && publishedStates.has(published.state) && status.takenDown !== true)
    || (hasVersion(submitted, version) && activeSubmissionStates.has(submitted.state));
}

function reportAlreadyHandled(status, version) {
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;

  if (hasVersion(published, version)) {
    if (status.takenDown === true) {
      throw new Error(`Chrome Web Store version ${version} has been taken down; inspect Developer Dashboard before retrying`);
    }
    if (!publishedStates.has(published.state)) {
      throw new Error(`Chrome Web Store version ${version} has an unrecognized published state`);
    }
    console.log(`Chrome Web Store version ${version} is already published (state=${published.state}).`);
    return true;
  }

  if (hasVersion(submitted, version)) {
    if (!recognizedSubmissionStates.has(submitted.state)) {
      throw new Error(`Chrome Web Store version ${version} has an unrecognized submission state`);
    }
    console.log(`Chrome Web Store version ${version} is already submitted (state=${submitted.state}).`);
    return true;
  }

  if (activeSubmissionStates.has(submitted?.state)) {
    throw new Error(`Chrome Web Store has another active submission (state=${submitted.state}); resolve it before releasing`);
  }

  for (const revision of [published, submitted]) {
    for (const existingVersion of channelVersions(revision)) {
      if (compareVersions(existingVersion, version) > 0) {
        throw new Error(`Chrome Web Store already has newer version ${existingVersion}; refusing version ${version}`);
      }
    }
  }
  return false;
}

async function fetchItemStatus(paths, token) {
  const status = await requestJson(paths.status, { token });
  assertItemStatus(status, paths.name, paths.itemId);
  return status;
}

async function pollAsyncUpload(paths, token, version) {
  for (let attempt = 1; attempt <= maxUploadPolls; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, uploadPollDelayMs));
    const status = await fetchItemStatus(paths, token);
    if (reportAlreadyHandled(status, version)) return 'handled';
    const uploadState = status.lastAsyncUploadState;
    if (['SUCCEEDED', 'FAILED', 'NOT_FOUND'].includes(uploadState)) return status;
    if (!['IN_PROGRESS', 'UPLOAD_STATE_UNSPECIFIED', undefined].includes(uploadState)) {
      throw new Error(`Chrome Web Store returned an unknown asynchronous upload state: ${uploadState}`);
    }
  }
  throw new Error('Chrome Web Store asynchronous upload is still in progress after 150 seconds');
}

async function submit() {
  if (process.argv.length !== 2) {
    throw new Error('This script accepts no command-line arguments');
  }

  const token = requiredEnv('CWS_ACCESS_TOKEN');
  const publisherId = requiredEnv('CWS_PUBLISHER_ID');
  const itemId = requiredEnv('CWS_ITEM_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publisherId)) {
    throw new Error('CWS_PUBLISHER_ID must be a publisher UUID');
  }
  if (!/^[a-p]{32}$/.test(itemId)) {
    throw new Error('CWS_ITEM_ID must be a Chrome Web Store item ID');
  }

  const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
  const version = manifest.version;
  parseVersion(version);
  const zipPath = join(root, 'dist/release', `weixin-channels-video-extension-v${version}.zip`);
  const zipStats = await stat(zipPath).catch(() => null);
  if (!zipStats || zipStats.size === 0) {
    throw new Error(`Release extension archive is missing or empty for version ${version}`);
  }

  const itemName = `publishers/${publisherId}/items/${itemId}`;
  const paths = {
    itemId,
    name: itemName,
    status: `/v2/${itemName}:fetchStatus`,
    upload: `/upload/v2/${itemName}:upload`,
    publish: `/v2/${itemName}:publish`,
  };

  let status = await fetchItemStatus(paths, token);
  if (reportAlreadyHandled(status, version)) return;
  // shortcut: Dashboard uploads must wait for this serialized release run to finish; add coordination only if concurrent uploads become routine.
  if (status.lastAsyncUploadState === 'IN_PROGRESS') {
    status = await pollAsyncUpload(paths, token, version);
    if (status === 'handled') return;
  } else if (!['SUCCEEDED', 'FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined].includes(status.lastAsyncUploadState)) {
    throw new Error(`Chrome Web Store returned an unknown asynchronous upload state: ${status.lastAsyncUploadState}`);
  }

  let uploaded;
  try {
    uploaded = await requestJson(paths.upload, {
      token,
      method: 'POST',
      body: await openAsBlob(zipPath),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    status = await fetchItemStatus(paths, token).catch(() => null);
    if (status && reportAlreadyHandled(status, version)) return;
    throw new Error(`${error.message}; upload outcome is unconfirmed, so no publish request was sent`);
  }

  if (uploaded.itemId !== itemId || uploaded.name !== itemName) {
    throw new Error('Chrome Web Store uploaded a different item');
  }
  if (uploaded.uploadState === 'IN_PROGRESS') {
    status = await pollAsyncUpload(paths, token, version);
    if (status === 'handled') return;
    if (status.lastAsyncUploadState === 'FAILED') {
      throw new Error('Chrome Web Store asynchronous upload failed; the release package was not submitted');
    }
    if (status.lastAsyncUploadState === 'NOT_FOUND') {
      throw new Error('Chrome Web Store could not find the asynchronous upload attempt; inspect the item in Developer Dashboard');
    }
    if (status.lastAsyncUploadState !== 'SUCCEEDED') {
      throw new Error(`Chrome Web Store asynchronous upload did not succeed (state=${status.lastAsyncUploadState ?? 'missing'})`);
    }
  } else if (uploaded.uploadState !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload did not succeed (state=${uploaded.uploadState ?? 'missing'})`);
  }
  if (uploaded.uploadState === 'SUCCEEDED' && uploaded.crxVersion !== version) {
    throw new Error(`Chrome Web Store uploaded version ${uploaded.crxVersion ?? 'unknown'} instead of ${version}; no publish request was sent`);
  }
  let submitted;
  try {
    submitted = await requestJson(paths.publish, {
      token,
      method: 'POST',
      body: { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true },
    });
  } catch (error) {
    status = await fetchItemStatus(paths, token).catch(() => null);
    if (status && hasAcceptedVersion(status, version)) {
      console.log(`Chrome Web Store version ${version} is already submitted (state=${status.submittedItemRevisionStatus?.state ?? status.publishedItemRevisionStatus?.state}).`);
      return;
    }
    throw new Error(`${error.message}; submission outcome is unconfirmed, so inspect the item in Developer Dashboard`);
  }

  if (submitted.itemId !== itemId || submitted.name !== itemName || !recognizedSubmissionStates.has(submitted.state)) {
    throw new Error('Chrome Web Store returned an unexpected publish result');
  }
  console.log(`Chrome Web Store version ${version} submitted (state=${submitted.state}).`);
}

submit().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
