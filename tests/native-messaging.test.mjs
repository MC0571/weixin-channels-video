import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { connect, createServer } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentCommandHandler } from "../extension/agent.mjs";
import { BRIDGE_ERROR_MESSAGES, BridgeFrameDecoder, encodeBridgeFrame, isAbsoluteDownloadPath, isSafeRelativeMp4Filename, NATIVE_HOST_NAME, validateBridgeCommand, validateBridgeResponse } from "../src/native-messaging.mjs";
import { createIpcNonce, createIpcProof, createWindowsPipeServer, isIpcSession, verifyIpcProof, windowsPipeName } from "../src/native-ipc.mjs";
import { startNativeHost } from "../src/native-host.mjs";
import { bridgeSocketPath, installBridge, inspectBridgeComponents, readBridgeInstallation, readBridgeSession } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { BridgeError, requestBridge, waitForBridge } from "../skills/weixin-channels-video/scripts/bridge-client.mjs";
import { runCli } from "../skills/weixin-channels-video/scripts/cli.mjs";
import { secureWindowsPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

const EXTENSION_ID = "a".repeat(32);
const SESSION_1 = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_2 = "223e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const IPC_SECRET = "a".repeat(64);
const SESSION_INFO = { sessionId: SESSION_1, ipcProtocol: 2, ipcSecret: IPC_SECRET };

async function withTempDir(callback) {
  const root = await mkdtemp(join(tmpdir(), "weixin-native-bridge-test-"));
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function withShortTempDir(callback) {
  const root = await mkdtemp("/tmp/wcv-");
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function chromeProfileFixture(root, profiles = [["Profile 3", "Research"]]) {
  const chromeRoot = join(root, "Chrome User Data");
  const infoCache = {};
  for (const [directory, name] of profiles) {
    await mkdir(join(chromeRoot, directory), { recursive: true });
    infoCache[directory] = { name };
  }
  await writeFile(join(chromeRoot, "Local State"), JSON.stringify({ profile: { info_cache: infoCache } }));
  return chromeRoot;
}

function collectFrames(stream) {
  const decoder = new BridgeFrameDecoder();
  const messages = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    let frames;
    try { frames = decoder.push(chunk); }
    catch (error) {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      return;
    }
    for (const frame of frames) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else messages.push(frame);
    }
  });
  return {
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

function createAuthenticatedFakeServer({ sessionInfo = SESSION_INFO, hostSecret = sessionInfo.ipcSecret, hostNonce = "b".repeat(64), onTask = () => {} } = {}) {
  return createServer((socket) => {
    const decoder = new BridgeFrameDecoder();
    let phase = "hello";
    let clientNonce;
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (phase === "hello") {
          phase = "proof";
          clientNonce = message.nonce;
          socket.write(Buffer.from(encodeBridgeFrame({
            type: "challenge", version: 2, nonce: hostNonce,
          })));
        } else if (phase === "proof") {
          phase = "task";
          socket.write(Buffer.from(encodeBridgeFrame({
            type: "proof",
            version: 2,
            role: "host",
            proof: createIpcProof(hostSecret, "host", clientNonce, hostNonce),
          })));
        } else {
          onTask(message.request, socket);
        }
      }
    });
  });
}

async function createHostFixture(root, sessionId = SESSION_1) {
  const appSupportDir = join(root, "app");
  await mkdir(appSupportDir, { recursive: true, mode: 0o700 });
  await chmod(appSupportDir, 0o700);
  const configPath = join(appSupportDir, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    hostName: NATIVE_HOST_NAME,
    platform: process.platform,
    ipcProtocol: 2,
    extensionId: EXTENSION_ID,
    appSupportDir,
  }), { mode: 0o600 });
  await writeFile(join(appSupportDir, "session.json"), JSON.stringify({ version: 1, sessionId, ipcProtocol: 2, ipcSecret: IPC_SECRET }), { mode: 0o600 });
  if (process.platform === "win32") {
    await secureWindowsPath(appSupportDir, { directory: true });
    await secureWindowsPath(configPath);
    await secureWindowsPath(join(appSupportDir, "session.json"));
  }
  const input = new PassThrough();
  const output = new PassThrough();
  const outputFrames = collectFrames(output);
  const host = await startNativeHost({
    configPath,
    extensionOrigin: `chrome-extension://${EXTENSION_ID}/`,
    input,
    output,
  });
  return { appSupportDir, configPath, config: { platform: process.platform, appSupportDir }, host, input, output, outputFrames, sessionInfo: { sessionId, ipcProtocol: 2, ipcSecret: IPC_SECRET } };
}

