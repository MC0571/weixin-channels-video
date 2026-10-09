import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError } from "../skills/weixin-channels-video/scripts/bridge-client.mjs";
import { diagnoseEnvironment, inspectChromeInstallation, inspectChromeRunning, launchChrome } from "../skills/weixin-channels-video/scripts/diagnostics.mjs";
import { inspectChromeProfile } from "../skills/weixin-channels-video/scripts/chrome-profile.mjs";
import { runCli } from "../skills/weixin-channels-video/scripts/cli.mjs";

const EXTENSION_ID = "a".repeat(32);
const OTHER_EXTENSION_ID = "b".repeat(32);
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

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
  const result = await diagnoseEnvironment({ configuration: "configured", config, sessionId: SESSION_ID }, {
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported", appPath: "/private/Chrome.app" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "recorded_unknown", profileName: "private profile name" }),
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", path: "/private/bridge" }),
    bridgeWait: async () => { throw new BridgeError("BRIDGE_SESSION_MISMATCH", "ignored"); },
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
    bridge: { registration: "valid", host: "present", launcher: "valid", node: "available", session: "available" },
    connection: { state: "session_mismatch" },
    actions: ["check_extension_enabled_state_in_chrome", "repair_bridge_session_mismatch"],
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [EXTENSION_ID, SESSION_ID, "/private/", "private profile name"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
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
  assert.deepEqual(received, { configuration: "invalid", config: undefined, sessionId: undefined });
  assert.deepEqual(JSON.parse(output[0]), { configuration: "invalid", actions: ["configure_bridge_and_select_profile"] });
  assert.equal(output[0].includes("private configuration details"), false);
});
