import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { BRIDGE_ERROR_MESSAGES, SESSION_ID_PATTERN } from "../../../src/native-messaging.mjs";
import { windowsPowerShellBuiltinModuleImport, windowsPowerShellPath } from "./windows-security.mjs";
import { BridgeError, waitForBridge } from "./bridge-client.mjs";
import { inspectBridgeComponents } from "./bridge-install.mjs";
import { MIN_NODE_VERSION, RUNTIME_PROTOCOL } from "./runtime-support.mjs";
import { defaultChromeUserDataDir, inspectChromeProfile, selectChromeProfile } from "./chrome-profile.mjs";

const CHROME_BUNDLE_ID = "com.google.Chrome";
const MINIMUM_CHROME_MAJOR = 116;
const WINDOWS_CHROME_VERSION_COMMAND = String.raw`$ErrorActionPreference='Stop'; $path=$env:WCV_CHROME_EXE; if(-not [System.IO.File]::Exists($path)){ exit 10 }; try { ${windowsPowerShellBuiltinModuleImport("Microsoft.PowerShell.Management")}; $version=(Get-Item -LiteralPath $path).VersionInfo.ProductVersion; if(-not $version){ exit 11 }; [Console]::Out.WriteLine($version); exit 0 } catch { exit 11 }`;

async function readPackagedRuntimeMetadata() {
  try {
    const metadata = JSON.parse(await readFile(new URL("../runtime.json", import.meta.url), "utf8"));
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
        Object.keys(metadata).length !== 3 ||
        typeof metadata.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(metadata.version) ||
        metadata.runtimeProtocol !== RUNTIME_PROTOCOL ||
        metadata.minimumNodeVersion !== MIN_NODE_VERSION) {
      throw new Error("Runtime metadata is incompatible.");
    }
    return {
      version: metadata.version,
      runtimeProtocol: metadata.runtimeProtocol,
      minimumNodeVersion: metadata.minimumNodeVersion,
    };
  } catch {
    return { version: "unknown", runtimeProtocol: "unknown", minimumNodeVersion: "unknown" };
  }
}

function command(commandPath, args, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(commandPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
    shell: false,
    windowsHide: true,
    env,
  });
  return result.error ? { error: result.error } : { status: result.status, stdout: result.stdout ?? "" };
}

