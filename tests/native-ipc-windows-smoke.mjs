import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { BridgeFrameDecoder, encodeBridgeFrame } from "../src/native-messaging.mjs";
import { startNativeHost } from "../src/native-host.mjs";
import { createIpcNonce, createIpcProof, verifyIpcProof } from "../src/native-ipc.mjs";
import { windowsPowerShellPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";
import { bridgeSocketPath } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { requestBridge } from "../skills/weixin-channels-video/scripts/bridge-client.mjs";
import { secureWindowsPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";
import { NATIVE_HOST_NAME } from "../src/native-messaging.mjs";

const extensionId = "a".repeat(32);
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const ipcSecret = "a".repeat(64);
const hostScript = fileURLToPath(new URL("../src/native-host.mjs", import.meta.url));

function createFrameReader(stream) {
  const decoder = new BridgeFrameDecoder();
  const queue = [];
  const waiters = [];
  let failure;
  const fail = (error) => {
    failure = error ?? new Error("NATIVE_HOST_CLOSED");
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  };
  stream.on("data", (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(frame);
        else queue.push(frame);
      }
    } catch (error) { fail(error); }
  });
  stream.once("error", fail);
  stream.once("close", () => fail());
  stream.once("end", () => fail());
  return {
    next(timeoutMs = 15_000) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("NATIVE_HOST_TIMEOUT"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function waitForEvent(emitter, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error("NATIVE_HOST_TIMEOUT"));
    }, timeoutMs);
    const onEvent = (...values) => {
      clearTimeout(timer);
      resolve(values);
    };
    emitter.once(event, onEvent);
  });
}

async function createFixture(root) {
  const appSupportDir = join(root, "app");
  await mkdir(appSupportDir);
  const configPath = join(appSupportDir, "bridge.json");
  const sessionPath = join(appSupportDir, "session.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    hostName: NATIVE_HOST_NAME,
    platform: "win32",
    ipcProtocol: 2,
    extensionId,
    appSupportDir,
  }), { flag: "wx" });
  await writeFile(sessionPath, JSON.stringify({ version: 1, sessionId, ipcProtocol: 2, ipcSecret }), { flag: "wx" });
  await secureWindowsPath(appSupportDir, { directory: true, newlyCreated: true });
  await secureWindowsPath(configPath, { newlyCreated: true });
  await secureWindowsPath(sessionPath, { newlyCreated: true });
  const config = { appSupportDir, platform: "win32" };
  const sessionInfo = { sessionId, ipcProtocol: 2, ipcSecret };
  return { appSupportDir, configPath, config, sessionInfo, socketPath: bridgeSocketPath(config, sessionId) };
}

async function readyNativeHostProcess(fixture) {
  const child = spawn(process.execPath, [
    hostScript,
    fixture.configPath,
    `chrome-extension://${extensionId}/`,
    "--parent-window=0",
  ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const frames = createFrameReader(child.stdout);
  child.stderr.on("data", () => {});
  const ready = frames.next();
  child.stdin.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId })));
  assert.deepEqual(await ready, { type: "ready", version: 1 });
  return { child, frames };
}

async function occupyPipe(socketPath) {
  const pipeName = socketPath.slice("\\\\.\\pipe\\".length);
  const command = String.raw`
$pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
  $env:WCV_SMOKE_PIPE_NAME,
  [System.IO.Pipes.PipeDirection]::InOut,
  1,
  [System.IO.Pipes.PipeTransmissionMode]::Byte,
  [System.IO.Pipes.PipeOptions]::Asynchronous
)
[Console]::Error.WriteLine('READY')
[Console]::Error.Flush()
while ($true) { [System.Threading.Thread]::Sleep(1000) }
`;
  const child = spawn(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", command], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
        .filter((key) => typeof process.env[key] === "string")
        .map((key) => [key, process.env[key]])),
      WCV_SMOKE_PIPE_NAME: pipeName,
    },
  });
  const ready = new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (/^READY\r?$/m.test(stderr)) resolve();
    });
    child.once("error", () => reject(new Error("PIPE_OWNER_START_FAILED")));
    child.once("exit", () => reject(new Error("PIPE_OWNER_START_FAILED")));
  });
  await ready;
  return {
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = waitForEvent(child, "close", 10_000);
      child.kill();
      await closed;
    },
  };
}

async function openPipeClient(path, partial = false) {
  const socket = connect(path);
  socket.on("error", () => {});
  await waitForEvent(socket, "connect", 10_000);
  if (partial) socket.write(Buffer.from([1, 0, 0]));
  return socket;
}