test("Native Messaging frames handle partial input and reject malformed or oversized frames", () => {
  const first = encodeBridgeFrame({ command: "status" });
  const second = encodeBridgeFrame({ command: "parse", url: "https://weixin.qq.com/sph/demo" });
  const decoder = new BridgeFrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(first.subarray(2)), [{ command: "status" }]);
  assert.deepEqual(decoder.push(Buffer.concat([Buffer.from(first), Buffer.from(second)])), [
    { command: "status" },
    { command: "parse", url: "https://weixin.qq.com/sph/demo" },
  ]);
  decoder.finish();

  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, 5, true);
  assert.throws(() => new BridgeFrameDecoder(4).push(oversized), /size is invalid/);
  const truncated = new BridgeFrameDecoder();
  truncated.push(first.subarray(0, 3));
  assert.throws(() => truncated.finish(), /closed mid-message/);
  assert.throws(() => new BridgeFrameDecoder().push(Buffer.from([1, 0, 0, 0, 0xff])), /encoded data/);
});

test("IPC2 sessions use private keys, fresh nonces, and endpoint-specific pipe names", () => {
  const clientNonce = createIpcNonce();
  const hostNonce = createIpcNonce();
  const proof = createIpcProof(IPC_SECRET, "client", clientNonce, hostNonce);
  assert.equal(isIpcSession(SESSION_INFO), true);
  assert.equal(isIpcSession({ ...SESSION_INFO, extra: true }), false);
  assert.equal(verifyIpcProof(proof, proof), true);
  assert.equal(verifyIpcProof(proof, "0".repeat(64)), false);
  assert.notEqual(windowsPipeName("C:\\Users\\Example\\AppData", SESSION_1), windowsPipeName("C:\\Users\\Example\\AppData", SESSION_2));
  assert.notEqual(windowsPipeName("C:\\Users\\Example\\AppData", SESSION_1), windowsPipeName("C:\\Users\\Other\\AppData", SESSION_1));
});

test("Windows pipe transport close waits for PowerShell exit and settles startup", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
    }
    kill() {
      this.killed = true;
      setTimeout(() => {
        this.exitCode = 1;
        this.emit("exit", 1, null);
        this.emit("close", 1, null);
      }, 20);
      return true;
    }
  }
  let child;
  let unexpectedFatal = false;
  const transport = createWindowsPipeServer(`weixin-channels-video-${"a".repeat(32)}`, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: () => (child = new FakeChild()),
    onFatal: () => { unexpectedFatal = true; },
  });
  const ready = assert.rejects(transport.ready, /WINDOWS_PIPE_START_FAILED/);
  let closed = false;
  const closing = transport.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(child.killed, true);
  assert.equal(closed, false);
  await Promise.all([ready, closing]);
  assert.equal(closed, true);
  assert.equal(unexpectedFatal, false);
});

test("Windows pipe transport reports an unexpected PowerShell exit after READY", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
    }
    kill() { this.killed = true; return true; }
  }
  let child;
  let fatalCount = 0;
  const transport = createWindowsPipeServer(`weixin-channels-video-${"b".repeat(32)}`, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: () => (child = new FakeChild()),
    onFatal: () => { fatalCount += 1; },
  });
  child.stderr.write("READY\r\n");
  await transport.ready;
  child.exitCode = 1;
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  assert.equal(fatalCount, 1);
  await transport.close();
});

