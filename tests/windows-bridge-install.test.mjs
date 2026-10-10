import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BridgeSetupError, installBridge, inspectBridgeComponents } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { NATIVE_HOST_NAME } from "../src/native-messaging.mjs";

const extensionId = "a".repeat(32);
const nativeHostSource = fileURLToPath(new URL("../src/native-host.mjs", import.meta.url));

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
    assert.match(launcher, /--parent-window=/);
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
    const invocation = `"${manifest.path}" ${origin} --parent-window=12345`;
    const child = spawnSync("cmd.exe", ["/d", "/s", "/c", invocation], {
      input,
      encoding: null,
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, WCV_CAPTURE: capturePath },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr?.toString("utf8"));
    assert.deepEqual(child.stdout, input);
    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), [
      config.configPath,
      origin,
      "--parent-window=12345",
    ]);
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
    const child = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${manifest.path}" ${origin} --parent-window=12345`], {
      input,
      encoding: null,
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, WCV_CAPTURE: capturePath },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr?.toString("utf8"));
    assert.deepEqual(child.stdout, input);
    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), [
      config.configPath,
      origin,
      "--parent-window=12345",
    ]);
  });
});
