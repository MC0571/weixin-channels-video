import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_ERROR_MESSAGES, SESSION_ID_PATTERN } from "../../../src/native-messaging.mjs";
import { BridgeError, waitForBridge } from "./bridge-client.mjs";
import { inspectBridgeComponents } from "./bridge-install.mjs";
import { inspectChromeProfile, selectChromeProfile } from "./chrome-profile.mjs";

const CHROME_BUNDLE_ID = "com.google.Chrome";
const MINIMUM_CHROME_MAJOR = 116;

function command(commandPath, args) {
  const result = spawnSync(commandPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
  return result.error ? { error: result.error } : { status: result.status, stdout: result.stdout ?? "" };
}

function plistValue(path, key, commandRunner) {
  const result = commandRunner("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(path, "Contents/Info.plist")]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function inspectChromeInstallation({ platform = process.platform, home = homedir(), commandRunner = command } = {}) {
  if (platform !== "darwin") {
    return { installation: "unknown", version: null, compatibility: "unknown", appPath: null, executable: null };
  }
  const query = commandRunner("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${CHROME_BUNDLE_ID}'`]);
  const querySucceeded = query.status === 0;
  const candidates = [
    "/Applications/Google Chrome.app",
    join(home, "Applications/Google Chrome.app"),
    ...(querySucceeded ? query.stdout.trim().split("\n").filter(Boolean) : []),
  ];
  let sawUnusableCandidate = Boolean(query.error);
  for (const appPath of new Set(candidates)) {
    const bundleId = plistValue(appPath, "CFBundleIdentifier", commandRunner);
    if (bundleId !== CHROME_BUNDLE_ID) {
      if (bundleId !== null) continue;
      const info = commandRunner("/usr/bin/test", ["-f", join(appPath, "Contents/Info.plist")]);
      if (info.status === 0 || info.error) sawUnusableCandidate = true;
      continue;
    }
    const version = plistValue(appPath, "CFBundleShortVersionString", commandRunner);
    const major = /^\d+(?:\.\d+)*$/.test(version ?? "") ? Number(version.split(".")[0]) : null;
    const executableName = plistValue(appPath, "CFBundleExecutable", commandRunner);
    const executable = executableName ? join(appPath, "Contents/MacOS", executableName) : null;
    return {
      installation: "installed",
      version: major === null ? null : version,
      compatibility: major === null ? "unknown" : major < MINIMUM_CHROME_MAJOR ? "too_old" : "supported",
      appPath,
      executable,
    };
  }
  return {
    installation: querySucceeded && !sawUnusableCandidate ? "not_installed" : "unknown",
    version: null,
    compatibility: "unknown",
    appPath: null,
    executable: null,
  };
}

export function inspectChromeRunning({ platform = process.platform, commandRunner = command } = {}) {
  if (platform !== "darwin") return "unknown";
  const result = commandRunner("/usr/bin/pgrep", ["-x", "Google Chrome"]);
  if (result.status === 0) return "running";
  if (result.status === 1 && !result.error) return "not_running";
  return "unknown";
}

export async function launchChrome(config, sessionId, {
  platform = process.platform,
  inspectChrome = () => inspectChromeInstallation({ platform }),
  inspectProfile = selectChromeProfile,
  commandRunner = command,
} = {}) {
  if (platform !== "darwin") {
    throw new BridgeError("CHROME_UNAVAILABLE", BRIDGE_ERROR_MESSAGES.CHROME_UNAVAILABLE);
  }
  const chrome = inspectChrome();
  if (chrome.installation === "not_installed") {
    throw new BridgeError("CHROME_NOT_INSTALLED", "Google Chrome is not installed.");
  }
  if (chrome.installation !== "installed" || !chrome.appPath) {
    throw new BridgeError("CHROME_START_FAILED", BRIDGE_ERROR_MESSAGES.CHROME_START_FAILED);
  }
  if (chrome.compatibility === "too_old") {
    throw new BridgeError("CHROME_VERSION_UNSUPPORTED", BRIDGE_ERROR_MESSAGES.CHROME_VERSION_UNSUPPORTED);
  }
  try {
    await inspectProfile(config.profileDirectory, config.chromeUserDataDir);
  } catch {
    throw new BridgeError("CHROME_PROFILE_UNAVAILABLE", BRIDGE_ERROR_MESSAGES.CHROME_PROFILE_UNAVAILABLE);
  }
  const args = [
    "-g",
    "-n",
    "-a",
    chrome.appPath,
    "--args",
    `--user-data-dir=${config.chromeUserDataDir}`,
    `--profile-directory=${config.profileDirectory}`,
  ];
  if (sessionId) args.push(`chrome-extension://${config.extensionId}/index.html#agent-connect=${sessionId}`);
  const result = commandRunner("/usr/bin/open", args);
  if (result.status !== 0 || result.error) {
    throw new BridgeError("CHROME_START_FAILED", BRIDGE_ERROR_MESSAGES.CHROME_START_FAILED);
  }
}

function nextActions({ chrome, profile, extension, bridge, connection, configuration }) {
  const actions = [];
  if (configuration !== "configured") actions.push("configure_bridge_and_select_profile");
  if (chrome.installation === "not_installed") actions.push("install_chrome_after_user_approval");
  else if (chrome.compatibility === "too_old") actions.push("upgrade_chrome");
  if (profile.state === "not_found") actions.push("select_an_existing_profile");
  else if (profile.state === "metadata_unreadable") actions.push("check_profile_metadata_access");
  if (extension.state === "disabled") actions.push("ask_user_to_enable_extension");
  else if (extension.state === "missing_or_id_mismatch_possible") actions.push("verify_extension_id_or_load_extension_after_user_approval");
  else if (extension.state === "recorded_unknown") actions.push("check_extension_enabled_state_in_chrome");
  if (["missing", "invalid"].some((state) => [bridge.registration, bridge.host, bridge.launcher].includes(state))) {
    actions.push("repair_bridge_if_authorized");
  }
  if (bridge.node === "missing" || bridge.node === "invalid") actions.push("register_bridge_with_an_available_node");
  if (bridge.session === "missing" || bridge.session === "invalid") actions.push("repair_extension_pairing_after_user_approval");
  if (connection.state === "session_mismatch") actions.push("repair_bridge_session_mismatch");
  else if (["connection_failed", "disconnected", "timeout"].includes(connection.state)) actions.push("restore_connection_before_next_task");
  if (!actions.length && connection.state === "connected") actions.push("check_login_with_status");
  if (!actions.length) actions.push("inspect_chrome_extension_and_bridge_manually");
  return [...new Set(actions)];
}

export async function diagnoseEnvironment({ configuration, config, sessionId } = {}, {
  inspectChrome = inspectChromeInstallation,
  inspectRunning = inspectChromeRunning,
  inspectProfile = inspectChromeProfile,
  inspectBridge = inspectBridgeComponents,
  bridgeWait = waitForBridge,
} = {}) {
  let chromeInfo = { installation: "unknown", version: null, compatibility: "unknown" };
  let running = "unknown";
  try { chromeInfo = inspectChrome(); } catch { /* Keep unverified host details unknown. */ }
  try { running = inspectRunning(); } catch { /* Keep process state unknown. */ }
  let profile = { state: "not_configured", extension: "unknown" };
  let bridge = {};
  try { bridge = await inspectBridge(config); } catch { /* Keep unavailable bridge metadata unknown. */ }
  let connection = { state: "unknown" };
  if (config) {
    try {
      profile = await inspectProfile({
        profileDirectory: config.profileDirectory,
        userDataDir: config.chromeUserDataDir,
        extensionId: config.extensionId,
      });
    } catch {
      profile = { state: "unknown", extension: "unknown" };
    }
    if (SESSION_ID_PATTERN.test(sessionId ?? "")) {
      try {
        await bridgeWait(config, sessionId, { timeoutMs: 500 });
        connection = { state: "connected" };
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : "";
        connection = {
          state: code === "BRIDGE_SESSION_MISMATCH" ? "session_mismatch"
            : code === "BRIDGE_TIMEOUT" ? "timeout"
              : code === "BRIDGE_CONNECTION_FAILED" ? "connection_failed"
                : code === "BRIDGE_DISCONNECTED" ? "disconnected"
                  : "unknown",
        };
      }
    }
  }
  const safeBridge = {
    registration: bridge.registration ?? "unknown",
    host: bridge.host ?? "unknown",
    launcher: bridge.launcher ?? "unknown",
    node: bridge.node ?? "unknown",
    session: bridge.session ?? "unknown",
  };
  const result = {
    configuration: ["configured", "unconfigured", "invalid"].includes(configuration) ? configuration : "unknown",
    chrome: {
      installation: chromeInfo.installation,
      version: chromeInfo.version,
      compatibility: chromeInfo.compatibility,
      running,
    },
    profile: { state: profile.state ?? "unknown" },
    extension: { state: profile.extension ?? "unknown" },
    bridge: safeBridge,
    connection,
  };
  result.actions = nextActions({ ...result, configuration: result.configuration });
  return result;
}