test("bridge commands and download paths are narrow and exact", () => {
  assert.equal(isAbsoluteDownloadPath("/Users/example/clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("C:\\Users\\example\\clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("C:/Users/example/clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("\\\\server\\share\\clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("//server/share/clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("C:clip.mp4"), false);
  assert.equal(isAbsoluteDownloadPath("\\clip.mp4"), false);
  assert.equal(isAbsoluteDownloadPath("\\\\server"), false);
  assert.equal(isAbsoluteDownloadPath("\\\\server\\"), false);
  assert.equal(isAbsoluteDownloadPath("\\\\?\\C:\\clip.mp4"), false);
  assert.equal(isAbsoluteDownloadPath("clips/clip.mp4"), false);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "status" }), true);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/demo" }), true);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo", filename: "Clips/demo.mp4" }), true);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo", output: "/tmp/demo.mp4" }), false);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "fetch", url: "https://attacker.invalid" }), false);
  for (const filename of ["../demo.mp4", "/tmp/demo.mp4", "a/../../demo.mp4", "a\\demo.mp4", "a.txt", "a/./demo.mp4"]) {
    assert.equal(isSafeRelativeMp4Filename(filename), false, filename);
  }
  assert.equal(isSafeRelativeMp4Filename("Clips/clip.mp4"), true);
  assert.equal(validateBridgeResponse({ id: REQUEST_ID, ok: true, result: {} }, REQUEST_ID), true);
  assert.equal(validateBridgeResponse({ id: REQUEST_ID, ok: true, result: {}, error: "ignored" }, REQUEST_ID), false);
});

test("CLI and Native Messaging host entry guards follow symlinked paths with spaces and hashes", async () => {
  await withShortTempDir(async (root) => {
    const linksDir = join(root, "linked scripts # fixture");
    await mkdir(linksDir);
    const cliLink = join(linksDir, "cli entry #.mjs");
    const hostLink = join(linksDir, "native host #.mjs");
    await symlink(new URL("../skills/weixin-channels-video/scripts/cli.mjs", import.meta.url), cliLink);
    await symlink(new URL("../src/native-host.mjs", import.meta.url), hostLink);

    const cli = spawnSync(process.execPath, [cliLink, "--help"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^Usage: cli\.mjs/);

    const host = spawnSync(process.execPath, [hostLink], { encoding: "utf8" });
    assert.equal(host.status, 1);
    assert.equal(host.stderr, "Native messaging host failed.\n");
  });
});

test("installer uses profile metadata only and writes private, exact user-level registration", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root);
    const appSupportDir = join(root, "private", "bridge");
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    const nativeHostSource = join(root, "native-host-bundle.mjs");
    await writeFile(nativeHostSource, "// synthetic host bundle\n");

    const installed = await installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
    });
    const manifest = JSON.parse(await readFile(installed.hostManifestPath, "utf8"));
    assert.deepEqual(manifest, {
      name: NATIVE_HOST_NAME,
      description: "Local bridge for the Weixin Channels Video Chrome extension.",
      path: installed.launcherPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    assert.equal(installed.profile.directory, "Profile 3");
    assert.equal((await readBridgeInstallation({ appSupportDir })).profileDirectory, "Profile 3");
    const sessionId = await readBridgeSession(installed.config);
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.equal((await stat(appSupportDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(appSupportDir, "bridge.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(installed.hostManifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(appSupportDir, "session.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(installed.launcherPath)).mode & 0o777, 0o700);
    const launcher = await readFile(installed.launcherPath, "utf8");
    assert.match(launcher, /'\/Applications\/Node Runtime\/bin\/node'/);
    assert.match(launcher, /"\$@"/);
    assert.equal((await readFile(join(chromeRoot, "Local State"), "utf8")).includes("Cookies"), false);

    assert.deepEqual(await inspectBridgeComponents(installed.config, { registryDir }), {
      registration: "valid",
      host: "present",
      launcher: "valid",
      node: "missing",
      nodeVersion: null,
      session: "available",
      security: "unknown",
    });

    const sessionPath = join(appSupportDir, "session.json");
    await writeFile(sessionPath, JSON.stringify({ version: 1, sessionId, unexpected: true }));
    assert.equal((await inspectBridgeComponents(installed.config, { registryDir })).session, "invalid");
    assert.equal(await readBridgeSession(installed.config), null);
    await writeFile(sessionPath, JSON.stringify({ version: 1, sessionId }));

    const updated = await installBridge({
      extensionId: EXTENSION_ID,
      profile: "Profile 3",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
    });
    assert.equal(updated.profile.directory, "Profile 3");
    assert.notEqual(await readBridgeSession(updated.config), sessionId);
    const reconfigured = await installBridge({
      extensionId: "b".repeat(32),
      profile: "Profile 3",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
    });
    assert.notEqual(await readBridgeSession(reconfigured.config), sessionId);
  });
});

