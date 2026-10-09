import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { createServer, connect as connectSocket } from "node:net";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BridgeFrameDecoder, BRIDGE_ERROR_MESSAGES, encodeBridgeFrame, NATIVE_HOST_NAME, SESSION_ID_PATTERN, validateBridgeCommand, validateBridgeResponse } from "./native-messaging.mjs";
const failure = (id, code, message) => ({ id, ok: false, error: { code, message } });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSessionHello(value, expectedSessionId) {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === "hello" &&
    value.version === 1 &&
    value.sessionId === expectedSessionId;
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
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("BRIDGE_START_FAILED");
  }
  if (!info.isSocket()) throw new Error("BRIDGE_START_FAILED");

  const active = await new Promise((resolve) => {
    const socket = connectSocket(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? false : true));
  });
  if (active) throw new Error("BRIDGE_ALREADY_RUNNING");
  await unlink(socketPath);
}

async function createSessionServer(socketPath, onConnection) {
  await removeStaleSocket(socketPath);
  const server = createServer(onConnection);
  await waitForServer(server, socketPath);
  return server;
}

export async function startNativeHost({
  configPath,
  extensionOrigin,
  input = process.stdin,
  output = process.stdout,
  appSupportDir,
}) {
  let config;
  let session;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
    if (
      !isRecord(config) ||
      config.version !== 1 ||
      config.hostName !== NATIVE_HOST_NAME ||
      !/^[a-p]{32}$/.test(config.extensionId) ||
      extensionOrigin !== `chrome-extension://${config.extensionId}/`
    ) throw new Error();
    const root = appSupportDir ?? config.appSupportDir;
    if (typeof root !== "string" || !root) throw new Error();
    if (configPath !== join(root, "bridge.json")) throw new Error();
    const sessionPath = join(root, "session.json");
    session = JSON.parse(await readFile(sessionPath, "utf8"));
    if (
      !isRecord(session) ||
      Object.keys(session).length !== 2 ||
      session.version !== 1 ||
      !SESSION_ID_PATTERN.test(session.sessionId)
    ) throw new Error();
    appSupportDir = root;
  } catch {
    throw new Error("BRIDGE_NOT_CONFIGURED");
  }

  const sessionId = session.sessionId;
  const socketPath = join(appSupportDir, `s-${sessionId.replaceAll("-", "").slice(0, 16)}.sock`);
  const decoder = new BridgeFrameDecoder();
  let server;
  let activeClient;
  let activeRequestId;
  const clients = new Set();
  let serverPromise;
  let initialized = false;
  let closed = false;

  const discardBeforeServer = () => {
    if (closed) return;
    closed = true;
    for (const client of clients) client.destroy();
    activeClient = undefined;
    activeRequestId = undefined;
    if (input.destroy) input.destroy();
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const client of clients) client.destroy();
    activeClient = undefined;
    activeRequestId = undefined;
    if (input.destroy) input.destroy();
    const startedServer = server ?? await serverPromise?.catch(() => undefined);
    if (startedServer) {
      await new Promise((resolve) => startedServer.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    }
  };

  const sendToClient = (message) => {
    if (!activeClient || activeClient.destroyed) return;
    activeClient.end(Buffer.from(encodeBridgeFrame(message)));
    activeClient = undefined;
    activeRequestId = undefined;
  };

  const onClient = (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => {
      clients.delete(client);
      if (activeClient === client) {
        activeClient = undefined;
        activeRequestId = undefined;
      }
    });
    client.write(Buffer.from(encodeBridgeFrame({ type: "ready", sessionId })));
    const clientDecoder = new BridgeFrameDecoder();
    let received = false;
    client.on("data", (chunk) => {
      if (received) {
        client.destroy();
        return;
      }
      let messages;
      try {
        messages = clientDecoder.push(chunk);
      } catch {
        client.destroy();
        return;
      }
      if (messages.length === 0) return;
      if (messages.length !== 1) {
        client.destroy();
        return;
      }
      received = true;
      const envelope = messages[0];
      if (
        !isRecord(envelope) ||
        Object.keys(envelope).length !== 2 ||
        envelope.sessionId !== sessionId ||
        !validateBridgeCommand(envelope.request)
      ) {
        client.destroy();
        return;
      }
      if (activeClient && activeClient !== client) {
        client.end(Buffer.from(encodeBridgeFrame(failure(
          envelope.request.id,
          "BRIDGE_BUSY",
          BRIDGE_ERROR_MESSAGES.BRIDGE_BUSY,
        ))));
        return;
      }
      activeClient = client;
      activeRequestId = envelope.request.id;
      writeFrame(output, envelope.request);
    });
  };

  const onInput = (chunk) => {
    if (closed) return;
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch {
      void close();
      return;
    }
    for (const message of messages) {
      if (!initialized) {
        if (!isSessionHello(message, sessionId)) {
          void close();
          return;
        }
        initialized = true;
        serverPromise = createSessionServer(socketPath, onClient).then((created) => {
          if (closed) {
            return new Promise((resolve) => created.close(() => resolve(undefined))).then(() => {
              return unlink(socketPath).catch(() => undefined);
            });
          }
          server = created;
          writeFrame(output, { type: "ready", version: 1 });
          return created;
        }).catch(() => {
          discardBeforeServer();
          return undefined;
        });
        continue;
      }
      if (activeRequestId && validateBridgeResponse(message, activeRequestId)) {
        sendToClient(message);
      }
    }
  };

  input.on("data", onInput);
  input.once("end", close);
  input.once("error", close);
  return {
    sessionId,
    get socketPath() { return socketPath; },
    close,
  };
}

async function runNativeHost() {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("INVALID_HOST_ARGS");
  const [configPath, extensionOrigin] = args;
  await startNativeHost({ configPath, extensionOrigin });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runNativeHost().catch(() => {
    process.stderr.write("Native messaging host failed.\n");
    process.exitCode = 1;
  });
}
