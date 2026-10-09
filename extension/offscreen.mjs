import { requestParseShareInHiddenIframe } from "./app.mjs";

const PARSE_REQUEST_TYPE = "weixin-channels-video:offscreen-parse";
const READ_PAIRING_TYPE = "weixin-channels-video:offscreen-read-pairing";
const CLEAR_PAIRING_TYPE = "weixin-channels-video:offscreen-clear-pairing";
const PAIRING_STORAGE_KEY = "weixin-channels-video:bridge-session";
const FAILURE_RESULT = { status: 0, body: "" };

function hasExactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isBackgroundSender(sender) {
  return sender?.id === chrome.runtime.id &&
    sender.documentId === undefined &&
    sender.tab === undefined &&
    (!sender.url || sender.url === chrome.runtime.getURL("background.js"));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isBackgroundSender(sender)) return;

  if (message?.type === READ_PAIRING_TYPE && hasExactKeys(message, ["type"])) {
    let sessionId = null;
    try { sessionId = window.localStorage.getItem(PAIRING_STORAGE_KEY); }
    catch { /* A blocked legacy store is treated as unavailable. */ }
    sendResponse({ sessionId });
    return;
  }

  if (
    message?.type === CLEAR_PAIRING_TYPE &&
    hasExactKeys(message, ["type", "sessionId"]) &&
    typeof message.sessionId === "string"
  ) {
    try {
      if (window.localStorage.getItem(PAIRING_STORAGE_KEY) === message.sessionId) {
        window.localStorage.removeItem(PAIRING_STORAGE_KEY);
      }
    } catch { /* The new chrome.storage.local value is already committed. */ }
    sendResponse({ ok: true });
    return;
  }

  if (
    message?.type !== PARSE_REQUEST_TYPE ||
    !hasExactKeys(message, ["type", "body"]) ||
    typeof message.body !== "string"
  ) return;

  void requestParseShareInHiddenIframe(message.body).then(async (response) => ({
      status: response.status,
      body: response.ok ? await response.text() : "",
    })).then(sendResponse, () => sendResponse(FAILURE_RESULT));
  return true;
});