test("installer refuses an unrelated Native Messaging host registration", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root);
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    const appSupportDir = join(root, "bridge");
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(registryDir, `${NATIVE_HOST_NAME}.json`), JSON.stringify({
      name: NATIVE_HOST_NAME,
      path: "/Applications/Unrelated.app/Contents/MacOS/host",
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    }));
    const nativeHostSource = join(root, "host.mjs");
    await writeFile(nativeHostSource, "// host\n");
    await assert.rejects(installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nativeHostSource,
    }), /Native Messaging 注册/);
    await assert.rejects(stat(appSupportDir), { code: "ENOENT" });
  });
});

test("installer does not replace orphaned host or launcher files without app ownership", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root);
    const appSupportDir = join(root, "bridge");
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    const nativeHostSource = join(root, "host.mjs");
    await mkdir(appSupportDir, { recursive: true });
    await writeFile(join(appSupportDir, "native-host.mjs"), "unrelated host contents");
    await writeFile(nativeHostSource, "// packaged host\n");
    await assert.rejects(installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nativeHostSource,
    }), /本地桥接文件/);
    assert.equal(await readFile(join(appSupportDir, "native-host.mjs"), "utf8"), "unrelated host contents");
  });
});

test("Native Messaging host binds the socket to one extension origin and one session", async () => {
  await withShortTempDir(async (root) => {
    const fixture = await createHostFixture(root);
    await assert.rejects(startNativeHost({
      configPath: fixture.configPath,
      extensionOrigin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
      input: new PassThrough(),
      output: new PassThrough(),
    }), /BRIDGE_NOT_CONFIGURED/);

    fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId: SESSION_2 })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(stat(fixture.host.socketPath), { code: "ENOENT" });
    assert.equal(fixture.input.destroyed, true);
  });
});

test("Native Messaging host authenticates the local client, forwards one command, and cleans up", async () => {
  await withShortTempDir(async (root) => {
    const fixture = await createHostFixture(root);
    fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId: SESSION_1 })));
    assert.deepEqual(await fixture.outputFrames.next(), { type: "ready", version: 1 });

    const command = { id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/synthetic" };
    const responsePromise = requestBridge(fixture.config, fixture.sessionInfo, command);
    assert.deepEqual(await fixture.outputFrames.next(), command);
    const response = { id: REQUEST_ID, ok: true, result: { title: "synthetic" } };
    fixture.input.write(Buffer.from(encodeBridgeFrame(response)));
    assert.deepEqual(await responsePromise, response.result);
    await fixture.host.close();
    await assert.rejects(stat(fixture.host.socketPath), { code: "ENOENT" });
  });
});

