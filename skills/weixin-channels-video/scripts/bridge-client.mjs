import { connect as connectSocket } from "node:net";
import { BRIDGE_ERROR_MESSAGES, BridgeFrameDecoder, encodeBridgeFrame, validateBridgeCommand, validateBridgeResponse } from "../../../src/native-messaging.mjs";
import { PARSE_ERROR_MESSAGES } from "../../../src/core.mjs";
import { bridgeSocketPath, readBridgeSession } from "./bridge-install.mjs";

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

const CONNECT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const READY_TYPE = "ready";
const DISCONNECTED_SOCKET_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET"]);

function isReadyMessage(message, sessionId) {
  return message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    Object.keys(message).length === 2 &&
    message.type === READY_TYPE &&
    message.sessionId === sessionId;
}

function openBridgeSocket(socketPath, sessionId, request, timeoutMs, connectImpl = connectSocket) {
  return new Promise((resolve, reject) => {
    const socket = connectImpl(socketPath);
    const decoder = new BridgeFrameDecoder();
    let stage = "ready";
    let settled = false;
    const timeoutId = setTimeout(() => finish(new BridgeError(
      "BRIDGE_TIMEOUT",
      BRIDGE_ERROR_MESSAGES.BRIDGE_TIMEOUT,
    )), timeoutMs);

    const removeListeners = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      removeListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onConnect = () => {};
    const onEnd = () => finish(new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED));
    const onClose = () => finish(new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED));
    const onError = (error) => {
      const code = DISCONNECTED_SOCKET_CODES.has(error?.code)
        ? "BRIDGE_DISCONNECTED"
        : "BRIDGE_CONNECTION_FAILED";
      finish(new BridgeError(code, BRIDGE_ERROR_MESSAGES[code]));
    };
    const onData = (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); }
      catch { finish(new BridgeError("BRIDGE_PROTOCOL_ERROR", BRIDGE_ERROR_MESSAGES.BRIDGE_PROTOCOL_ERROR)); return; }
      for (const message of messages) {
        if (stage === "ready") {
          if (!isReadyMessage(message, sessionId)) {
            finish(new BridgeError("BRIDGE_SESSION_MISMATCH", BRIDGE_ERROR_MESSAGES.BRIDGE_SESSION_MISMATCH));
            return;
          }
          if (!request) {
            finish(null, true);
            return;
          }
          stage = "response";
          try { socket.write(Buffer.from(encodeBridgeFrame({ sessionId, request }))); }
          catch { finish(new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED)); return; }
          continue;
        }
        if (!validateBridgeResponse(message, request.id)) {
          finish(new BridgeError("BRIDGE_PROTOCOL_ERROR", BRIDGE_ERROR_MESSAGES.BRIDGE_PROTOCOL_ERROR));
          return;
        }
        finish(null, message);
        return;
      }
    };

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

export async function waitForBridge(config, sessionId, {
  timeoutMs = CONNECT_TIMEOUT_MS,
  connectImpl = connectSocket,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const socketPath = bridgeSocketPath(config, sessionId);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      await openBridgeSocket(socketPath, sessionId, null, Math.min(POLL_INTERVAL_MS * 2, deadline - now()), connectImpl);
      return;
    } catch (error) {
      if (
        !(error instanceof BridgeError) ||
        !["BRIDGE_DISCONNECTED", "BRIDGE_TIMEOUT"].includes(error.code)
      ) throw error;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
    }
  }
  throw new BridgeError("BRIDGE_TIMEOUT", BRIDGE_ERROR_MESSAGES.BRIDGE_TIMEOUT);
}

export async function requestBridge(config, sessionId, request, {
  timeoutMs = 90_000,
  connectImpl = connectSocket,
} = {}) {
  if (!validateBridgeCommand(request)) throw new BridgeError("INVALID_COMMAND", BRIDGE_ERROR_MESSAGES.INVALID_COMMAND);
  const response = await openBridgeSocket(
    bridgeSocketPath(config, sessionId),
    sessionId,
    request,
    timeoutMs,
    connectImpl,
  );
  if (!response.ok) {
    const { code } = response.error;
    throw new BridgeError(code, PARSE_ERROR_MESSAGES[code] ?? BRIDGE_ERROR_MESSAGES[code] ?? "请求失败。", response.result);
  }
  return response.result;
}

export async function requestCurrentBridge(config, request, options) {
  const sessionId = await readBridgeSession(config);
  if (!sessionId) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
  return requestBridge(config, sessionId, request, options);
}
