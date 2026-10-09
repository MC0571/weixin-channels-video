import { API_URLS, ParseError } from "../src/core.mjs";
import { NATIVE_HOST_NAME, SESSION_ID_PATTERN, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, startDownload, waitForDownload } from "./app.mjs";
import { createAgentCommandHandler } from "./agent.mjs";

const CHANNELS_ORIGIN = "https://channels.weixin.qq.com";
const CHANNELS_FEED_PAGE_URL = `${CHANNELS_ORIGIN}/finder-preview/pages/feed`;
const FEED_REQUEST_TYPE = "weixin-channels-video:feed-request";
const PAIRING_MESSAGE_TYPE = "weixin-channels-video:pair";
const OFFSCREEN_PARSE_TYPE = "weixin-channels-video:offscreen-parse";
const OFFSCREEN_READ_PAIRING_TYPE = "weixin-channels-video:offscreen-read-pairing";
const OFFSCREEN_CLEAR_PAIRING_TYPE = "weixin-channels-video:offscreen-clear-pairing";
const FEED_RULE_ID = 1;
const FEED_TIMEOUT_MS = 15_000;
const FEED_REQUEST_ID_PATTERN = /^[0-9a-f]{1,16}-[0-9a-f]{8}$/;
const FAILURE_RESULT = { status: 0, body: "", failure: "failed" };
const PAIRING_STORAGE_KEY = "weixin-channels-video:bridge-session";
const RETRY_COUNT_STORAGE_KEY = "weixin-channels-video:bridge-retry-count";
const RECONNECT_ALARM = "weixin-channels-video:bridge-reconnect";
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS_MINUTES = [1, 2, 4, 8, 15];
const OFFSCREEN_URL = "offscreen.html";

// Each request atomically replaces this rule, so that operation retries cleanup if startup fails.
const initialRuleCleanup = chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [FEED_RULE_ID],
}).catch(() => undefined);
let feedRequestQueue = Promise.resolve();

function hasExactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isAllowedFeedSender(sender) {
  return sender?.url === chrome.runtime.getURL("index.html");
}

function validateFeedRequest(message) {
  if (
    !hasExactKeys(message, ["type", "url", "referer", "body"]) ||
    message.type !== FEED_REQUEST_TYPE ||
    typeof message.url !== "string" ||
    typeof message.referer !== "string" ||
    typeof message.body !== "string"
  ) return null;

  try {
    const url = new URL(message.url);
    const queryKeys = [...url.searchParams.keys()].sort();
    const requestId = url.searchParams.get("_rid");
    if (
      url.origin !== CHANNELS_ORIGIN ||
      url.pathname !== new URL(API_URLS.feedInfo).pathname ||
      url.username ||
      url.password ||
      url.hash ||
      queryKeys.length !== 2 ||
      queryKeys[0] !== "_pageUrl" ||
      queryKeys[1] !== "_rid" ||
      url.searchParams.get("_pageUrl") !== CHANNELS_FEED_PAGE_URL ||
      !requestId ||
      !FEED_REQUEST_ID_PATTERN.test(requestId)
    ) return null;

    const expectedUrl = new URL(API_URLS.feedInfo);
    expectedUrl.searchParams.set("_rid", requestId);
    expectedUrl.searchParams.set("_pageUrl", CHANNELS_FEED_PAGE_URL);
    if (url.href !== expectedUrl.href || /[|*^]/.test(url.href)) return null;

    const referer = new URL(message.referer);
    if (
      referer.origin !== CHANNELS_ORIGIN ||
      referer.pathname !== new URL(CHANNELS_FEED_PAGE_URL).pathname ||
      referer.username ||
      referer.password ||
      referer.hash
    ) return null;

    const token = referer.searchParams.get("token");
    const exportId = referer.searchParams.get("eid");
    if (!token || !exportId) return null;

    const body = JSON.parse(message.body);
    if (
      !hasExactKeys(body, ["baseReq", "exportId"]) ||
      !hasExactKeys(body.baseReq, ["generalToken"]) ||
      body.baseReq.generalToken !== token ||
      body.exportId !== exportId
    ) return null;

    return { url: expectedUrl.href, referer: message.referer, body: message.body };
  } catch {
    return null;
  }
}

function feedHeaderRule(request) {
  return {
    id: FEED_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: CHANNELS_ORIGIN },
        { header: "Referer", operation: "set", value: request.referer },
      ],
    },
    condition: {
      urlFilter: `|${request.url}|`,
      isUrlFilterCaseSensitive: true,
      initiatorDomains: [chrome.runtime.id],
      requestMethods: ["post"],
      resourceTypes: ["xmlhttprequest"],
    },
  };
}