test("CLI connection sessions stay private and status distinguishes disconnected from login failure", async () => {
  const config = { extensionId: EXTENSION_ID, profileDirectory: "Profile 3", chromeUserDataDir: "/tmp/chrome", appSupportDir: "/tmp/bridge" };
  const outputs = [];
  const errors = [];
  let launched;
  let waited;
  const launches = [];
  const waitTimeouts = [];
  assert.equal(await runCli(["status"], {
    stdout: (value) => outputs.push(value),
    readInstallation: async () => null,
  }), 0);
  assert.deepEqual(JSON.parse(outputs.pop()), { configuration: "unconfigured", connection: "disconnected", login: "not_checked" });

  assert.equal(await runCli(["status"], {
    stdout: (value) => outputs.push(value),
    readInstallation: async () => config,
    readSession: async () => null,
  }), 0);
  assert.deepEqual(JSON.parse(outputs.pop()), { configuration: "configured", connection: "disconnected", login: "not_checked" });

  assert.equal(await runCli(["status"], {
    stdout: (value) => outputs.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    bridgeRequest: async () => { throw new BridgeError("LOGIN_CHECK_FAILED", "ignored"); },
  }), 1);
  assert.deepEqual(JSON.parse(outputs.pop()), { configuration: "configured", connection: "connected", login: "failed:LOGIN_CHECK_FAILED" });

  assert.equal(await runCli(["status"], {
    stdout: (value) => outputs.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    bridgeRequest: async () => { throw new BridgeError("BRIDGE_BUSY", "ignored"); },
  }), 1);
  assert.deepEqual(JSON.parse(outputs.pop()), { configuration: "configured", connection: "failed:BRIDGE_BUSY", login: "not_checked" });

  assert.equal(await runCli(["connect"], {
    stdout: (value) => outputs.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    launch: async (bridgeConfig, pairedSession) => {
      launched ??= bridgeConfig;
      assert.equal(bridgeConfig, config);
      if (launches.length === 0) assert.equal(pairedSession, undefined);
      else assert.equal(pairedSession, SESSION_INFO.sessionId);
      launches.push(pairedSession);
    },
    bridgeWait: async (_config, sessionInfo, options) => {
      waitTimeouts.push(options.timeoutMs);
      if (waitTimeouts.length < 3) { waited ??= sessionInfo; throw new BridgeError("BRIDGE_TIMEOUT", "ignored"); }
    },
  }), 0);
  assert.equal(launched, config);
  assert.deepEqual(waited, SESSION_INFO);
  assert.deepEqual(launches, [undefined, SESSION_INFO.sessionId]);
  assert.deepEqual(waitTimeouts, [500, 5_000, 30_000]);
  assert.equal(outputs.pop(), "Connected to the Chrome extension.");
  assert.equal(errors.length, 0);
  assert.equal(outputs.some((value) => value.includes(SESSION_1)), false);
});

test("CLI parse passes only the fixed command shape and never logs the share URL", async () => {
  const outputs = [];
  const errors = [];
  const shareUrl = "https://weixin.qq.com/sph/synthetic";
  let sent;
  const result = { title: "synthetic", previewUrl: "https://media.example/video.mp4", downloadUrl: "https://media.example/video.mp4" };
  assert.equal(await runCli(["parse", "--url", shareUrl], {
    stdout: (value) => outputs.push(value),
    stderr: (value) => errors.push(value),
    readInstallation: async () => ({ appSupportDir: "/tmp/bridge" }),
    readSession: async () => SESSION_INFO,
    bridgeWait: async () => {},
    bridgeRequest: async (_config, _session, request, options) => {
      sent = { request, options };
      return result;
    },
  }), 0);
  assert.equal(sent.request.command, "parse");
  assert.equal(sent.request.url, shareUrl);
  assert.deepEqual(Object.keys(sent.request).sort(), ["command", "id", "url"]);
  assert.equal(sent.options.timeoutMs, 90_000);
  assert.deepEqual(JSON.parse(outputs[0]), result);
  assert.equal(errors.length, 0);

  assert.equal(await runCli(["download", "--url", shareUrl, "--filename", "../unsafe.mp4"], {
    stdout: (value) => outputs.push(value),
    stderr: (value) => errors.push(value),
    readInstallation: async () => { throw new Error("must not read configuration"); },
  }), 2);
  assert.match(errors.pop(), /safe relative/);
});

