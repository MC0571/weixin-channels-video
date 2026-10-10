import { checkLogin, PARSE_ERROR_MESSAGES, ParseError, parseShareLink } from "../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, isAbsoluteDownloadPath, SESSION_ID_PATTERN, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, startDownload, waitForDownload } from "./app.mjs";

const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });

const VIDEO_RESULT_FIELDS = ["title", "author", "coverUrl", "previewUrl", "downloadUrl"];
const STORE_EXTENSION_ID = "jdecfnemmnhbpamcfhmgjkcphgomgjoe";
const BRIDGE_CONNECTION_STORAGE_KEY = "weixin-channels-video:bridge-connection-state";
const BRIDGE_CONNECTION_STAGES = new Set(["pairing_saved", "host_starting", "host_ready", "failed"]);
const BRIDGE_CONNECTION_REASONS = new Set([
  "connect_native_failed",
  "host_not_found",
  "host_not_registered",
  "host_start_failed",
  "host_access_forbidden",
  "host_exited",
  "host_communication_failed",
  "host_disconnected",
  "invalid_ready_message",
  "invalid_host_message",
]);
const BRIDGE_CONNECTION_MESSAGES = Object.freeze({
  pairing_saved: "已保存配对信息，正在连接。",
  host_starting: "正在连接本地程序。",
  host_ready: "浏览器已连接本地程序，AI 仍需确认连接和登录状态。",
  failed: "连接本地程序失败。请让 AI 检查 Skill 状态。",
});
const BRIDGE_CONNECTION_FAILURE_MESSAGES = Object.freeze({
  connect_native_failed: "浏览器连接本地程序失败。请让 AI 检查 Skill 配置。",
  host_not_found: "找不到本地程序。请让 AI 检查 Skill 是否安装。",
  host_not_registered: "本地程序尚未注册。请让 AI 检查 Skill 配置。",
  host_start_failed: "本地程序启动失败。请让 AI 检查运行环境。",
  host_access_forbidden: "浏览器未获准访问本地程序。请让 AI 检查扩展 ID 和配置。",
  host_exited: "本地程序已退出。请让 AI 检查运行状态。",
  host_communication_failed: "浏览器与本地程序通信失败。请让 AI 检查连接。",
  host_disconnected: "与本地程序的连接已断开。请让 AI 检查连接。",
  invalid_ready_message: "本地程序返回的启动状态无效。请让 AI 检查扩展和 Skill 版本。",
  invalid_host_message: "本地程序返回的数据无法识别。请让 AI 检查扩展和 Skill 版本。",
});

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

function isBridgeConnectionState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return value.version === 1 &&
    BRIDGE_CONNECTION_STAGES.has(value.stage) &&
    keys.every((key) => key === "version" || key === "stage" || key === "reason") &&
    (!Object.hasOwn(value, "reason") || BRIDGE_CONNECTION_REASONS.has(value.reason));
}

