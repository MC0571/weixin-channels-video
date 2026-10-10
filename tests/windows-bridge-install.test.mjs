import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BridgeSetupError, installBridge, inspectBridgeComponents } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { NATIVE_HOST_NAME } from "../src/native-messaging.mjs";

const extensionId = "a".repeat(32);
const nativeHostSource = fileURLToPath(new URL("../src/native-host.mjs", import.meta.url));
const launcherTimeoutMs = 15_000;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function waitForClose(child, category) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(fixedError(category)));
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
}

async function waitAtMost(promise, durationMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), durationMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function launcherTimeoutError(capturePath, stdout, stderr) {
  let hostStarted = false;
  try {
    await stat(capturePath);
    hostStarted = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = fixedError("WINDOWS_LAUNCHER_TIMEOUT");
  result.message = `WINDOWS_LAUNCHER_TIMEOUT hostStarted=${hostStarted} stdoutBytes=${Buffer.concat(stdout).length} stderrSeen=${stderr.length > 0}`;
  return result;
}

async function runWindowsLauncher(invocation, { input, env, capturePath }) {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", invocation], {
    env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdinFailed = false;
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.on("error", () => { stdinFailed = true; });
  const closePromise = waitForClose(child, "WINDOWS_LAUNCHER_SPAWN_FAILED");

  let taskkill;
  let timedOut = false;
  try {
    child.stdin.end(input);
    const result = await waitAtMost(closePromise, launcherTimeoutMs);
    if (result) {
      if (stdinFailed) throw fixedError("WINDOWS_LAUNCHER_STDIN_FAILED");
      return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    }

    timedOut = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw await launcherTimeoutError(capturePath, stdout, stderr);
    }
    const pid = child.pid;
    if (!Number.isSafeInteger(pid)) throw fixedError("WINDOWS_LAUNCHER_TIMEOUT_NO_PID");
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    taskkill = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let taskkillClose;
    try {
      taskkillClose = await waitAtMost(
        waitForClose(taskkill, "WINDOWS_TREE_CLEANUP_FAILED"),
        5_000,
      );
    } catch {
      taskkillClose = null;
    }
    const childClose = await waitAtMost(closePromise, 5_000);
    if (!childClose) throw fixedError("WINDOWS_TREE_CLEANUP_TIMEOUT");
    if (!taskkillClose || taskkillClose.status !== 0) {
      throw fixedError("WINDOWS_TREE_CLEANUP_FAILED");
    }
    throw await launcherTimeoutError(capturePath, stdout, stderr);
  } finally {
    if (timedOut && child.exitCode === null && child.signalCode === null) child.kill();
    if (taskkill && taskkill.exitCode === null && taskkill.signalCode === null) taskkill.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    taskkill?.unref();
  }
}

async function withTempDir(callback) {
  const root = await mkdtemp(join(tmpdir(), "wcv-win-bridge-"));
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function createChromeProfile(root) {
  const chromeUserDataDir = join(root, "Chrome User Data");
  await mkdir(join(chromeUserDataDir, "Default"), { recursive: true });
  await writeFile(join(chromeUserDataDir, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { name: "Default" } } },
  }));
  return chromeUserDataDir;
}

function successfulPowerShell(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };
}

function registryMock() {
  let value = null;
  let failWrites = false;
  return {
    async read() { return value; },
    async write(_key, path) {
      if (failWrites) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
      value = path;
    },
    async remove(_key, expectedPath) { if (value === expectedPath) value = null; },
    failWrites() { failWrites = true; },
  };
}

function installOptions({ root, chromeUserDataDir, appSupportDir, registry, securityCalls, shortPathResolver }) {
  return {
    extensionId,
    profile: "Default",
    appSupportDir,
    chromeUserDataDir,
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    nativeHostSource,
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    registry,
    securitySpawnSyncImpl: successfulPowerShell(securityCalls),
    shortPathResolver,
  };
}

