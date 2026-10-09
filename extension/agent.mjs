import { checkLogin, PARSE_ERROR_MESSAGES, ParseError, parseShareLink } from "../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, NATIVE_HOST_NAME, SESSION_ID_PATTERN, validateBridgeCommand } from "../src/native-messaging.mjs";
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

const CONNECTION_FAILED_MESSAGE = "连接失败，请让 AI 助手检查本地连接组件。";
const CONNECTION_CLOSED_MESSAGE = "连接已关闭。关闭连接不会取消已接收的任务或已开始的下载。";
const PAIRING_STORAGE_KEY = "weixin-channels-video:bridge-session";

export function createAgentConnectionController({
  chromeApi = globalThis.chrome,
  sessionId,
  readSession = () => sessionId,
  toggleButton,
  statusElement,
  handleCommand = createAgentCommandHandler({ chromeApi }),
} = {}) {
  let activeConnection;

  const setState = (connected, message) => {
    if (toggleButton) {
      toggleButton.setAttribute("aria-checked", String(connected));
      toggleButton.textContent = connected ? "关闭 AI 连接" : "开启 AI 连接";
    }
    if (statusElement) statusElement.textContent = message;
  };

  const disconnect = () => {
    const connection = activeConnection;
    if (!connection) {
      setState(false, CONNECTION_CLOSED_MESSAGE);
      return;
    }
    activeConnection = undefined;
    setState(false, CONNECTION_CLOSED_MESSAGE);
    try { connection.port.disconnect(); }
    catch { /* A disconnected Native Messaging port has no further work to do. */ }
  };

  const failConnection = (connection) => {
    if (activeConnection !== connection) return;
    activeConnection = undefined;
    setState(false, CONNECTION_FAILED_MESSAGE);
    try { connection.port.disconnect(); }
    catch { /* A failed port is already unusable. */ }
  };

  const connect = () => {
    let pairedSession;
    try { pairedSession = readSession(); }
    catch {
      if (activeConnection) failConnection(activeConnection);
      else setState(false, CONNECTION_FAILED_MESSAGE);
      return;
    }
    if (typeof pairedSession !== "string" || !SESSION_ID_PATTERN.test(pairedSession)) {
      if (activeConnection) disconnect();
      setState(false, "首次连接请让 AI 助手完成配置，然后即可在此开启或关闭连接。");
      return;
    }
    if (activeConnection?.sessionId === pairedSession) return;
    if (activeConnection) disconnect();
    if (!chromeApi?.runtime?.connectNative) {
      setState(false, CONNECTION_FAILED_MESSAGE);
      return;
    }
    setState(true, "正在连接本地组件…");
    let port;
    try { port = chromeApi.runtime.connectNative(NATIVE_HOST_NAME); }
    catch {
      setState(false, CONNECTION_FAILED_MESSAGE);
      return;
    }

    const connection = { port, sessionId: pairedSession, requestQueue: Promise.resolve() };
    activeConnection = connection;
    port.onMessage.addListener((message) => {
      if (activeConnection !== connection) return;
      if (message?.type === "ready") {
        if (Object.keys(message).length !== 2 || message.version !== 1) {
          failConnection(connection);
          return;
        }
        setState(true, "AI 助手已连接，使用期间请保留此页面。");
        return;
      }
      if (!validateBridgeCommand(message)) {
        failConnection(connection);
        return;
      }
      connection.requestQueue = connection.requestQueue.then(async () => {
        const response = await handleCommand(message);
        if (activeConnection === connection) connection.port.postMessage(response);
      });
      connection.requestQueue.catch(() => {
        failConnection(connection);
      });
    });
    port.onDisconnect.addListener(() => {
      const hasError = Boolean(chromeApi.runtime.lastError);
      if (activeConnection !== connection) return;
      activeConnection = undefined;
      setState(false, hasError ? CONNECTION_FAILED_MESSAGE : CONNECTION_CLOSED_MESSAGE);
    });
    try { port.postMessage({ type: "hello", version: 1, sessionId: pairedSession }); }
    catch {
      failConnection(connection);
    }
  };

  toggleButton?.addEventListener("click", () => {
    if (toggleButton.getAttribute("aria-checked") === "true") disconnect();
    else connect();
  });
  setState(false, "AI 助手连接已关闭。首次使用请让 AI 助手安装本地连接组件。手动解析和下载不受影响。");

  return { connect, disconnect, isConnected: () => Boolean(activeConnection) };
}

export async function startAgent({
  chromeApi = globalThis.chrome,
  documentApi = globalThis.document,
  windowApi = globalThis,
} = {}) {
  const toggleButton = documentApi.querySelector("#agent-connect-toggle");
  const statusElement = documentApi.querySelector("#agent-connect-status");
  if (!toggleButton || !statusElement) return;
  const controller = createAgentConnectionController({
    chromeApi,
    readSession: () => windowApi.localStorage.getItem(PAIRING_STORAGE_KEY),
    toggleButton,
    statusElement,
  });

  const acceptPairing = async (reuseExistingPage) => {
    const pairing = windowApi.location.hash.match(/^#agent-connect=([0-9a-f-]+)$/);
    if (!pairing) return;
    const url = chromeApi.runtime.getURL("index.html");
    try {
      windowApi.history.replaceState(windowApi.history.state, "", url);
      if (!SESSION_ID_PATTERN.test(pairing[1])) return;
      // Extension-origin storage is isolated per Chrome profile.
      windowApi.localStorage.setItem(PAIRING_STORAGE_KEY, pairing[1]);
      if (reuseExistingPage) {
        const currentTab = await chromeApi.tabs.getCurrent();
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ["TAB"], documentUrls: [url, `${url}#agent-connect=${pairing[1]}`],
        });
        const winner = Math.min(currentTab.id, ...contexts.filter((context) => context.tabId >= 0).map((context) => context.tabId));
        const existingPage = contexts.find((context) => context.tabId === winner && context.tabId !== currentTab.id);
        if (existingPage) {
          await chromeApi.tabs.update(existingPage.tabId, { url: `${url}#agent-connect=${pairing[1]}`, active: true });
          await chromeApi.windows.update(existingPage.windowId, { focused: true });
          await chromeApi.tabs.remove(currentTab.id);
          return;
        }
      }
      controller.connect();
    } catch {
      statusElement.textContent = CONNECTION_FAILED_MESSAGE;
    }
  };
  windowApi.addEventListener("hashchange", () => { void acceptPairing(false); });
  await acceptPairing(true);
  return controller;
}

if (typeof document !== "undefined") void startAgent();
