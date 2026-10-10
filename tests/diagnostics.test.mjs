import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError } from "../skills/weixin-channels-video/scripts/bridge-client.mjs";
import { diagnoseEnvironment, inspectChromeInstallation, inspectChromeRunning, launchChrome } from "../skills/weixin-channels-video/scripts/diagnostics.mjs";
import { inspectChromeProfile } from "../skills/weixin-channels-video/scripts/chrome-profile.mjs";
import { inspectBridgeComponents } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { runCli } from "../skills/weixin-channels-video/scripts/cli.mjs";

const EXTENSION_ID = "a".repeat(32);
const OTHER_EXTENSION_ID = "b".repeat(32);
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const IPC_SECRET = "c".repeat(64);

async function withChromeProfile(callback) {
  const root = await mkdtemp(join(tmpdir(), "wcv-diagnose-"));
  const userDataDir = join(root, "Chrome User Data");
  const profileDirectory = "Profile 2";
  await mkdir(join(userDataDir, profileDirectory), { recursive: true });
  await writeFile(join(userDataDir, "Local State"), JSON.stringify({
    profile: { info_cache: { [profileDirectory]: { name: "private profile name" } } },
  }));
  try { await callback({ root, userDataDir, profileDirectory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("profile diagnostics read Chrome extension state without touching cookie files", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const profile = join(userDataDir, profileDirectory);
    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", disable_reasons: [] } } },
    }));
    await writeFile(join(profile, "Cookies"), "must not be read");
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "enabled",
    });

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", disable_reasons: [1] } } },
    }));
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "disabled",
    });

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", state: 0 } } },
    }));
    assert.equal((await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID })).extension, "disabled");
    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", state: 1 } } },
    }));
    assert.equal((await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID })).extension, "enabled");

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension" } } },
    }));
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "recorded_unknown",
    });

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [OTHER_EXTENSION_ID]: { path: "/private/other" } } },
    }));
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "missing_or_id_mismatch_possible",
    });
  });
});

test("profile diagnosis distinguishes missing, unreadable, and unconfigured profiles", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    assert.deepEqual(await inspectChromeProfile({ userDataDir, extensionId: EXTENSION_ID }), {
      state: "not_configured",
      extension: "unknown",
    });
    assert.deepEqual(await inspectChromeProfile({ profileDirectory: "Profile 9", userDataDir, extensionId: EXTENSION_ID }), {
      state: "not_found",
      extension: "unknown",
    });
    await writeFile(join(userDataDir, "Local State"), "not json");
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "metadata_unreadable",
      extension: "unknown",
    });
  });
});