test("Windows bridge install keeps Unicode and spaces in long paths and stages files before registration", async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "桥接 空格");
    const registry = registryMock();
    const securityCalls = [];
    const shortPathCalls = [];
    const installed = await installBridge(installOptions({
      root: tempRoot,
      chromeUserDataDir,
      appSupportDir,
      registry,
      securityCalls,
      shortPathResolver: async (path) => {
        shortPathCalls.push(path);
        throw new Error("unexpected short-path resolution");
      },
    }));

    const manifest = JSON.parse(await readFile(installed.hostManifestPath, "utf8"));
    const config = JSON.parse(await readFile(join(appSupportDir, "bridge.json"), "utf8"));
    const launcher = await readFile(installed.launcherPath, "utf8");
    assert.equal(manifest.path, installed.launcherPath);
    assert.equal(config.nodeExecutable, "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(config.appSupportDir, appSupportDir);
    assert.match(launcher, /%~dp0/);
    assert.match(launcher, /Get-Content[^\r\n]+-Encoding UTF8/);
    assert.match(launcher, /Assert-WcvPrivatePath/);
    assert.match(launcher, /GetFile\(\$actualConfig\)\.ShortPath/);
    for (const moduleName of ["Microsoft.PowerShell.Security", "Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility"]) {
      assert.ok(launcher.includes(`${moduleName}.psd1`));
    }
    assert.match(launcher, /--parent-window=/);
    assert.match(launcher, /\$process\.RedirectStandardError=\$true/);
    assert.match(launcher, /\$child\.StandardError\.BaseStream\.CopyToAsync\(\[Console\]::OpenStandardError\(\)\)/);
    assert.match(launcher, /\[void\]\$errorCopy\.GetAwaiter\(\)\.GetResult\(\)/);
    assert.doesNotMatch(launcher, /RedirectStandardInput|RedirectStandardOutput/);
    assert.match(launcher, /WCV_PARENT_WINDOW=%~2/);
    assert.match(launcher, /WCV_PARENT_WINDOW_VALUE=%~3/);
    const commandLine = launcher.split("\r\n").find((line) => line.includes("powershell.exe"));
    assert.ok(commandLine.length < 8191);
    assert.doesNotMatch(launcher, /Program Files|桥接/);
    assert.equal(/^[\x00-\x7f]*$/.test(launcher), true);
    assert.deepEqual(shortPathCalls, []);
    assert.ok(securityCalls.length >= 10);
    assert.equal(await registry.read(), installed.hostManifestPath);
  });
});

test("Windows default registry adapter checks both Chrome registry views", async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "registry bridge");
    const registryCommands = [];
    let registeredPath = null;
    const options = installOptions({
      root: tempRoot,
      chromeUserDataDir,
      appSupportDir,
      registry: undefined,
      securityCalls: [],
      shortPathResolver: async () => { throw new Error("unexpected short-path resolution"); },
    });
    delete options.registry;
    options.powershellSpawnSyncImpl = (_executable, args, settings) => {
      const mode = settings.env.WCV_REGISTRY_MODE;
      registryCommands.push(args[3]);
      if (mode === "read") return registeredPath === null
        ? { status: 10, stdout: "" }
        : { status: 0, stdout: `${registeredPath}\n` };
      if (mode === "write") registeredPath = settings.env.WCV_REGISTRY_MANIFEST;
      return { status: 0, stdout: "" };
    };
    await installBridge(options);
    assert.equal(registeredPath, join(appSupportDir, `${NATIVE_HOST_NAME}.json`));
    assert.ok(registryCommands.length >= 3);
    assert.ok(registryCommands.every((command) => command.includes("[Microsoft.Win32.RegistryView]::Registry32")));
    assert.ok(registryCommands.every((command) => command.includes("[Microsoft.Win32.RegistryView]::Registry64")));
    assert.ok(registryCommands.every((command) => command.indexOf("Microsoft.PowerShell.Utility.psd1") < command.indexOf("if ($mode -eq 'read')")));
  });
});

test("Windows short-path resolution imports the fixed Utility manifest", async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "private!bridge");
    const commands = [];
    const options = installOptions({
      root: tempRoot,
      chromeUserDataDir,
      appSupportDir,
      registry: registryMock(),
      securityCalls: [],
      shortPathResolver: undefined,
    });
    options.powershellSpawnSyncImpl = (_executable, args, settings) => {
      commands.push(args[3]);
      const path = settings.env.WCV_SHORT_PATH;
      const stdout = path.endsWith("native-host-launcher.cmd")
        ? "C:\\WCV~1\\native-host-launcher.cmd\n"
        : "C:\\WCV~1\n";
      return { status: 0, stdout };
    };

    await installBridge(options);
    assert.equal(commands.length, 2);
    assert.ok(commands.every((command) => command.indexOf("Microsoft.PowerShell.Utility.psd1") < command.indexOf("New-Object -ComObject")));
  });
});