async function fetchFeedInfo(request) {
  let result = FAILURE_RESULT;
  let timeoutId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FEED_RULE_ID],
      addRules: [feedHeaderRule(request)],
    });

    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: request.body,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      result = {
        status: response.status,
        body: response.ok ? await response.text() : "",
      };
    } catch {
      result = {
        ...FAILURE_RESULT,
        failure: controller.signal.aborted ? "timeout" : "failed",
      };
    }
  } catch {
    result = FAILURE_RESULT;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [FEED_RULE_ID] });
    } catch {
      result = FAILURE_RESULT;
    }
  }
  return result;
}

function queueFeedRequest(request) {
  const operation = feedRequestQueue.then(async () => {
    await initialRuleCleanup;
    return fetchFeedInfo(request);
  });
  feedRequestQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === PAIRING_MESSAGE_TYPE) {
    if (
      sender?.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.url !== chrome.runtime.getURL("index.html") ||
      !hasExactKeys(message, ["type", "sessionId"]) ||
      typeof message.sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(message.sessionId)
    ) return;
    void pairSession(message.sessionId).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }

  if (message?.type !== FEED_REQUEST_TYPE) return;
  if (
    sender?.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !isAllowedFeedSender(sender)
  ) return;
  const request = validateFeedRequest(message);
  if (!request) return;
  void queueFeedRequest(request).then(sendResponse, () => sendResponse(FAILURE_RESULT));
  return true;
});

let offscreenReady;
async function ensureOffscreenDocument() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const url = chrome.runtime.getURL(OFFSCREEN_URL);
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      if (!contexts.length) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ["IFRAME_SCRIPTING", "LOCAL_STORAGE"],
          justification: "在后台解析固定元宝接口，并迁移本扩展旧版配对信息。",
        });
      }
    })().catch((error) => {
      offscreenReady = undefined;
      throw error;
    });
  }
  return offscreenReady;
}

function enqueuePairing(operation) {
  const result = pairingQueue.then(operation);
  pairingQueue = result.then(() => undefined, () => undefined);
  return result;
}
let pairingQueue = Promise.resolve();
let restoreInProgress;
let nativeConnection;
let nativeRequestQueue = Promise.resolve();
let requestedPairing;

async function scheduleReconnect(resetRetries = false) {
  return enqueuePairing(async () => {
    if (nativeConnection) return;
    try {
      if (resetRetries) await chrome.storage.local.set({ [RETRY_COUNT_STORAGE_KEY]: 0 });
      const stored = await chrome.storage.local.get(RETRY_COUNT_STORAGE_KEY);
      const attempts = Number.isInteger(stored[RETRY_COUNT_STORAGE_KEY])
        ? stored[RETRY_COUNT_STORAGE_KEY]
        : 0;
      if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
      const nextAttempt = attempts + 1;
      await chrome.storage.local.set({ [RETRY_COUNT_STORAGE_KEY]: nextAttempt });
      await chrome.alarms.clear(RECONNECT_ALARM);
      await chrome.alarms.create(RECONNECT_ALARM, {
        delayInMinutes: RECONNECT_DELAYS_MINUTES[nextAttempt - 1],
      });
    } catch {
      // Pairing remains available for the next Chrome startup or explicit CLI connection.
    }
  });
}

function disconnectNative(connection) {
  if (nativeConnection !== connection) return;
  nativeConnection = undefined;
  try { connection.port.disconnect(); }
  catch { /* A disconnected Native Messaging port has no further work to do. */ }
  void scheduleReconnect(connection.ready);
}

function connectNative(sessionId) {
  if (nativeConnection?.sessionId === sessionId) return;
  if (nativeConnection) {
    const previous = nativeConnection;
    nativeConnection = undefined;
    try { previous.port.disconnect(); }
    catch { /* A replaced Native Messaging port has no further work to do. */ }
  }
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST_NAME); }
  catch {
    void scheduleReconnect();
    return;
  }
  const connection = { port, sessionId, ready: false };
  nativeConnection = connection;
  port.onMessage.addListener((message) => {
    if (nativeConnection !== connection) return;
    if (message?.type === "ready") {
      if (!hasExactKeys(message, ["type", "version"]) || message.version !== 1) {
        disconnectNative(connection);
        return;
      }
      connection.ready = true;
      return;
    }
    if (!connection.ready || !validateBridgeCommand(message)) {
      disconnectNative(connection);
      return;
    }
    nativeRequestQueue = nativeRequestQueue.then(async () => {
      if (nativeConnection !== connection) return;
      const response = await handleAgentCommand(message);
      if (nativeConnection === connection) connection.port.postMessage(response);
    }).catch(() => disconnectNative(connection));
  });
  port.onDisconnect.addListener(() => {
    if (nativeConnection !== connection) return;
    nativeConnection = undefined;
    return scheduleReconnect(connection.ready);
  });
  try { port.postMessage({ type: "hello", version: 1, sessionId }); }
  catch { disconnectNative(connection); }
}

