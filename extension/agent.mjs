import { checkLogin, PARSE_ERROR_MESSAGES, ParseError, parseShareLink } from "../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, SESSION_ID_PATTERN, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, startDownload, waitForDownload } from "./app.mjs";

const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });

const VIDEO_RESULT_FIELDS = ["title", "author", "coverUrl", "previewUrl", "downloadUrl"];

function safeError(error) {
  const candidate = error instanceof ParseError ? error.code : error?.message;
  const code = candidate === "DOWNLOAD_STATUS_UNAVAILABLE"
    ? "DOWNLOAD_FAILED"
    : Object.hasOwn(ERROR_MESSAGES, candidate) ? candidate : "UPSTREAM_ERROR";
  return { code, message: ERROR_MESSAGES[code] };
}

function projectVideoResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("UPSTREAM_ERROR");
  const output = {};
  for (const key of VIDEO_RESULT_FIELDS) {
    if (typeof result[key] !== "string") throw new Error("UPSTREAM_ERROR");
    output[key] = result[key];
  }
  if (!Array.isArray(result.mediaVariants)) throw new Error("UPSTREAM_ERROR");
  output.mediaVariants = result.mediaVariants.map((variant) => {
    if (!variant || typeof variant.label !== "string" || typeof variant.downloadUrl !== "string") {
      throw new Error("UPSTREAM_ERROR");
    }
    return { label: variant.label, downloadUrl: variant.downloadUrl };
  });
  return output;
}

export function createAgentCommandHandler({
  chromeApi = globalThis.chrome,
  requestFactory = () => createExtensionRequest(),
  loginChecker = checkLogin,
  parser = parseShareLink,
  downloadStarter = startDownload,
  downloadWaiter = waitForDownload,
} = {}) {
  return async (request) => {
    if (!validateBridgeCommand(request)) {
      return { id: request?.id, ok: false, error: { code: "INVALID_COMMAND", message: BRIDGE_ERROR_MESSAGES.INVALID_COMMAND } };
    }
    try {
      if (request.command === "status") {
        const login = await loginChecker(requestFactory());
        return { id: request.id, ok: true, result: { login: login.status } };
      }

      const video = await parser(request.url, { request: requestFactory() });
      if (request.command === "parse") {
        return { id: request.id, ok: true, result: projectVideoResult(video) };
      }

      let downloadId;
      try { downloadId = await downloadStarter(video, chromeApi, request.filename); }
      catch { throw new Error("DOWNLOAD_FAILED"); }
      const download = await downloadWaiter(downloadId, chromeApi);
      if (
        !download ||
        !["complete", "interrupted"].includes(download.state) ||
        typeof download.path !== "string" ||
        !download.path ||
        !download.path.startsWith("/") ||
        !Number.isInteger(download.bytes) ||
        download.bytes <= 0
      ) throw new Error("DOWNLOAD_EMPTY");
      if (download.state === "interrupted") {
        return {
          id: request.id,
          ok: false,
          error: { code: "DOWNLOAD_INTERRUPTED", message: ERROR_MESSAGES.DOWNLOAD_INTERRUPTED },
          result: { state: download.state, path: download.path, bytes: download.bytes },
        };
      }
      return {
        id: request.id,
        ok: true,
        result: {
          ...projectVideoResult(video),
          state: download.state,
          path: download.path,
          bytes: download.bytes,
        },
      };
    } catch (error) {
      return { id: request.id, ok: false, error: safeError(error) };
    }
  };
}

const PAIRING_MESSAGE_TYPE = "weixin-channels-video:pair";

export function startAgent({ chromeApi = globalThis.chrome, windowApi = globalThis } = {}) {
  const acceptPairing = async () => {
    const match = windowApi.location.hash.match(/^#agent-connect=(.*)$/);
    if (!match) return;
    const sessionId = match[1];
    try {
      windowApi.history.replaceState(windowApi.history.state, "", chromeApi.runtime.getURL("index.html"));
    } catch {
      return;
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) return;
    try {
      const response = await chromeApi.runtime.sendMessage({ type: PAIRING_MESSAGE_TYPE, sessionId });
      if (response?.ok !== true) return;
      const tab = await chromeApi.tabs.getCurrent();
      if (Number.isInteger(tab?.id)) await chromeApi.tabs.remove(tab.id);
    } catch {
      // Keep the bootstrap page open when pairing was not acknowledged.
    }
  };
  windowApi.addEventListener("hashchange", () => { void acceptPairing(); });
  void acceptPairing();
}

if (typeof document !== "undefined") void startAgent();
