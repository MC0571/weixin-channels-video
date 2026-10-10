import { connect as connectSocket } from "node:net";
import { PARSE_ERROR_MESSAGES } from "../../../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, BridgeFrameDecoder, encodeBridgeFrame, MAX_BRIDGE_MESSAGE_BYTES, validateBridgeCommand, validateBridgeResponse } from "../../../src/native-messaging.mjs";
import { createIpcNonce, createIpcProof, IPC_AUTH_TIMEOUT_MS, isIpcSession, verifyIpcProof } from "../../../src/native-ipc.mjs";
import { bridgeSocketPath, readBridgeSessionInfo } from "./bridge-install.mjs";

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
const DISCONNECTED_SOCKET_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function openBridgeSocket(socketPath, sessionInfo, request, timeoutMs, connectImpl = connectSocket) {
  return new Promise((resolve, reject) => {
    const socket = connectImpl(socketPath);
    const decoder = new BridgeFrameDecoder(MAX_BRIDGE_MESSAGE_BYTES);
    const clientNonce = createIpcNonce();
    let hostNonce;
    let stage = "challenge";
    let settled = false;
    let authTimeoutId;
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
      clearTimeout(authTimeoutId);
      removeListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onConnect = () => {
      authTimeoutId = setTimeout(() => finish(new BridgeError(
        "BRIDGE_TIMEOUT",
        BRIDGE_ERROR_MESSAGES.BRIDGE_TIMEOUT,
      )), Math.min(IPC_AUTH_TIMEOUT_MS, timeoutMs));
      try {
        socket.write(Buffer.from(encodeBridgeFrame({
          type: "hello",
          version: 2,
          nonce: clientNonce,
        })));
      } catch {
        finish(new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED));
      }
    };
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
      catch {
        finish(new BridgeError("BRIDGE_PROTOCOL_ERROR", BRIDGE_ERROR_MESSAGES.BRIDGE_PROTOCOL_ERROR));
        return;
      }
      if (messages.length > 1) {
        finish(new BridgeError("BRIDGE_PROTOCOL_ERROR", BRIDGE_ERROR_MESSAGES.BRIDGE_PROTOCOL_ERROR));
        return;
      }
      if (messages.length === 0) return;
      const [message] = messages;
      if (stage === "challenge") {
        if (!isRecord(message) || Object.keys(message).length !== 3 ||
            message.type !== "challenge" || message.version !== 2 ||
            typeof message.nonce !== "string" || !/^[0-9a-f]{64}$/.test(message.nonce)) {
          finish(new BridgeError("BRIDGE_PROTOCOL_ERROR", BRIDGE_ERROR_MESSAGES.BRIDGE_PROTOCOL_ERROR));
          return;
        }
        hostNonce = message.nonce;
        stage = "host-proof";
        try {
          socket.write(Buffer.from(encodeBridgeFrame({
            type: "proof",
            version: 2,
            role: "client",
            proof: createIpcProof(sessionInfo.ipcSecret, "client", clientNonce, hostNonce),
          })));
        } catch {
          finish(new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED));
        }
        return;
      }
      if (stage === "host-proof") {
        if (!isRecord(message) || Object.keys(message).length !== 4 ||
            message.type !== "proof" || message.version !== 2 || message.role !== "host" ||
            !verifyIpcProof(createIpcProof(sessionInfo.ipcSecret, "host", clientNonce, hostNonce), message.proof)) {
          finish(new BridgeError("BRIDGE_SESSION_MISMATCH", BRIDGE_ERROR_MESSAGES.BRIDGE_SESSION_MISMATCH));
          return;
        }
        clearTimeout(authTimeoutId);
        authTimeoutId = undefined;
        if (!request) {
          finish(null, true);
          return;
        }
        stage = "response";
        try {
          socket.write(Buffer.from(encodeBridgeFrame({ type: "task", version: 2, request })));
        } catch {
          finish(new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED));
        }
        return;
      }
      if (stage !== "response" || !isRecord(message) || Object.keys(message).length !== 3 ||
          message.type !== "result" || message.version !== 2 ||
          !validateBridgeResponse(message.response, request.id)) {
        finish(new BridgeError("BRIDGE_PROTOCOL_ERROR", BRIDGE_ERROR_MESSAGES.BRIDGE_PROTOCOL_ERROR));
        return;
      }
      finish(null, message.response);
    };

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

export async function waitForBridge(config, sessionInfo, {
  timeoutMs = CONNECT_TIMEOUT_MS,
  connectImpl = connectSocket,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!isIpcSession(sessionInfo)) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      await openBridgeSocket(
        bridgeSocketPath(config, sessionInfo.sessionId),
        sessionInfo,
        null,
        Math.min(POLL_INTERVAL_MS * 2, deadline - now()),
        connectImpl,
      );
      return;
    } catch (error) {
      if (!(error instanceof BridgeError) || !["BRIDGE_DISCONNECTED", "BRIDGE_TIMEOUT"].includes(error.code)) throw error;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
    }
  }
  throw new BridgeError("BRIDGE_TIMEOUT", BRIDGE_ERROR_MESSAGES.BRIDGE_TIMEOUT);
}

export async function requestBridge(config, sessionInfo, request, {
  timeoutMs = 90_000,
  connectImpl = connectSocket,
} = {}) {
  if (!isIpcSession(sessionInfo)) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
  if (!validateBridgeCommand(request)) throw new BridgeError("INVALID_COMMAND", BRIDGE_ERROR_MESSAGES.INVALID_COMMAND);
  const response = await openBridgeSocket(
    bridgeSocketPath(config, sessionInfo.sessionId),
    sessionInfo,
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
  const sessionInfo = await readBridgeSessionInfo(config);
  if (!sessionInfo) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
  return requestBridge(config, sessionInfo, request, options);
}