test("Windows bridge uses a verified safe launcher alias only for CMD metacharacters and rolls back failed registration", async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "private!bridge");
    const registry = registryMock();
    const securityCalls = [];
    const shortPathCalls = [];
    const aliasRoot = "C:\\Users\\RUNNER~1\\WCV~1";
    const launcherPath = join(appSupportDir, "native-host-launcher.cmd");
    const shortPathResolver = async (path) => {
      shortPathCalls.push(path);
      if (path === appSupportDir) return aliasRoot;
      if (path === launcherPath) return win32.join(aliasRoot, "native-host-launcher.cmd");
      throw new Error("only the unsafe launcher entry may use a short alias");
    };
    const options = installOptions({ root: tempRoot, chromeUserDataDir, appSupportDir, registry, securityCalls, shortPathResolver });
    const installed = await installBridge(options);
    const manifest = JSON.parse(await readFile(installed.hostManifestPath, "utf8"));
    assert.equal(manifest.path, win32.join(aliasRoot, "native-host-launcher.cmd"));
    assert.deepEqual(shortPathCalls, [appSupportDir, launcherPath]);

    const paths = [
      join(appSupportDir, "native-host.mjs"),
      join(appSupportDir, "bridge.json"),
      join(appSupportDir, "session.json"),
      launcherPath,
      installed.hostManifestPath,
    ];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    registry.failWrites();
    await assert.rejects(installBridge(options), /WINDOWS_REGISTRATION_UNAVAILABLE/);
    const after = await Promise.all(paths.map((path) => readFile(path)));
    for (let index = 0; index < paths.length; index += 1) assert.deepEqual(after[index], before[index], paths[index]);
  });
});

test("Windows refuses an unsafe launcher path before replacing existing configuration when no alias is available", async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "private!bridge");
    await mkdir(appSupportDir);
    const configPath = join(appSupportDir, "bridge.json");
    await writeFile(configPath, "existing configuration\n");
    const registry = registryMock();
    const securityCalls = [];
    const options = installOptions({
      root: tempRoot,
      chromeUserDataDir,
      appSupportDir,
      registry,
      securityCalls,
      shortPathResolver: async () => { throw new Error("no safe alias"); },
    });
    await assert.rejects(installBridge(options), (error) => error instanceof BridgeSetupError && error.code === "UNSAFE_LAUNCHER_PATH");
    assert.equal(await readFile(configPath, "utf8"), "existing configuration\n");
    assert.equal(await registry.read(), null);
  });
});

test("Windows PowerShell and ACL integration runs against an isolated profile and mocked registry", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "bridge");
    const registry = registryMock();
    const installed = await installBridge({
      extensionId,
      profile: "Default",
      appSupportDir,
      chromeUserDataDir,
      nodeExecutable: process.execPath,
      nativeHostSource,
      platform: "win32",
      registry,
    });
    const inspected = await inspectBridgeComponents(installed.config, {
      platform: "win32",
      registry,
    });
    assert.deepEqual(inspected, {
      registration: "valid",
      host: "present",
      launcher: "valid",
      node: "available",
      nodeVersion: process.versions.node,
      session: "available",
      security: "valid",
    });
  });
});

test("Windows bridge inspection reports valid and invalid private-path security", async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "bridge");
    const registry = registryMock();
    const installed = await installBridge(installOptions({
      root: tempRoot,
      chromeUserDataDir,
      appSupportDir,
      registry,
      securityCalls: [],
      shortPathResolver: async () => { throw new Error("unexpected short-path resolution"); },
    }));
    const inspect = (securitySpawnSyncImpl) => inspectBridgeComponents(installed.config, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      registry,
      securitySpawnSyncImpl,
      nodeSpawnSyncImpl: () => ({ status: 0, stdout: "v24.0.0\n" }),
    });

    const valid = await inspect(() => ({ status: 0, stdout: "", stderr: "" }));
    assert.equal(valid.security, "valid");

    const hostPath = join(appSupportDir, "native-host.mjs");
    const invalid = await inspect((_executable, _args, options) => ({
      status: options.env.WCV_PRIVATE_PATH === hostPath ? 1 : 0,
      stdout: "",
      stderr: "",
    }));
    assert.equal(invalid.registration, "valid");
    assert.equal(invalid.host, "present");
    assert.equal(invalid.launcher, "valid");
    assert.equal(invalid.security, "invalid");
  });
});