test("CLI auto-connects before a download and never retries a task after timeout", async () => {
  const config = { extensionId: EXTENSION_ID, profileDirectory: "Profile 3", chromeUserDataDir: "/tmp/chrome", appSupportDir: "/tmp/bridge" };
  const errors = [];
  const launches = [];
  let bridgeWaitCount = 0;
  let taskRequestCount = 0;
  const exitCode = await runCli(["download", "--url", "https://weixin.qq.com/sph/synthetic"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    launch: async (_config, bootstrapSession) => launches.push(bootstrapSession),
    bridgeWait: async () => {
      bridgeWaitCount += 1;
      if (bridgeWaitCount === 1) throw new BridgeError("BRIDGE_TIMEOUT", "ignored");
    },
    bridgeRequest: async () => {
      taskRequestCount += 1;
      throw new BridgeError("BRIDGE_TIMEOUT", "ignored");
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(launches, [undefined]);
  assert.equal(bridgeWaitCount, 2);
  assert.equal(taskRequestCount, 1);
  assert.deepEqual(errors, [`BRIDGE_TIMEOUT: ${BRIDGE_ERROR_MESSAGES.BRIDGE_TIMEOUT}`]);
});

test("agent returns only selected video fields and waits for Chrome's real download outcome", async () => {
  const parsed = {
    title: "A title",
    author: "An author",
    coverUrl: "https://media.example/cover.jpg?sig=x",
    previewUrl: "https://media.example/video.mp4?sig=x",
    downloadUrl: "https://media.example/video.mp4?sig=x",
    mediaVariants: [{ label: "H.264", downloadUrl: "https://media.example/video.mp4?sig=x" }],
    playableUrl: "https://yuanbao.tencent.com/private?token=must-not-leak&eid=must-not-leak",
    rawResponse: { token: "must-not-leak", authUrl: "must-not-leak" },
  };
  let parsedRequest;
  let downloaded;
  let waitedId;
  const chromeApi = {};
  const handler = createAgentCommandHandler({
    chromeApi,
    requestFactory: () => async () => new Response(null, { status: 200 }),
    parser: async (url, options) => { parsedRequest = { url, request: options.request }; return parsed; },
    downloadStarter: async (video, api, filename) => {
      downloaded = { video, api, filename };
      return 55;
    },
    downloadWaiter: async (id) => { waitedId = id; return { state: "complete", path: "/Users/test/Downloads/clip.mp4", bytes: 321 }; },
  });
  const parseResponse = await handler({ id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/synthetic" });
  assert.equal(parsedRequest.url, "https://weixin.qq.com/sph/synthetic");
  assert.deepEqual(Object.keys(parseResponse.result).sort(), ["author", "coverUrl", "downloadUrl", "mediaVariants", "previewUrl", "title"]);
  assert.equal(JSON.stringify(parseResponse).includes("must-not-leak"), false);

  const downloadResponse = await handler({
    id: REQUEST_ID,
    command: "download",
    url: "https://weixin.qq.com/sph/synthetic",
    filename: "Clips/clip.mp4",
  });
  assert.deepEqual(downloaded, { video: parsed, api: chromeApi, filename: "Clips/clip.mp4" });
  assert.equal(waitedId, 55);
  assert.deepEqual(downloadResponse, {
    id: REQUEST_ID,
    ok: true,
    result: {
      title: "A title",
      author: "An author",
      coverUrl: "https://media.example/cover.jpg?sig=x",
      previewUrl: "https://media.example/video.mp4?sig=x",
      downloadUrl: "https://media.example/video.mp4?sig=x",
      mediaVariants: [{ label: "H.264", downloadUrl: "https://media.example/video.mp4?sig=x" }],
      state: "complete",
      path: "/Users/test/Downloads/clip.mp4",
      bytes: 321,
    },
  });
  assert.equal(JSON.stringify(downloadResponse).includes("must-not-leak"), false);
});

test("agent treats interrupted and zero-byte Chrome downloads as failures", async () => {
  const video = { title: "clip", author: "author", coverUrl: "", previewUrl: "https://media.example/v.mp4", downloadUrl: "https://media.example/v.mp4", mediaVariants: [] };
  const base = {
    parser: async () => video,
    downloadStarter: async () => 9,
    requestFactory: () => async () => new Response(null, { status: 200 }),
  };
  const interrupted = await createAgentCommandHandler({
    ...base,
    downloadWaiter: async () => ({ state: "interrupted", path: "/Users/test/Downloads/clip.mp4", bytes: 10 }),
  })({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo" });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.error.code, "DOWNLOAD_INTERRUPTED");
  assert.deepEqual(interrupted.result, { state: "interrupted", path: "/Users/test/Downloads/clip.mp4", bytes: 10 });
  assert.equal(validateBridgeResponse(interrupted, REQUEST_ID), true);

  const empty = await createAgentCommandHandler({
    ...base,
    downloadWaiter: async () => ({ state: "complete", path: "/Users/test/Downloads/empty.mp4", bytes: 0 }),
  })({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo" });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "DOWNLOAD_EMPTY");
});

test("CLI bridge request clears listeners and never retries after a timeout", async () => {
  await withShortTempDir(async (root) => {
    const socketPath = join(root, "bridge.sock");
    const sessionId = SESSION_1;
    const config = { appSupportDir: root };
    const { bridgeSocketPath } = await import("../skills/weixin-channels-video/scripts/bridge-install.mjs");
    const path = bridgeSocketPath(config, sessionId);
    const server = createAuthenticatedFakeServer({ onTask: (request, client) => setTimeout(() => client.write(Buffer.from(encodeBridgeFrame({
      type: "result", version: 2,
      response: { id: request.id, ok: true, result: { title: "late" } },
    }))), 100) });
    await mkdir(root, { recursive: true });
    await new Promise((resolve) => server.listen(path, resolve));
    let connectCount = 0;
    let socket;
    const request = { id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/demo" };
    await assert.rejects(requestBridge(config, SESSION_INFO, request, {
      timeoutMs: 20,
      connectImpl: (...args) => {
        connectCount += 1;
        socket = connect(...args);
        return socket;
      },
    }), (error) => error instanceof BridgeError && error.code === "BRIDGE_TIMEOUT");
    assert.equal(connectCount, 1);
    assert.equal(socket.listenerCount("data"), 0);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.endsWith(".sock"), true);
  });
});

test("socket access failures stay distinct from disconnected bridge status and redact OS details", async () => {
  const config = { appSupportDir: "/tmp/wcv-private-bridge" };
  const rawError = Object.assign(new Error("EACCES /private/tmp/private-session.sock"), { code: "EACCES" });
  const socketFor = (error) => {
    const socket = new EventEmitter();
    socket.write = () => {};
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit("error", error));
    return socket;
  };

  for (const code of ["ENOENT", "ECONNREFUSED", "ECONNRESET"]) {
    const error = Object.assign(new Error(`${code} private socket path`), { code });
    await assert.rejects(requestBridge(config, SESSION_INFO, { id: REQUEST_ID, command: "status" }, {
      connectImpl: () => socketFor(error),
    }), (failure) => failure instanceof BridgeError &&
      failure.code === "BRIDGE_DISCONNECTED" &&
      failure.message === BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
  }

  const stdout = [];
  const stderr = [];
  const status = await runCli(["status"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    bridgeRequest: (bridgeConfig, sessionInfo, request, options) => requestBridge(
      bridgeConfig,
      sessionInfo,
      request,
      { ...options, connectImpl: () => socketFor(rawError) },
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    configuration: "configured",
    connection: "failed:BRIDGE_CONNECTION_FAILED",
    login: "not_checked",
  });
  assert.equal(stderr.length, 0);
  assert.equal(JSON.stringify(stdout).includes("EACCES"), false);
  assert.equal(JSON.stringify(stdout).includes("private-session.sock"), false);

  const connectErrors = [];
  const connectStatus = await runCli(["connect"], {
    stderr: (value) => connectErrors.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    bridgeWait: async () => { throw new BridgeError("BRIDGE_CONNECTION_FAILED", rawError.message); },
  });
  assert.equal(connectStatus, 1);
  assert.equal(connectErrors[0], `BRIDGE_CONNECTION_FAILED: ${BRIDGE_ERROR_MESSAGES.BRIDGE_CONNECTION_FAILED}`);
  assert.equal(connectErrors[0].includes("EACCES"), false);
});

test("waitForBridge rejects a mismatched IPC secret and connect does not rotate the session", async () => {
  await withShortTempDir(async (root) => {
    const config = { appSupportDir: root };
    const socketPath = bridgeSocketPath(config, SESSION_1);
    const server = createAuthenticatedFakeServer({ hostSecret: "c".repeat(64) });
    await new Promise((resolve) => server.listen(socketPath, resolve));

    const errors = [];
    let launchedChrome = false;
    const exitCode = await runCli(["connect"], {
      stderr: (value) => errors.push(value),
      readInstallation: async () => config,
      readSession: async () => SESSION_INFO,
      bridgeWait: (bridgeConfig, sessionInfo, options) => waitForBridge(bridgeConfig, sessionInfo, {
        ...options,
        timeoutMs: 250,
      }),
      launch: async () => { launchedChrome = true; },
    });
    await new Promise((resolve) => server.close(resolve));

    assert.equal(exitCode, 1);
    assert.equal(errors[0], `BRIDGE_SESSION_MISMATCH: ${BRIDGE_ERROR_MESSAGES.BRIDGE_SESSION_MISMATCH}`);
    assert.equal(launchedChrome, false);
  });
});
