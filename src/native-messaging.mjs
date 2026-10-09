export const NATIVE_HOST_NAME = "com.mc0571.weixin_channels_video";
export const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const BRIDGE_ERROR_MESSAGES = Object.freeze({
  INVALID_COMMAND: "桥接命令无效。",
  BRIDGE_BUSY: "本地扩展正在处理另一个请求。",
  BRIDGE_DISCONNECTED: "Chrome 扩展连接已断开。",
  BRIDGE_CONNECTION_FAILED: "无法连接 Chrome 扩展，请检查本地桥接权限。",
  BRIDGE_NOT_CONFIGURED: "请先运行 install-bridge 配置 Native Messaging。",
  BRIDGE_TIMEOUT: "本地扩展请求超时；Chrome 下载可能仍会继续。",
  BRIDGE_SESSION_MISMATCH: "Chrome 扩展会话不匹配。",
  BRIDGE_PROTOCOL_ERROR: "本地扩展返回了无效响应。",
  CHROME_UNAVAILABLE: "无法启动 Google Chrome，请检查应用是否已安装。",
  BRIDGE_INSTALL_FAILED: "无法安装本地连接，请检查 Chrome 配置目录权限。",
  DOWNLOAD_FAILED: "Chrome 无法开始或读取下载。",
  DOWNLOAD_EMPTY: "Chrome 下载文件为空，未报告完成。",
  DOWNLOAD_TIMEOUT: "等待 Chrome 下载结束超时；下载可能仍会继续。",
  DOWNLOAD_INTERRUPTED: "Chrome 下载已中断。",
  DOWNLOAD_STATUS_UNAVAILABLE: "Chrome 无法读取下载状态。",
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeBridgeFrame(value, maxBytes = MAX_BRIDGE_MESSAGE_BYTES) {
  const body = encoder.encode(JSON.stringify(value));
  if (body.byteLength === 0 || body.byteLength > maxBytes) {
    throw new RangeError("Bridge message size is invalid.");
  }
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, 4);
  return frame;
}

export class BridgeFrameDecoder {
  #buffer = new Uint8Array();

  constructor(maxBytes = MAX_BRIDGE_MESSAGE_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const combined = new Uint8Array(this.#buffer.byteLength + bytes.byteLength);
    combined.set(this.#buffer);
    combined.set(bytes, this.#buffer.byteLength);
    this.#buffer = combined;

    const messages = [];
    let offset = 0;
    while (this.#buffer.byteLength - offset >= 4) {
      const length = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        4,
      ).getUint32(0, true);
      if (length === 0 || length > this.maxBytes) {
        this.#buffer = new Uint8Array();
        throw new RangeError("Bridge message size is invalid.");
      }
      if (this.#buffer.byteLength - offset - 4 < length) break;

      const body = this.#buffer.subarray(offset + 4, offset + 4 + length);
      messages.push(JSON.parse(decoder.decode(body)));
      offset += length + 4;
    }
    if (offset > 0) this.#buffer = this.#buffer.slice(offset);
    return messages;
  }

  finish() {
    if (this.#buffer.byteLength !== 0) {
      this.#buffer = new Uint8Array();
      throw new Error("Bridge connection closed mid-message.");
    }
  }
}

export function isSafeRelativeMp4Filename(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.toLowerCase().endsWith(".mp4") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f<>:"|?*]/.test(value)
  ) return false;

  const parts = value.split("/");
  return parts.every((part) => {
    if (!part || part === "." || part === "..") return false;
    return encoder.encode(part).byteLength <= 255;
  });
}

function hasExactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function validateBridgeCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { id, command } = value;
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return false;

  if (command === "status") return hasExactKeys(value, ["id", "command"]);
  if (command === "parse") {
    return hasExactKeys(value, ["id", "command", "url"]) &&
      typeof value.url === "string" && value.url.length > 0;
  }
  if (command === "download") {
    const fieldsAreValid = hasExactKeys(value, ["id", "command", "url"]) ||
      hasExactKeys(value, ["id", "command", "url", "filename"]);
    return fieldsAreValid &&
      typeof value.url === "string" && value.url.length > 0 &&
      (value.filename === undefined || isSafeRelativeMp4Filename(value.filename));
  }
  return false;
}

export function validateBridgeResponse(value, requestId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.id !== requestId ||
    typeof value.ok !== "boolean"
  ) return false;

  if (value.ok) return hasExactKeys(value, ["id", "ok", "result"]);
  const hasErrorShape = hasExactKeys(value, ["id", "ok", "error"]) ||
    hasExactKeys(value, ["id", "ok", "error", "result"]);
  const downloadResultIsValid = !Object.hasOwn(value, "result") || (
    value.error?.code === "DOWNLOAD_INTERRUPTED" &&
    hasExactKeys(value.result, ["state", "path", "bytes"]) &&
    value.result.state === "interrupted" &&
    typeof value.result.path === "string" && value.result.path.startsWith("/") &&
    Number.isInteger(value.result.bytes) && value.result.bytes > 0
  );
  return hasErrorShape && downloadResultIsValid &&
    value.error &&
    typeof value.error === "object" &&
    !Array.isArray(value.error) &&
    Object.keys(value.error).length === 2 &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string";
}