test("Windows launcher preserves stdio frames and the Chrome argv through cmd.exe", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "桥接 空格");
    const nativeHostSource = join(tempRoot, "dummy native host.mjs");
    const capturePath = join(tempRoot, "captured argv.json");
    await writeFile(nativeHostSource, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.WCV_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      "process.stderr.write('WCV_FIXED_STDERR\\n');",
      "process.stdin.pipe(process.stdout);",
      "",
    ].join("\n"));
    const registry = registryMock();
    const installed = await installBridge({
      extensionId,
      profile: "Default",
      appSupportDir,
      chromeUserDataDir,
      nodeExecutable: process.execPath,
      nativeHostSource,
      platform: "win32",
      registry,
    });
    const manifest = JSON.parse(await readFile(installed.hostManifestPath, "utf8"));
    const config = JSON.parse(await readFile(join(appSupportDir, "bridge.json"), "utf8"));
    const origin = `chrome-extension://${extensionId}/`;
    const input = Buffer.from([0x00, 0x03, 0x7b, 0xff, 0x00, 0x0d, 0x0a]);
    const invocations = [
      { argument: "--parent-window=12345", expected: "--parent-window=12345" },
      { argument: '"--parent-window=12345"', expected: "--parent-window=12345" },
      { argument: "--parent-window 12345", expected: "--parent-window=12345" },
      { argument: "", expected: "--parent-window=0" },
    ];
    for (const { argument, expected } of invocations) {
      await rm(capturePath, { force: true });
      const invocation = argument
        ? `""${manifest.path}" ${origin} ${argument}"`
        : `""${manifest.path}" ${origin}"`;
      const child = await runWindowsLauncher(invocation, {
        input,
        env: { ...process.env, WCV_CAPTURE: capturePath },
        capturePath,
      });
      assert.equal(child.status, 0, "WINDOWS_LAUNCHER_EXITED_NONZERO");
      assert.deepEqual(child.stdout, input);
      assert.deepEqual(child.stderr, Buffer.from("WCV_FIXED_STDERR\n"));
      assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), [
        config.configPath,
        origin,
        expected,
      ]);
    }
  });
});

test("Windows launcher passes the canonical long config path when Chrome uses the safe short alias", {
  skip: process.platform !== "win32",
}, async (t) => {
  await withTempDir(async (tempRoot) => {
    const chromeUserDataDir = await createChromeProfile(tempRoot);
    const appSupportDir = join(tempRoot, "桥接! 空格");
    const nativeHostSource = join(tempRoot, "dummy native host.mjs");
    const capturePath = join(tempRoot, "captured argv.json");
    await writeFile(nativeHostSource, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.WCV_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      "process.stdin.pipe(process.stdout);",
      "",
    ].join("\n"));
    let installed;
    try {
      installed = await installBridge({
        extensionId,
        profile: "Default",
        appSupportDir,
        chromeUserDataDir,
        nodeExecutable: process.execPath,
        nativeHostSource,
        platform: "win32",
        registry: registryMock(),
      });
    } catch (error) {
      if (error instanceof BridgeSetupError && error.code === "UNSAFE_LAUNCHER_PATH") {
        t.skip("This volume does not provide a safe 8.3 alias for the temporary directory.");
        return;
      }
      throw error;
    }

    const manifest = JSON.parse(await readFile(installed.hostManifestPath, "utf8"));
    const config = JSON.parse(await readFile(join(appSupportDir, "bridge.json"), "utf8"));
    assert.notEqual(manifest.path, installed.launcherPath);
    assert.doesNotMatch(manifest.path, /!/);
    const origin = `chrome-extension://${extensionId}/`;
    const input = Buffer.from([0x00, 0x02, 0x7b, 0xff, 0x00, 0x0d, 0x0a]);
    await rm(capturePath, { force: true });
    const child = await runWindowsLauncher(`""${manifest.path}" ${origin} --parent-window=12345"`, {
      input,
      env: { ...process.env, WCV_CAPTURE: capturePath },
      capturePath,
    });
    assert.equal(child.status, 0, "WINDOWS_LAUNCHER_EXITED_NONZERO");
    assert.deepEqual(child.stdout, input);
    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), [
      config.configPath,
      origin,
      "--parent-window=12345",
    ]);
  });
});
