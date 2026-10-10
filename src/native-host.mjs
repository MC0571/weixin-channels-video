import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { createServer, connect as connectSocket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createIpcNonce,
  createIpcProof,
  createWindowsPipeServer,
  isIpcNonce,
  isIpcSession,
  verifyIpcProof,
  windowsPipeName,
} from "./native-ipc.mjs";
import {
  BridgeFrameDecoder,
  BRIDGE_ERROR_MESSAGES,
  encodeBridgeFrame,
  MAX_BRIDGE_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  SESSION_ID_PATTERN,
  validateBridgeCommand,
  validateBridgeResponse,
} from "./native-messaging.mjs";
import { assertWindowsPrivatePath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

const failure = (id, code, message) => ({ id, ok: false, error: { code, message } });
const AUTH_TIMEOUT_MS = 5_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSessionHello(value, expectedSessionId) {
  return hasExactKeys(value, ["type", "version", "sessionId"]) &&
    value.type === "hello" && value.version === 1 && value.sessionId === expectedSessionId;
}

function writeFrame(stream, value) {
  stream.write(Buffer.from(encodeBridgeFrame(value)));
}

function waitForServer(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = async () => {
      server.removeListener("error", onError);
      try {
        await chmod(socketPath, 0o600);
        resolve();
      } catch {
        server.close(() => {
          void unlink(socketPath).catch(() => {}).finally(() => reject(new Error("BRIDGE_START_FAILED")));
        });
      }
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function removeStaleSocket(socketPath) {
  let info;
  try { info = await lstat(socketPath); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("BRIDGE_START_FAILED");
  }
  if (!info.isSocket()) throw new Error("BRIDGE_START_FAILED");
  const active = await new Promise((resolve) => {
    const socket = connectSocket(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? false : true));
  });
  if (active) throw new Error("BRIDGE_ALREADY_RUNNING");
  await unlink(socketPath);
}

async function createMacSessionServer(socketPath, onConnection) {
  await removeStaleSocket(socketPath);
  const server = createServer(onConnection);
  await waitForServer(server, socketPath);
  return server;
}

function readBridgeConfig(configPath, config) {
  const root = dirname(configPath);
  if (
    !isRecord(config) ||
    config.version !== 1 ||
    config.hostName !== NATIVE_HOST_NAME ||
    config.platform !== process.platform ||
    config.ipcProtocol !== 2 ||
    !/^[a-p]{32}$/.test(config.extensionId) ||
    resolve(config.appSupportDir ?? "") !== resolve(root) ||
    configPath !== join(config.appSupportDir, "bridge.json")
  ) throw new Error();
  return root;
}

async function readHostState(configPath, extensionOrigin, {
  platform = process.platform,
  env = process.env,
  securitySpawnSyncImpl,
} = {}) {
  if (platform !== process.platform) throw new Error("BRIDGE_NOT_CONFIGURED");
  const root = dirname(configPath);
  if (configPath !== join(root, "bridge.json")) throw new Error("BRIDGE_NOT_CONFIGURED");
  if (platform === "win32") {
    const securityOptions = { platform, env, spawnSyncImpl: securitySpawnSyncImpl };
    await assertWindowsPrivatePath(root, { ...securityOptions, directory: true });
    await assertWindowsPrivatePath(configPath, securityOptions);
  }

  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch { throw new Error("BRIDGE_NOT_CONFIGURED"); }
  readBridgeConfig(configPath, config);
  if (extensionOrigin !== `chrome-extension://${config.extensionId}/`) throw new Error("BRIDGE_NOT_CONFIGURED");

  const sessionPath = join(root, "session.json");
  if (platform === "win32") {
    await assertWindowsPrivatePath(sessionPath, { platform, env, spawnSyncImpl: securitySpawnSyncImpl });
  }
  let session;
  try { session = JSON.parse(await readFile(sessionPath, "utf8")); }
  catch { throw new Error("BRIDGE_NOT_CONFIGURED"); }
  if (!hasExactKeys(session, ["version", "sessionId", "ipcProtocol", "ipcSecret"]) ||
      session.version !== 1 || !SESSION_ID_PATTERN.test(session.sessionId) ||
      !isIpcSession({ sessionId: session.sessionId, ipcProtocol: session.ipcProtocol, ipcSecret: session.ipcSecret })) {
    throw new Error("BRIDGE_NOT_CONFIGURED");
  }
  return { config, session, root };
}

export async function startNativeHost({
  configPath,
  extensionOrigin,
  input = process.stdin,
  output = process.stdout,
  appSupportDir,
  platform = process.platform,
  env = process.env,
  securitySpawnSyncImpl,
  powershellSpawnImpl,
}) {
  let config;
  let session;
  try {
    const state = await readHostState(configPath, extensionOrigin, { platform, env, securitySpawnSyncImpl });
    config = state.config;
    session = state.session;
    if (appSupportDir !== undefined && resolve(appSupportDir) !== resolve(state.root)) throw new Error();
    appSupportDir = state.root;
  } catch {
    throw new Error("BRIDGE_NOT_CONFIGURED");
  }

  const sessionId = session.sessionId;
  const socketPath = platform === "win32"
    ? `\\\\.\\pipe\\${windowsPipeName(appSupportDir, sessionId)}`
    : join(appSupportDir, `s-${sessionId.replaceAll("-", "").slice(0, 16)}.sock`);
  const nativeDecoder = new BridgeFrameDecoder();
  let server;
  let serverPromise;
  let windowsTransport;
  let activeClient;
  let nativeRequest;
  let initialized = false;
  let closed = false;

  const clearClient = (client) => {
    if (client.authTimer) clearTimeout(client.authTimer);
    client.closed = true;
    if (activeClient === client) activeClient = undefined;
    if (nativeRequest?.client === client) nativeRequest.client = undefined;
  };

  const closeClient = (client) => {
    if (client.closed) return;
    clearClient(client);
    if (client.kind === "windows") windowsTransport?.disconnect();
    else client.socket.destroy();
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    if (activeClient) closeClient(activeClient);
    await windowsTransport?.close();
    const startedServer = server ?? await serverPromise?.catch(() => undefined);
    if (startedServer) {
      await new Promise((resolve) => startedServer.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    }
    input.removeListener("data", onInput);
    input.removeListener("end", close);
    input.removeListener("error", close);
    if (input.destroy) input.destroy();
  };

  const sendToClient = (client, message) => {
    if (!client || client.closed) return;
    const frame = Buffer.from(encodeBridgeFrame(message));
    if (client.kind === "windows") windowsTransport.write(frame);
    else client.socket.write(frame);
  };

  const finishClient = (client, message) => {
    if (!client || client.closed) return;
    if (message) sendToClient(client, message);
    clearClient(client);
    if (client.kind === "windows") windowsTransport?.disconnect();
    else client.socket.end();
  };

  const beginClient = (kind, socket) => {
    const client = {
      kind,
      socket,
      decoder: new BridgeFrameDecoder(MAX_BRIDGE_MESSAGE_BYTES),
      phase: "hello",
      closed: false,
    };
    activeClient = client;
    client.authTimer = setTimeout(() => closeClient(client), 5_000);
    client.authTimer.unref?.();
    if (kind === "mac") {
      socket.on("data", (chunk) => processClientBytes(client, chunk));
      socket.on("error", () => clearClient(client));
      socket.on("close", () => clearClient(client));
    }
    return client;
  };

  const onMacConnection = (socket) => {
    socket.on("error", () => {});
    if (closed || activeClient) { socket.destroy(); return; }
    beginClient("mac", socket);
  };

  const onWindowsConnection = () => {
    if (closed || activeClient) {
      windowsTransport?.disconnect();
      return;
    }
    beginClient("windows");
  };

  const onWindowsFrame = (frame) => {
    if (!activeClient || activeClient.kind !== "windows") return;
    processClientBytes(activeClient, frame);
  };

  const onWindowsDisconnect = () => {
    if (activeClient?.kind === "windows") clearClient(activeClient);
  };

  const onTransportFatal = () => { void close(); };

  const startServer = async () => {
    if (platform === "win32") {
      windowsTransport = createWindowsPipeServer(windowsPipeName(appSupportDir, sessionId), {
        platform,
        env,
        spawnImpl: powershellSpawnImpl,
        onConnection: onWindowsConnection,
        onFrame: onWindowsFrame,
        onDisconnect: onWindowsDisconnect,
        onFatal: onTransportFatal,
      });
      await windowsTransport.ready;
      return windowsTransport;
    }
    server = await createMacSessionServer(socketPath, onMacConnection);
    return server;
  };

  const processClientMessage = (client, message) => {
    if (closed || client.closed || activeClient !== client) return;
    if (client.phase === "hello") {
      if (!hasExactKeys(message, ["type", "version", "nonce"]) ||
          message.type !== "hello" || message.version !== 2 ||
          !isIpcNonce(message.nonce)) {
        closeClient(client);
        return;
      }
      client.clientNonce = message.nonce;
      client.hostNonce = createIpcNonce();
      client.phase = "proof";
      sendToClient(client, {
        type: "challenge",
        version: 2,
        nonce: client.hostNonce,
      });
      return;
    }
    if (client.phase === "proof") {
      if (!hasExactKeys(message, ["type", "version", "role", "proof"]) ||
          message.type !== "proof" || message.version !== 2 || message.role !== "client" ||
          !verifyIpcProof(createIpcProof(session.ipcSecret, "client", client.clientNonce, client.hostNonce), message.proof)) {
        closeClient(client);
        return;
      }
      client.phase = "task";
      sendToClient(client, {
        type: "proof",
        version: 2,
        role: "host",
        proof: createIpcProof(session.ipcSecret, "host", client.clientNonce, client.hostNonce),
      });
      return;
    }
    if (client.phase === "task") {
      if (!hasExactKeys(message, ["type", "version", "request"]) ||
          message.type !== "task" || message.version !== 2 || !validateBridgeCommand(message.request)) {
        closeClient(client);
        return;
      }
      clearTimeout(client.authTimer);
      const request = message.request;
      if (nativeRequest) {
        finishClient(client, {
          type: "result",
          version: 2,
          response: failure(request.id, "BRIDGE_BUSY", BRIDGE_ERROR_MESSAGES.BRIDGE_BUSY),
        });
        return;
      }
      client.phase = "response";
      nativeRequest = { id: request.id, client };
      try { writeFrame(output, request); }
      catch { closeClient(client); }
      return;
    }
    closeClient(client);
  };

  function processClientBytes(client, chunk) {
    if (client.closed || activeClient !== client) return;
    let messages;
    try { messages = client.decoder.push(chunk); }
    catch { closeClient(client); return; }
    if (messages.length > 1) { closeClient(client); return; }
    if (messages.length === 1) processClientMessage(client, messages[0]);
  }

  const onInput = (chunk) => {
    if (closed) return;
    let messages;
    try { messages = nativeDecoder.push(chunk); }
    catch { void close(); return; }
    for (const message of messages) {
      if (!initialized) {
        if (!isSessionHello(message, sessionId)) { void close(); return; }
        initialized = true;
        serverPromise = startServer().then((started) => {
          if (closed) return started;
          writeFrame(output, { type: "ready", version: 1 });
          return started;
        }).catch(() => {
          void close();
          return undefined;
        });
        continue;
      }
      if (nativeRequest && validateBridgeResponse(message, nativeRequest.id)) {
        const request = nativeRequest;
        nativeRequest = undefined;
        finishClient(request.client, { type: "result", version: 2, response: message });
      }
    }
  };

  input.on("data", onInput);
  input.once("end", close);
  input.once("error", close);
  return {
    sessionId,
    socketPath,
    get windowsTransport() { return windowsTransport; },
    close,
  };
}

async function runNativeHost() {
  const args = process.argv.slice(2);
  const [configPath, extensionOrigin, ...hostArgs] = args;
  const hostArgsAreValid = process.platform === "win32"
    ? hostArgs.length === 1 && /^--parent-window=\d+$/.test(hostArgs[0])
    : hostArgs.length === 0;
  if (!configPath || !extensionOrigin || !hostArgsAreValid) throw new Error("INVALID_HOST_ARGS");
  await startNativeHost({ configPath, extensionOrigin });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runNativeHost().catch(() => {
    process.stderr.write("Native messaging host failed.\n");
    process.exitCode = 1;
  });
}