function initializeBridgeConnectionStatus({ chromeApi = globalThis.chrome } = {}) {
  const statusElement = document.querySelector("#bridge-connection-status");
  const storage = chromeApi?.storage?.local;
  const storageChanges = chromeApi?.storage?.onChanged;
  if (!statusElement || typeof storage?.get !== "function" || typeof storageChanges?.addListener !== "function") return;

  let changeVersion = 0;
  const render = (value) => {
    if (!isBridgeConnectionState(value)) {
      statusElement.textContent = "";
      statusElement.hidden = true;
      statusElement.removeAttribute("data-error");
      return;
    }

    statusElement.textContent = value.stage === "failed"
      ? BRIDGE_CONNECTION_FAILURE_MESSAGES[value.reason] ?? BRIDGE_CONNECTION_MESSAGES.failed
      : BRIDGE_CONNECTION_MESSAGES[value.stage];
    statusElement.hidden = false;
    statusElement.dataset.error = String(value.stage === "failed");
  };
  storageChanges.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.hasOwn(changes ?? {}, BRIDGE_CONNECTION_STORAGE_KEY)) return;
    changeVersion += 1;
    render(changes[BRIDGE_CONNECTION_STORAGE_KEY].newValue);
  });

  const initialChangeVersion = changeVersion;
  Promise.resolve().then(() => storage.get(BRIDGE_CONNECTION_STORAGE_KEY)).then((stored) => {
    if (initialChangeVersion === changeVersion) render(stored?.[BRIDGE_CONNECTION_STORAGE_KEY]);
  }).catch(() => {
    if (initialChangeVersion === changeVersion) render(undefined);
  });
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
        !isAbsoluteDownloadPath(download.path) ||
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
    "请为我安装并准备视频号分享链接解析工具。本次仅安装并完成连接准备，暂不解析或下载。之后我明确提供分享链接并要求下载时，直接按 Skill 执行。",
    "",
    "先确定你实际运行的 Agent、OS、CPU 架构、Shell/执行环境，以及能否操作目标机器上的 Chrome。若处于云端、远端或隔离环境，不要假设能访问本机 Chrome。",
    "扩展页面里的 ID 和 profile 只作线索；在目标机器、选定 Chrome profile 中核实实际安装来源、启用状态和 ID。唯一 profile 直接使用；多个 profile 且我未指定时只问我一次，并在后续步骤复用。不要逐个尝试账号或创建新 profile。",
    "",
    "在运行任何 node/npm/npx/prepare 命令前，先读取并遵守此安装说明（当前可从 GitHub 直接读取）：",
    "https://github.com/MC0571/weixin-channels-video/blob/main/skills/weixin-channels-video/references/agent-installation.md",
    "Skill 最低需要 Node.js 22.22.2。核实目标 Agent 的实际执行环境、Node 版本和绝对路径；已有兼容 Node 直接复用。缺失或版本过低时，沿用我当前任务或仍有效的安装委托，只从 Node 官方来源获取匹配 OS/架构的版本并核验 SHA-256；保留已有 Node 与 Shell 配置。Windows 原生与 WSL 分别处理；WSL 的 Linux Node 不能注册 Windows Chrome host。若宿主/系统实际拦截或要求额外审批，准确交接并由我完成该确认，不关闭安全策略。",
    "",
    "获取完整 Skill：优先下载 GitHub Releases 中的正式 Skill TAR.GZ/ZIP，先按同版本 SHA256SUMS 校验，再安装 SKILL.md、scripts、references 和所有随包资源；不要求克隆源码仓库或自行构建。只有确认目标是受支持的 CLI 且 Node 已满足要求时，才使用 skills CLI。先检查用户级目标中没有同名 Skill 或本地修改；若已有则按官方更新方式处理，不能用自动确认覆盖。目标为空时明确安装范围并指定单个 Agent 与 Skill；例如 codex 命令为：",
    "npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex",
    "其他 Agent 必须按实际产品换成唯一对应的键，不能照抄 codex 示例。",
    "不要省略 --agent、不要用 --all。WorkBuddy、豆包工作和 QwenWork 使用各自官方入口；产品、导入包格式或本地命令能力未明确时，说明未知并交接，不借用 CodeBuddy/Qwen Code 映射。",
    "",
    "Skill 安装后读取完整 SKILL.md 和 references，运行 prepare，再运行普通 diagnose；先处理顶层 nextAction 并重新诊断。runtime 描述包内资源版本，currentNode 是运行 CLI 的 Node，bridge.node / bridge.nodeVersion 是桥接使用的 Node。桥接未注册但目标 profile 和扩展 ID 已知时，用 `diagnose --profile <directory-or-unique-name> --extension-id <extension-id>` 做成对的只读候选检查；candidate.nextAction 是候选项的具体动作，若同时存在顶层 nextAction，先处理顶层项（Chrome/Node 阻断项优先，候选动作早于未配置桥接的泛化动作）。candidate.status 仅表示 profile 元数据记录，liveHandshake 是 not_checked；还需在目标 profile 的 chrome://extensions 核实扩展来源、启用状态和 ID。已有扩展且 ID、profile 和桥接有效时直接复用；扩展缺失时，从 prepare 返回的 extensionAssets 加载扩展。旧加载位置仍有效时不要仅因出现新资源路径而强制重装；确需改加载路径时重新读取目标 profile 中的实际 ID，再配置桥接。继续完成 install-bridge、connect 和 status，以真实握手与登录检查确认就绪。",
    "若仅缺少桌面操作能力但仍能在目标机器读写文件、运行命令并下载 Release，先完成下载、校验和解压，再交接最短的人工加载步骤；如果没有目标机文件/命令能力，就说明哪些准备无法代办，不要声称已完成。首次打开、系统授权、扫码和验证码由我完成；普通可逆安装沿用我当前任务中的授权，不重复询问。",
    "",
    extensionId,
    `Chrome 网上应用店公开版 ID：${STORE_EXTENSION_ID}`,
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
  initializeBridgeConnectionStatus();
}