async function expectPipeClientClosed(socket) {
  if (socket.destroyed) return;
  await waitForEvent(socket, "close", 8_000);
}

async function requestThroughNativeHost(fixture, input, frames) {
  const id = randomUUID();
  const request = { id, command: "status" };
  const responsePromise = requestBridge(fixture.config, fixture.sessionInfo, request, { timeoutMs: 20_000 });
  const nativeRequest = await frames.next(20_000);
  assert.deepEqual(nativeRequest, request);
  input.write(Buffer.from(encodeBridgeFrame({ id, ok: true, result: { login: "anonymous" } })));
  assert.deepEqual(await responsePromise, { login: "anonymous" });
}

async function smokeLiveHostTimeoutRecovery(fixture, partial) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = createFrameReader(output);
  const host = await startNativeHost({
    configPath: fixture.configPath,
    extensionOrigin: `chrome-extension://${extensionId}/`,
    input,
    output,
  });
  try {
    input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId })));
    assert.deepEqual(await frames.next(), { type: "ready", version: 1 });
    const client = await openPipeClient(fixture.socketPath, partial);
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await expectPipeClientClosed(client);
    await requestThroughNativeHost(fixture, input, frames);
  } finally {
    await host.close();
  }
}

async function smokeAuthenticatedIdleTimeoutRecovery(fixture) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = createFrameReader(output);
  const host = await startNativeHost({
    configPath: fixture.configPath,
    extensionOrigin: `chrome-extension://${extensionId}/`,
    input,
    output,
  });
  try {
    input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId })));
    assert.deepEqual(await frames.next(), { type: "ready", version: 1 });
    const socket = await openPipeClient(fixture.socketPath);
    const clientFrames = createFrameReader(socket);
    const clientNonce = createIpcNonce();
    socket.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 2, nonce: clientNonce })));
    const challenge = await clientFrames.next();
    assert.equal(challenge.type, "challenge");
    assert.equal(challenge.version, 2);
    assert.equal(Object.hasOwn(challenge, "sessionId"), false);
    socket.write(Buffer.from(encodeBridgeFrame({
      type: "proof",
      version: 2,
      role: "client",
      proof: createIpcProof(ipcSecret, "client", clientNonce, challenge.nonce),
    })));
    const hostProof = await clientFrames.next();
    assert.equal(hostProof.type, "proof");
    assert.equal(hostProof.role, "host");
    assert.equal(verifyIpcProof(
      createIpcProof(ipcSecret, "host", clientNonce, challenge.nonce),
      hostProof.proof,
    ), true);
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await expectPipeClientClosed(socket);
    await requestThroughNativeHost(fixture, input, frames);
  } finally {
    await host.close();
  }
}

async function smokePipePreemption(fixture) {
  const pipeOwner = await occupyPipe(fixture.socketPath);
  const input = new PassThrough();
  const output = new PassThrough();
  let host;
  try {
    host = await startNativeHost({
      configPath: fixture.configPath,
      extensionOrigin: `chrome-extension://${extensionId}/`,
      input,
      output,
    });
    input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId })));
    await assert.rejects(host.windowsTransport.ready, /WINDOWS_PIPE_START_FAILED/);
  } finally {
    await host?.close();
    await pipeOwner.close();
  }
  assert.equal(output.readableLength, 0);
}

async function smokeAbruptHostExit(fixture, partial) {
  const first = await readyNativeHostProcess(fixture);
  const client = await openPipeClient(fixture.socketPath, partial);
  const closed = waitForEvent(first.child, "close", 10_000);
  first.child.kill();
  await closed;
  await expectPipeClientClosed(client);
  await new Promise((resolve) => setTimeout(resolve, 5_500));

  const second = await readyNativeHostProcess(fixture);
  try {
    await requestThroughNativeHost(fixture, second.child.stdin, second.frames);
  } finally {
    const closedAgain = waitForEvent(second.child, "close", 10_000);
    second.child.kill();
    await closedAgain;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "wcv-native-ipc-smoke-"));
  try {
    const fixture = await createFixture(root);
    await smokePipePreemption(fixture);
    await smokeLiveHostTimeoutRecovery(fixture, false);
    await smokeLiveHostTimeoutRecovery(fixture, true);
    await smokeAuthenticatedIdleTimeoutRecovery(fixture);
    await smokeAbruptHostExit(fixture, false);
    await smokeAbruptHostExit(fixture, true);
    process.stdout.write("Windows native IPC smoke passed.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  process.stdout.write("Windows native IPC smoke skipped (requires Windows).\n");
} else {
  main().catch(() => {
    process.stderr.write("Windows native IPC smoke failed.\n");
    process.exitCode = 1;
  });
}