test("diagnosis keeps unavailable evidence unknown and redacts local identifiers", async () => {
  const config = {
    extensionId: EXTENSION_ID,
    profileDirectory: "Profile 2",
    chromeUserDataDir: "/private/Chrome User Data",
    appSupportDir: "/private/bridge",
  };
  const sessionInfo = { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET };
  const result = await diagnoseEnvironment({ configuration: "configured", config, sessionInfo }, {
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported", appPath: "/private/Chrome.app" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "recorded_unknown", profileName: "private profile name" }),
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", path: "/private/bridge" }),
    bridgeWait: async (_config, received) => {
      assert.deepEqual(received, sessionInfo);
      throw new BridgeError("BRIDGE_SESSION_MISMATCH", "ignored");
    },
  });
  assert.deepEqual(result, {
    configuration: "configured",
    chrome: {
      installation: "installed",
      version: "154.0.8037.98",
      compatibility: "supported",
      running: "running",
    },
    profile: { state: "exists" },
    extension: { state: "recorded_unknown" },
    bridge: { registration: "valid", host: "present", launcher: "valid", node: "available", nodeVersion: null, session: "available", security: "unknown" },
    connection: { state: "session_mismatch" },
    actions: ["check_extension_enabled_state_in_chrome", "repair_bridge_session_mismatch"],
    nextAction: "check_extension_enabled_state_in_chrome",
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [EXTENSION_ID, SESSION_ID, IPC_SECRET, "/private/", "private profile name"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("diagnosis exposes only validated packaged runtime fields and the current Node identity", async () => {
  const result = await diagnoseEnvironment({ configuration: "unconfigured" }, {
    includeRuntime: true,
    inspectChrome: () => ({ installation: "unknown", version: null, compatibility: "unknown" }),
    inspectRunning: () => "unknown",
  });
  assert.deepEqual(Object.keys(result.runtime), ["version", "runtimeProtocol", "minimumNodeVersion"]);
  assert.deepEqual(result.runtime, {
    version: "unknown",
    runtimeProtocol: "unknown",
    minimumNodeVersion: "unknown",
  });
  assert.deepEqual(result.currentNode, {
    version: process.versions.node,
    absolutePath: process.execPath,
  });
});

test("unsupported or unavailable host tools produce unknown Chrome state", () => {
  assert.deepEqual(inspectChromeInstallation({ platform: "linux" }), {
    installation: "unknown",
    version: null,
    compatibility: "unknown",
    appPath: null,
    executable: null,
  });
  assert.equal(inspectChromeRunning({ platform: "linux" }), "unknown");
});

test("Chrome discovery verifies the macOS bundle id and version before launch", () => {
  const appPath = "/Applications/Google Chrome.app";
  const runner = (_path, args) => {
    if (args[0].startsWith("kMDItem")) return { status: 0, stdout: "" };
    if (args[0] === "-c") {
      const key = args[1].slice("Print :".length);
      return { status: 0, stdout: ({
        CFBundleIdentifier: "com.google.Chrome",
        CFBundleShortVersionString: "154.0.8037.98",
        CFBundleExecutable: "Google Chrome",
      })[key] };
    }
    return { status: 1, stdout: "" };
  };
  assert.deepEqual(inspectChromeInstallation({ platform: "darwin", home: "/Users/test", commandRunner: runner }), {
    installation: "installed",
    version: "154.0.8037.98",
    compatibility: "supported",
    appPath,
    executable: join(appPath, "Contents/MacOS/Google Chrome"),
  });
  const oldRunner = (_path, args) => args[0].startsWith("kMDItem")
    ? { status: 0, stdout: "" }
    : args[0] === "-c" && args[1] === "Print :CFBundleIdentifier"
      ? { status: 0, stdout: "com.google.Chrome" }
      : args[0] === "-c" && args[1] === "Print :CFBundleShortVersionString"
        ? { status: 0, stdout: "115.0.0.0" }
        : { status: 0, stdout: "Google Chrome" };
  assert.equal(inspectChromeInstallation({ platform: "darwin", commandRunner: oldRunner }).compatibility, "too_old");
  const unavailableRunner = () => ({ status: null, error: new Error("unavailable") });
  assert.equal(inspectChromeInstallation({ platform: "darwin", commandRunner: unavailableRunner }).installation, "unknown");
});

test("Windows Chrome discovery checks known installation paths and records supported versions", () => {
  const calls = [];
  const env = {
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  };
  const expected = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  const result = inspectChromeInstallation({
    platform: "win32",
    env,
    commandRunner: (_path, args, options) => {
      const candidate = options.env.WCV_CHROME_EXE;
      calls.push(candidate);
      return candidate === expected
        ? { status: 0, stdout: "154.0.8037.98\n" }
        : { status: 10, stdout: "" };
    },
  });
  assert.deepEqual(calls, [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    expected,
  ]);
  assert.deepEqual(result, {
    installation: "installed",
    version: "154.0.8037.98",
    compatibility: "supported",
    appPath: expected,
    executable: expected,
  });
  assert.equal(inspectChromeRunning({ platform: "win32", commandRunner: () => ({ status: 0, stdout: '"chrome.exe","1234"' }) }), "running");
  assert.equal(inspectChromeRunning({ platform: "win32", commandRunner: () => ({ status: 0, stdout: "INFO: No tasks are running" }) }), "not_running");

  const defaultCalls = [];
  const defaultWrapperResult = inspectChromeInstallation({
    platform: "win32",
    env,
    spawnSyncImpl: (path, args, options) => {
      defaultCalls.push({ path, args, env: options.env });
      return { status: 0, stdout: "154.0.8037.98\n" };
    },
  });
  assert.equal(defaultWrapperResult.installation, "installed");
  assert.equal(defaultCalls[0].env.WCV_CHROME_EXE, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(defaultCalls[0].args[3].includes("$env:WCV_CHROME_EXE"), true);
  assert.ok(defaultCalls[0].args[3].indexOf("Microsoft.PowerShell.Management.psd1") < defaultCalls[0].args[3].indexOf("Get-Item -LiteralPath"));
});

test("Windows Chrome launch passes long profile paths as argv without a shell", async () => {
  const calls = [];
  const config = {
    chromeUserDataDir: "C:\\Users\\Test User\\AppData\\Local\\Google\\Chrome\\User Data",
    profileDirectory: "Profile 2",
    extensionId: EXTENSION_ID,
  };
  await launchChrome(config, SESSION_ID, {
    platform: "win32",
    inspectChrome: () => ({ installation: "installed", compatibility: "supported", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }),
    inspectProfile: async () => ({}),
    processLauncher: async (executable, args) => {
      calls.push({ executable, args });
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [{
    executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: [
      `--user-data-dir=${config.chromeUserDataDir}`,
      "--profile-directory=Profile 2",
      `chrome-extension://${EXTENSION_ID}/index.html#agent-connect=${SESSION_ID}`,
    ],
  }]);
});

test("Chrome launch is backgrounded, uses the selected profile, and only adds the bootstrap URL when asked", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const config = { chromeUserDataDir: userDataDir, profileDirectory, extensionId: EXTENSION_ID };
    const calls = [];
    const inspectChrome = () => ({ installation: "installed", compatibility: "supported", appPath: "/Applications/Google Chrome.app" });
    const commandRunner = (path, args) => {
      calls.push({ path, args });
      return { status: 0, stdout: "" };
    };
    await launchChrome(config, undefined, { platform: "darwin", inspectChrome, commandRunner });
    assert.deepEqual(calls[0].args, [
      "-g", "-n", "-a", "/Applications/Google Chrome.app", "--args",
      `--user-data-dir=${userDataDir}`, `--profile-directory=${profileDirectory}`,
    ]);
    await launchChrome(config, SESSION_ID, { platform: "darwin", inspectChrome, commandRunner });
    assert.equal(calls[1].args.at(-1), `chrome-extension://${EXTENSION_ID}/index.html#agent-connect=${SESSION_ID}`);
    assert.equal(calls[1].args.includes("--headless"), false);
    assert.equal(calls[1].args.some((argument) => argument.startsWith("--remote-debugging")), false);
  });
});

test("Chrome launch refuses to create a missing selected profile", async () => {
  await withChromeProfile(async ({ userDataDir }) => {
    const calls = [];
    await assert.rejects(launchChrome({
      chromeUserDataDir: userDataDir,
      profileDirectory: "Profile 9",
      extensionId: EXTENSION_ID,
    }, undefined, {
      platform: "darwin",
      inspectChrome: () => ({ installation: "installed", compatibility: "supported", appPath: "/Applications/Google Chrome.app" }),
      commandRunner: (...args) => { calls.push(args); return { status: 0, stdout: "" }; },
    }), { code: "CHROME_PROFILE_UNAVAILABLE" });
    assert.equal(calls.length, 0);
  });
});

test("Chrome launch reports unsupported platforms without reading configuration or launching an app", async () => {
  const calls = [];
  await assert.rejects(launchChrome({}, undefined, {
    platform: "linux",
    inspectChrome: () => { calls.push("inspectChrome"); throw new Error("must not inspect"); },
    inspectProfile: () => { calls.push("inspectProfile"); throw new Error("must not inspect"); },
    commandRunner: () => { calls.push("commandRunner"); return { status: 0, stdout: "" }; },
  }), { code: "CHROME_UNAVAILABLE" });
  assert.deepEqual(calls, []);
});

test("diagnosis preserves native connection failures", async () => {
  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { profileDirectory: "Default", chromeUserDataDir: "/private/Chrome User Data", extensionId: EXTENSION_ID },
    sessionId: SESSION_ID,
  }, {
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "enabled" }),
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available" }),
    bridgeWait: async () => { throw new BridgeError("BRIDGE_CONNECTION_FAILED", "ignored"); },
  });
  assert.equal(result.connection.state, "connection_failed");
  assert.deepEqual(result.actions, ["restore_connection_before_next_task"]);
});

test("diagnosis recommends bridge repair when Windows private-path security is invalid", async () => {
  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { profileDirectory: "Default", chromeUserDataDir: "C:\\Chrome User Data", extensionId: EXTENSION_ID },
  }, {
    platform: "win32",
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "enabled" }),
    inspectBridge: async () => ({
      registration: "valid",
      host: "present",
      launcher: "valid",
      node: "available",
      session: "available",
      security: "invalid",
    }),
  });
  assert.equal(result.bridge.host, "present");
  assert.equal(result.bridge.launcher, "valid");
  assert.deepEqual(result.actions, ["repair_bridge_if_authorized"]);
  assert.equal(result.nextAction, "repair_bridge_if_authorized");
});