function workerRequestFactory() {
  return createExtensionRequest(fetch, async (body) => {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({ type: OFFSCREEN_PARSE_TYPE, body });
    if (!result || !Number.isInteger(result.status) || typeof result.body !== "string") {
      throw new TypeError("The offscreen request returned an invalid response");
    }
    return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
    });
  }, (request) => {
    const validated = validateFeedRequest({ type: FEED_REQUEST_TYPE, ...request });
    if (!validated) throw new TypeError("The feed request is invalid");
    return queueFeedRequest(validated).then((result) => {
      if (result.status === 0) {
        throw new ParseError("UPSTREAM_ERROR", result.failure === "timeout" ? "视频详情请求超时。" : "视频详情请求失败。");
      }
      return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status });
    });
  });
}

const handleAgentCommand = createAgentCommandHandler({
  chromeApi: chrome,
  requestFactory: workerRequestFactory,
  downloadStarter: startDownload,
  downloadWaiter: waitForDownload,
});

async function readStoredOrLegacyPairing() {
  if (requestedPairing) return requestedPairing;
  const stored = await chrome.storage.local.get(PAIRING_STORAGE_KEY);
  if (SESSION_ID_PATTERN.test(stored[PAIRING_STORAGE_KEY] ?? "")) return stored[PAIRING_STORAGE_KEY];

  await ensureOffscreenDocument();
  const legacy = await chrome.runtime.sendMessage({ type: OFFSCREEN_READ_PAIRING_TYPE });
  if (!legacy || !SESSION_ID_PATTERN.test(legacy.sessionId ?? "")) return undefined;
  await chrome.storage.local.set({ [PAIRING_STORAGE_KEY]: legacy.sessionId });
  await chrome.runtime.sendMessage({ type: OFFSCREEN_CLEAR_PAIRING_TYPE, sessionId: legacy.sessionId });
  return legacy.sessionId;
}

async function restoreConnection(resetRetries = false) {
  if (resetRetries && restoreInProgress) await restoreInProgress;
  else if (restoreInProgress) return restoreInProgress;
  let currentRestore;
  currentRestore = enqueuePairing(async () => {
    if (resetRetries) {
      await chrome.storage.local.set({ [RETRY_COUNT_STORAGE_KEY]: 0 });
      await chrome.alarms.clear(RECONNECT_ALARM);
    }
    const sessionId = await readStoredOrLegacyPairing();
    if (sessionId) connectNative(requestedPairing ?? sessionId);
  }).catch(() => {}).finally(() => {
    if (restoreInProgress === currentRestore) restoreInProgress = undefined;
  });
  restoreInProgress = currentRestore;
  return currentRestore;
}

async function restoreConnectionAfterWorkerLoad() {
  try {
    const [stored, alarm] = await Promise.all([
      chrome.storage.local.get([PAIRING_STORAGE_KEY, RETRY_COUNT_STORAGE_KEY]),
      chrome.alarms.get(RECONNECT_ALARM),
    ]);
    if (!SESSION_ID_PATTERN.test(stored[PAIRING_STORAGE_KEY] ?? "")) return;
    const attempts = Number.isInteger(stored[RETRY_COUNT_STORAGE_KEY])
      ? stored[RETRY_COUNT_STORAGE_KEY]
      : 0;
    if (alarm || attempts >= MAX_RECONNECT_ATTEMPTS) return;
    await restoreConnection();
  } catch {
    // Startup and install events still perform a full restore if the state check fails.
  }
}

async function pairSession(sessionId) {
  const previousPairing = requestedPairing;
  requestedPairing = sessionId;
  try {
    return await enqueuePairing(async () => {
      const pairedSession = requestedPairing ?? sessionId;
      await chrome.storage.local.set({
        [PAIRING_STORAGE_KEY]: pairedSession,
        [RETRY_COUNT_STORAGE_KEY]: 0,
      });
      await chrome.alarms.clear(RECONNECT_ALARM);
      connectNative(pairedSession);
    });
  } catch (error) {
    if (requestedPairing === sessionId) requestedPairing = previousPairing;
    throw error;
  }
}

chrome.runtime.onStartup.addListener(() => restoreConnection(true));
chrome.runtime.onInstalled.addListener(() => restoreConnection(true));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativeConnection) return restoreConnection();
});

void restoreConnectionAfterWorkerLoad();

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("index.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  const existingTab = contexts.find((context) => context.tabId >= 0);
  if (existingTab) {
    await chrome.tabs.update(existingTab.tabId, { active: true });
    await chrome.windows.update(existingTab.windowId, { focused: true });
  }
  else await chrome.tabs.create({ url });
});