function plistValue(path, key, commandRunner) {
  const result = commandRunner("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(path, "Contents/Info.plist")]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function inspectChromeInstallation({ platform = process.platform, home = homedir(), env = process.env, commandRunner, spawnSyncImpl = spawnSync } = {}) {
  const runCommand = commandRunner ?? ((path, args, options = {}) => command(path, args, { ...options, spawnSyncImpl }));
  if (platform === "win32") {
    let powershell;
    try { powershell = windowsPowerShellPath(env); }
    catch { return { installation: "unknown", version: null, compatibility: "unknown", appPath: null, executable: null }; }
    const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter((base) => typeof base === "string" && base)
      .map((base) => win32.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    let sawUnusableCandidate = false;
    for (const executable of new Set(candidates)) {
      const result = runCommand(powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CHROME_VERSION_COMMAND], {
        env: { ...env, WCV_CHROME_EXE: executable },
      });
      if (result.error) {
        sawUnusableCandidate = true;
        continue;
      }
      if (result.status === 10) continue;
      if (result.status !== 0) {
        sawUnusableCandidate = true;
        continue;
      }
      const version = result.stdout.trim();
      const major = /^\d+(?:\.\d+)*$/.test(version) ? Number(version.split(".")[0]) : null;
      return {
        installation: "installed",
        version: major === null ? null : version,
        compatibility: major === null ? "unknown" : major < MINIMUM_CHROME_MAJOR ? "too_old" : "supported",
        appPath: executable,
        executable,
      };
    }
    return {
      installation: sawUnusableCandidate ? "unknown" : candidates.length ? "not_installed" : "unknown",
      version: null,
      compatibility: "unknown",
      appPath: null,
      executable: null,
    };
  }
  if (platform !== "darwin") {
    return { installation: "unknown", version: null, compatibility: "unknown", appPath: null, executable: null };
  }
  const query = runCommand("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${CHROME_BUNDLE_ID}'`]);
  const querySucceeded = query.status === 0;
  const candidates = [
    "/Applications/Google Chrome.app",
    join(home, "Applications/Google Chrome.app"),
    ...(querySucceeded ? query.stdout.trim().split("\n").filter(Boolean) : []),
  ];
  let sawUnusableCandidate = Boolean(query.error);
  for (const appPath of new Set(candidates)) {
    const bundleId = plistValue(appPath, "CFBundleIdentifier", runCommand);
    if (bundleId !== CHROME_BUNDLE_ID) {
      if (bundleId !== null) continue;
      const info = runCommand("/usr/bin/test", ["-f", join(appPath, "Contents/Info.plist")]);
      if (info.status === 0 || info.error) sawUnusableCandidate = true;
      continue;
    }
    const version = plistValue(appPath, "CFBundleShortVersionString", runCommand);
    const major = /^\d+(?:\.\d+)*$/.test(version ?? "") ? Number(version.split(".")[0]) : null;
    const executableName = plistValue(appPath, "CFBundleExecutable", runCommand);
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
  if (platform === "win32") {
    const result = commandRunner("tasklist.exe", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"]);
    if (result.error || result.status !== 0) return "unknown";
    return /"chrome\.exe"/i.test(result.stdout) ? "running" : "not_running";
  }
  if (platform !== "darwin") return "unknown";
  const result = commandRunner("/usr/bin/pgrep", ["-x", "Google Chrome"]);
  if (result.status === 0) return "running";
  if (result.status === 1 && !result.error) return "not_running";
  return "unknown";
}

function launchDetached(executable, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    child.once("error", (error) => resolve({ error }));
    child.once("spawn", () => {
      child.unref();
      resolve({ status: 0 });
    });
  });
}

export async function launchChrome(config, sessionId, {
  platform = process.platform,
  inspectChrome = () => inspectChromeInstallation({ platform }),
  inspectProfile = selectChromeProfile,
  commandRunner = command,
  processLauncher = launchDetached,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new BridgeError("CHROME_UNAVAILABLE", BRIDGE_ERROR_MESSAGES.CHROME_UNAVAILABLE);
  }
  const chrome = inspectChrome();
  if (chrome.installation === "not_installed") {
    throw new BridgeError("CHROME_NOT_INSTALLED", "Google Chrome is not installed.");
  }
  if (chrome.installation !== "installed" || !(chrome.appPath || (platform === "win32" && chrome.executable))) {
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
  const args = platform === "win32"
    ? [`--user-data-dir=${config.chromeUserDataDir}`, `--profile-directory=${config.profileDirectory}`]
    : ["-g", "-n", "-a", chrome.appPath, "--args", `--user-data-dir=${config.chromeUserDataDir}`, `--profile-directory=${config.profileDirectory}`];
  if (sessionId) args.push(`chrome-extension://${config.extensionId}/index.html#agent-connect=${sessionId}`);
  const result = platform === "win32"
    ? await processLauncher(chrome.executable ?? chrome.appPath, args)
    : commandRunner("/usr/bin/open", args);
  if (result.status !== 0 || result.error) {
    throw new BridgeError("CHROME_START_FAILED", BRIDGE_ERROR_MESSAGES.CHROME_START_FAILED);
  }
}

function nextActions({ chrome, profile, extension, bridge, connection, configuration, candidateAction }) {
  const actions = [];
  if (chrome.installation === "not_installed") actions.push("install_chrome_after_user_approval");
  else if (chrome.compatibility === "too_old") actions.push("upgrade_chrome");
  else if (chrome.installation === "unknown") actions.push("verify_chrome_installation");
  if (["missing", "access_failed", "version_incompatible", "invalid"].includes(bridge.node)) {
    actions.push("register_bridge_with_a_supported_node");
  }
  if (candidateAction) actions.push(candidateAction);
  if (profile.state === "not_found") actions.push("select_an_existing_profile");
  else if (profile.state === "ambiguous") actions.push("choose_profile_directory");
  else if (profile.state === "metadata_unreadable") actions.push("check_profile_metadata_access");
  if (extension.state === "disabled") actions.push("ask_user_to_enable_extension");
  else if (extension.state === "missing_or_id_mismatch_possible") actions.push("verify_extension_id_or_load_extension_after_user_approval");
  else if (extension.state === "recorded_unknown") actions.push("check_extension_enabled_state_in_chrome");
  if (bridge.security === "invalid" || ["missing", "invalid"].some((state) => [bridge.registration, bridge.host, bridge.launcher].includes(state))) {
    actions.push("repair_bridge_if_authorized");
  }
  if (bridge.session === "missing" || bridge.session === "invalid") actions.push("repair_extension_pairing_after_user_approval");
  if (connection.state === "session_mismatch") actions.push("repair_bridge_session_mismatch");
  else if (["connection_failed", "disconnected", "timeout"].includes(connection.state)) actions.push("restore_connection_before_next_task");
  if (configuration !== "configured" && !actions.length) actions.push("configure_bridge_and_select_profile");
  if (!actions.length && connection.state === "connected") actions.push("check_login_with_status");
  if (!actions.length) actions.push("inspect_chrome_extension_and_bridge_manually");
  return [...new Set(actions)];
}

function candidateNextAction(chrome, profileState, extensionState) {
  if (chrome.installation === "not_installed") return "install_chrome_after_user_approval";
  if (chrome.compatibility === "too_old") return "upgrade_chrome";
  if (chrome.installation === "unknown") return "verify_chrome_installation";
  if (profileState === "not_found") return "select_an_existing_profile";
  if (profileState === "ambiguous") return "choose_profile_directory";
  if (profileState !== "exists") return "check_profile_metadata_access";
  if (extensionState === "enabled") return "install_bridge_with_selected_profile";
  if (extensionState === "disabled") return "enable_extension_in_chrome";
  if (extensionState === "missing_or_id_mismatch_possible") return "verify_extension_id_or_load_extension";
  if (extensionState === "recorded_unknown") return "check_extension_enabled_state_in_chrome";
  return "resolve_extension_state_in_chrome";
}

async function inspectCandidate({ profile, extensionId }, {
  chrome,
  platform,
  env,
  home,
  chromeUserDataDir,
  selectCandidateProfile,
  inspectProfile,
}) {
  let userDataDir;
  try { userDataDir = chromeUserDataDir ?? defaultChromeUserDataDir({ platform, env, home }); }
  catch {
    return {
      checkScope: "chrome_profile_metadata",
      status: "unverified",
      reason: "chrome_profile_root_unavailable",
      profile: { state: "unknown" },
      extension: { state: "unknown" },
      liveHandshake: "not_checked",
      nextAction: candidateNextAction(chrome, "unknown", "unknown"),
    };
  }

  let selected;
  try { selected = await selectCandidateProfile(profile, userDataDir); }
  catch (error) {
    const profileState = error.message.includes("ambiguous") ? "ambiguous"
      : error.message.includes("not found") ? "not_found"
        : "metadata_unreadable";
    return {
      checkScope: "chrome_profile_metadata",
      status: "unverified",
      reason: `profile_${profileState}`,
      profile: { state: profileState },
      extension: { state: "unknown" },
      liveHandshake: "not_checked",
      nextAction: candidateNextAction(chrome, profileState, "unknown"),
    };
  }

  let state;
  try {
    state = await inspectProfile({
      profileDirectory: selected.directory,
      userDataDir,
      extensionId,
    });
  } catch {
    state = { state: "unknown", extension: "unknown" };
  }
  const profileState = state.state ?? "unknown";
  const extensionState = state.extension ?? "unknown";
  const status = profileState !== "exists" ? "unverified"
    : extensionState === "enabled" ? "recorded_enabled"
      : extensionState === "disabled" ? "recorded_disabled"
        : "unverified";
  return {
    checkScope: "chrome_profile_metadata",
    status,
    reason: profileState === "exists" ? `extension_${extensionState}` : `profile_${profileState}`,
    profile: { state: profileState },
    extension: { state: extensionState },
    liveHandshake: "not_checked",
    nextAction: candidateNextAction(chrome, profileState, extensionState),
  };
}

export async function diagnoseEnvironment({ configuration, config, sessionId, sessionInfo, candidate } = {}, {
  platform = process.platform,
  env = process.env,
  home = homedir(),
  chromeUserDataDir,
  inspectChrome = () => inspectChromeInstallation({ platform, env, home }),
  inspectRunning = () => inspectChromeRunning({ platform }),
  inspectProfile = inspectChromeProfile,
  selectCandidateProfile = selectChromeProfile,
  inspectBridge = inspectBridgeComponents,
  bridgeWait = waitForBridge,
  includeRuntime = false,
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
    const bridgeSession = sessionInfo ?? sessionId;
    if (bridgeSession?.ipcProtocol === 1) {
      connection = { state: "session_mismatch" };
    } else if (SESSION_ID_PATTERN.test(bridgeSession?.sessionId ?? bridgeSession ?? "")) {
      try {
        await bridgeWait(config, bridgeSession, { timeoutMs: 500 });
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
    nodeVersion: bridge.nodeVersion ?? null,
    session: bridge.session ?? "unknown",
    security: bridge.security ?? "unknown",
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
  if (candidate) {
    result.candidate = await inspectCandidate(candidate, {
      platform,
      chrome: chromeInfo,
      env,
      home,
      chromeUserDataDir,
      selectCandidateProfile,
      inspectProfile,
    });
  }
  if (includeRuntime) {
    result.runtime = await readPackagedRuntimeMetadata();
    result.currentNode = {
      version: process.versions.node,
      absolutePath: isAbsolute(process.execPath) ? process.execPath : "unknown",
    };
  }
  result.actions = nextActions({
    ...result,
    configuration: result.configuration,
    candidateAction: result.candidate?.nextAction,
  });
  result.nextAction = result.actions[0];
  return result;
}