test("bridge diagnostics runs the configured absolute Node safely and classifies its version", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "wcv-node-diagnose-"));
  const hostPath = join(root, "native-host.mjs");
  const configPath = join(root, "bridge.json");
  const launcherPath = join(root, "native-host-launcher");
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  await writeFile(hostPath, "// native host fixture\n");
  await writeFile(launcherPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hostPath)} ${quote(configPath)} "$@"\n`, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
  const config = {
    platform: "darwin",
    appSupportDir: root,
    chromeUserDataDir: join(root, "Chrome User Data"),
    nodeExecutable: process.execPath,
    extensionId: EXTENSION_ID,
  };
  const cases = [
    [{ status: 0, stdout: "v22.22.2\n" }, "available", "22.22.2"],
    [{ status: 0, stdout: "v20.0.0\n" }, "version_incompatible", "20.0.0"],
    [{ error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, "missing", null],
    [{ error: Object.assign(new Error("denied"), { code: "EACCES" }) }, "access_failed", null],
  ];
  try {
    for (const [spawnResult, expectedState, expectedVersion] of cases) {
      const inspected = await inspectBridgeComponents(config, {
        platform: "darwin",
        nodeSpawnSyncImpl: (executable, args, options) => {
          assert.equal(executable, process.execPath);
          assert.deepEqual(args, ["--version"]);
          assert.equal(options.shell, false);
          assert.equal(options.env.PATH, "");
          assert.equal(options.env.NODE_OPTIONS, undefined);
          return spawnResult;
        },
      });
      assert.equal(inspected.launcher, "valid");
      assert.equal(inspected.node, expectedState);
      assert.equal(inspected.nodeVersion, expectedVersion);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose CLI is read only and reports invalid configuration as structured JSON", async () => {
  let received;
  const output = [];
  assert.equal(await runCli(["diagnose"], {
    stdout: (value) => output.push(value),
    readInstallation: async () => { throw new Error("private configuration details"); },
    diagnose: async (request) => {
      received = request;
      return { configuration: request.configuration, actions: ["configure_bridge_and_select_profile"] };
    },
  }), 0);
  assert.deepEqual(received, { configuration: "invalid", config: undefined, sessionInfo: undefined });
  assert.deepEqual(JSON.parse(output[0]), { configuration: "invalid", actions: ["configure_bridge_and_select_profile"] });
  assert.equal(output[0].includes("private configuration details"), false);
});

test("candidate diagnosis checks recorded profile state only and emits one next action", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const profile = join(userDataDir, profileDirectory);
    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { state: 1 } } },
    }));
    let bridgeWaitCalls = 0;
    const result = await diagnoseEnvironment({
      configuration: "unconfigured",
      candidate: { profile: profileDirectory, extensionId: EXTENSION_ID },
    }, {
      platform: "darwin",
      chromeUserDataDir: userDataDir,
      inspectChrome: () => ({ installation: "installed", version: "154.0.0.0", compatibility: "supported" }),
      inspectRunning: () => "unknown",
      bridgeWait: async () => { bridgeWaitCalls += 1; },
    });
    assert.deepEqual(result.candidate, {
      checkScope: "chrome_profile_metadata",
      status: "recorded_enabled",
      reason: "extension_enabled",
      profile: { state: "exists" },
      extension: { state: "enabled" },
      liveHandshake: "not_checked",
      nextAction: "install_bridge_with_selected_profile",
    });
    assert.equal(result.nextAction, "install_bridge_with_selected_profile");
    assert.equal(result.actions.includes("configure_bridge_and_select_profile"), false);
    assert.equal(bridgeWaitCalls, 0);
    const serialized = JSON.stringify(result.candidate);
    assert.equal(serialized.includes(EXTENSION_ID), false);
    assert.equal(serialized.includes(profileDirectory), false);
  });
});

test("candidate diagnose CLI validates the pair and does not read installed configuration", async () => {
  const output = [];
  let request;
  const code = await runCli(["diagnose", "--profile", "Profile 2", "--extension-id", EXTENSION_ID], {
    stdout: (value) => output.push(value),
    readInstallation: async () => { throw new Error("must not read installed configuration"); },
    diagnose: async (value) => { request = value; return { candidate: { nextAction: "install_bridge_with_selected_profile" } }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(request, {
    configuration: "unconfigured",
    candidate: { profile: "Profile 2", extensionId: EXTENSION_ID },
  });
  assert.deepEqual(JSON.parse(output[0]), { candidate: { nextAction: "install_bridge_with_selected_profile" } });

  assert.equal(await runCli(["diagnose", "--profile", "Profile 2"], { stderr: () => {} }), 2);
});
