import { checkLogin, PARSE_ERROR_MESSAGES, ParseError, parseShareLink } from "../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, SESSION_ID_PATTERN, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, startDownload, waitForDownload } from "./app.mjs";

const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });

const VIDEO_RESULT_FIELDS = ["title", "author", "coverUrl", "previewUrl", "downloadUrl"];
const STORE_EXTENSION_ID = "jdecfnemmnhbpamcfhmgjkcphgomgjoe";

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

function initializeAIDownloadPrompt({ chromeApi = globalThis.chrome, windowApi = globalThis } = {}) {
  const openButton = document.querySelector("#ai-download-prompt-open");
  const popover = document.querySelector("#ai-download-prompt-popover");
  const promptText = document.querySelector("#ai-download-prompt-text");
  const copyButton = document.querySelector("#ai-download-prompt-copy");
  const copyStatus = document.querySelector("#ai-prompt-copy-status");
  if (!openButton || !popover || !promptText || !copyButton || !copyStatus) return;

  const runtimeExtensionId = chromeApi?.runtime?.id;
  const extensionId = runtimeExtensionId
    ? `当前页面运行中的扩展 ID（来自 chrome.runtime.id）：${runtimeExtensionId}`
    : "当前运行中的扩展 ID：HTTP 预览无法读取，请从当前 Chrome profile 查询实际安装版本的 ID。";
  const prompt = [
    "请先为我安装并准备连接视频号分享链接解析工具。本次只安装并完成连接准备，暂不解析或下载。之后我明确提出下载请求并提供分享链接时，请直接按 Skill 执行，无需再次确认。",
    "",
    "安装 Skill：",
    "npx skills add MC0571/weixin-channels-video --skill weixin-channels-video",
    "",
    "首次准备：安装后找到此 Skill 的本地目录，并运行：",
    "node <skill-root>/scripts/run.mjs prepare",
    "其中 <skill-root> 是刚安装的 weixin-channels-video Skill 目录。",
    "",
    "优先复用此页面所在的 Chrome profile 和已经安装的扩展，不要另开 profile 或重复安装。",
    extensionId,
    `Chrome 网上应用店公开版 ID：${STORE_EXTENSION_ID}`,
    "连接时优先使用当前页面提供的运行时 ID；若页面没有运行时 ID，先从当前 Chrome profile 查询实际安装版本。开发或解压版必须使用它自己的实际 ID；仅商店安装版使用上面的公开版 ID。",
    "",
    "隐私边界：不要请求、复制或公开 Cookie、登录凭据、配对 secret 或 generalToken，也不要把它们写入公共日志。解析产生的临时媒体链接仅用于本次视频展示或下载，不写入公共日志。",
  ].join("\n");
  promptText.value = prompt;

  const updatePopoverPosition = () => {
    if (!popover.matches(":popover-open")) return;
    const anchor = openButton.getBoundingClientRect();
    const viewportWidth = windowApi.innerWidth;
    const viewportHeight = windowApi.innerHeight;
    const panel = popover.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const maxLeft = Math.max(margin, viewportWidth - panel.width - margin);
    const left = Math.min(maxLeft, Math.max(margin, anchor.right - panel.width));
    const below = anchor.bottom + gap;
    const above = anchor.top - panel.height - gap;
    const top = below + panel.height <= viewportHeight - margin
      ? below
      : above >= margin ? above : Math.max(margin, viewportHeight - panel.height - margin);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  popover.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    copyStatus.textContent = "";
    copyStatus.dataset.error = "false";
    delete popover.dataset.positioned;
  });
  popover.addEventListener("toggle", (event) => {
    const isOpen = event.newState === "open";
    openButton.setAttribute("aria-expanded", String(isOpen));
    if (!isOpen) {
      delete popover.dataset.positioned;
      return;
    }
    updatePopoverPosition();
    popover.dataset.positioned = "true";
    promptText.focus({ preventScroll: true });
    promptText.setSelectionRange(0, 0);
    promptText.scrollTop = 0;
  });
  windowApi.addEventListener("resize", updatePopoverPosition);
  windowApi.addEventListener("scroll", updatePopoverPosition, true);
  copyButton.addEventListener("click", async () => {
    try {
      await windowApi.navigator.clipboard.writeText(promptText.value);
      copyStatus.textContent = "提示词已复制。请切换到 Agent 对话框并自行粘贴。";
      copyStatus.dataset.error = "false";
      updatePopoverPosition();
    } catch {
      promptText.focus();
      promptText.select();
      copyStatus.textContent = "复制失败，全文已选中。请按 Command+C（Mac）或 Ctrl+C（Windows/Linux）手动复制。";
      copyStatus.dataset.error = "true";
      updatePopoverPosition();
    }
  });
}

if (typeof document !== "undefined") {
  void startAgent();
  initializeAIDownloadPrompt();
}
