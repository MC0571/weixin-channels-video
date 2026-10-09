import { API_URLS } from "../src/core.mjs";

const CHANNELS_ORIGIN = "https://channels.weixin.qq.com";
const CHANNELS_FEED_PAGE_URL = `${CHANNELS_ORIGIN}/finder-preview/pages/feed`;
const FEED_REQUEST_TYPE = "weixin-channels-video:feed-request";
const FEED_RULE_ID = 1;
const FEED_TIMEOUT_MS = 15_000;
const FEED_REQUEST_ID_PATTERN = /^[0-9a-f]{1,16}-[0-9a-f]{8}$/;
const FAILURE_RESULT = { status: 0, body: "", failure: "failed" };

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

function validateFeedRequest(message, sender) {
  if (
    sender?.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !isAllowedFeedSender(sender) ||
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
  if (message?.type !== FEED_REQUEST_TYPE) return;
  const request = validateFeedRequest(message, sender);
  if (!request) return;
  void queueFeedRequest(request).then(sendResponse, () => sendResponse(FAILURE_RESULT));
  return true;
});

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
