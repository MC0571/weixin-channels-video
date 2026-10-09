import { access, chmod, constants, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { listChromeProfiles, selectChromeProfile, defaultChromeUserDataDir } from "./chrome-profile.mjs";
import { NATIVE_HOST_NAME, SESSION_ID_PATTERN } from "../../../src/native-messaging.mjs";

const HOST_DESCRIPTION = "Local bridge for the Weixin Channels Video Chrome extension.";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export class BridgeSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeSetupError";
    this.code = code;
  }
}

function profileError(error) {
  if (error.message.includes("ambiguous")) return new BridgeSetupError("PROFILE_AMBIGUOUS", "该 Chrome profile 名称有重名，请改用目录名。");
  if (error.message.includes("--profile")) return new BridgeSetupError("PROFILE_REQUIRED", "请先运行 list-profiles，再使用 --profile 选择 Chrome profile。");
  if (error.message.includes("not found")) return new BridgeSetupError("PROFILE_NOT_FOUND", "找不到指定的 Chrome profile。");
  return new BridgeSetupError("CHROME_PROFILE_UNAVAILABLE", "无法读取 Chrome profile 列表或元数据。");
}

function packageScriptsDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function defaultAppSupportDir() {
  if (process.platform !== "darwin") throw new Error("The Native Messaging bridge currently supports macOS only.");
  return join(homedir(), "Library", "Application Support", "weixin-channels-video");
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Bridge directory is unsafe.");
  await chmod(path, 0o700);
}

async function inspectExisting(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Existing bridge registration is not a regular file.");
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path, content, mode, { replace = false } = {}) {
  const existing = await inspectExisting(path);
  if (existing !== undefined && !replace) throw new Error("Refusing to replace an existing bridge file.");
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode, flag: "wx" });
    await chmod(tempPath, mode);
    await rename(tempPath, path);
    await chmod(path, mode);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readShellWord(text, offset) {
  if (text[offset] !== "'") return null;
  let value = "";
  for (let index = offset + 1; index < text.length;) {
    if (text.startsWith("'\\''", index)) {
      value += "'";
      index += 4;
    } else if (text[index] === "'") {
      return { value, next: index + 1 };
    } else {
      value += text[index];
      index += 1;
    }
  }
  return null;
}

function launcherNodeExecutable(text, hostPath, configPath) {
  const prefix = "#!/bin/sh\nexec ";
  if (!text.startsWith(prefix)) return null;
  const node = readShellWord(text, prefix.length);
  if (!node || text.slice(node.next) !== ` ${shellQuote(hostPath)} ${shellQuote(configPath)} "$@"\n`) return null;
  return node.value;
}

function readJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} is invalid.`); }
}

function isBridgeSession(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 && value.version === 1 && SESSION_ID_PATTERN.test(value.sessionId);
}

function isOwnedManifest(value, launcherPath) {
  const allowedOrigin = value?.allowed_origins?.[0];
  if (typeof allowedOrigin !== "string") return false;
  const extensionId = allowedOrigin.startsWith("chrome-extension://")
    ? allowedOrigin.slice("chrome-extension://".length, -1)
    : "";
  return value?.name === NATIVE_HOST_NAME &&
    value.description === HOST_DESCRIPTION &&
    value.type === "stdio" &&
    value.path === launcherPath &&
    Array.isArray(value.allowed_origins) &&
    value.allowed_origins.length === 1 &&
    EXTENSION_ID_PATTERN.test(extensionId) &&
    allowedOrigin === `chrome-extension://${extensionId}/`;
}

function isOwnedConfig(value, root) {
  return value?.version === 1 &&
    value.hostName === NATIVE_HOST_NAME &&
    EXTENSION_ID_PATTERN.test(value.extensionId) &&
    resolve(value.appSupportDir ?? "") === root &&
    typeof value.profileDirectory === "string" &&
    value.profileDirectory.length > 0 &&
    !value.profileDirectory.includes("/") &&
    !value.profileDirectory.includes("\\");
}

export async function listBridgeProfiles(chromeUserDataDir) {
  try { return await listChromeProfiles(chromeUserDataDir); }
  catch (error) { throw profileError(error); }
}

export async function installBridge({
  extensionId,
  profile,
  appSupportDir = defaultAppSupportDir(),
  chromeUserDataDir = defaultChromeUserDataDir(),
  registryDir = join(chromeUserDataDir, "NativeMessagingHosts"),
  nodeExecutable = process.execPath,
  nativeHostSource = join(packageScriptsDir(), "native-host.mjs"),
} = {}) {
  if (typeof extensionId !== "string" || !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new BridgeSetupError("INVALID_EXTENSION_ID", "扩展 ID 必须是由 a 到 p 组成的 32 个字符。");
  }
  if (typeof nodeExecutable !== "string" || !nodeExecutable.startsWith("/")) {
    throw new Error("An absolute Node.js executable path is required.");
  }
  let selectedProfile;
  try { selectedProfile = await selectChromeProfile(profile, chromeUserDataDir); }
  catch (error) { throw profileError(error); }
  const root = resolve(appSupportDir);
  const registrationDir = resolve(registryDir);
  const hostPath = join(root, "native-host.mjs");
  const configPath = join(root, "bridge.json");
  const sessionPath = join(root, "session.json");
  const launcherPath = join(root, "native-host-launcher");
  const manifestPath = join(registrationDir, `${NATIVE_HOST_NAME}.json`);

  const existingManifestText = await inspectExisting(manifestPath);
  let ownsManifest = false;
  if (existingManifestText !== undefined) {
    const existingManifest = readJson(existingManifestText, "Existing Native Messaging registration");
    if (!isOwnedManifest(existingManifest, launcherPath)) {
      throw new BridgeSetupError("HOST_REGISTRATION_CONFLICT", "检测到同名但不属于本工具的 Native Messaging 注册，已保留原文件。");
    }
    ownsManifest = true;
  }
  const existingConfig = await inspectExisting(configPath);
  let ownsConfig = false;
  let existingConfigValue;
  if (existingConfig !== undefined) {
    const value = readJson(existingConfig, "Existing bridge configuration");
    if (!isOwnedConfig(value, root)) {
      throw new BridgeSetupError("BRIDGE_FILE_CONFLICT", "检测到不属于本工具的本地连接配置，已保留原文件。");
    }
    ownsConfig = true;
    existingConfigValue = value;
  }
  const existingHost = await inspectExisting(hostPath);
  const existingLauncher = await inspectExisting(launcherPath);
  if ((existingHost !== undefined || existingLauncher !== undefined) && !ownsConfig && !ownsManifest) {
    throw new BridgeSetupError("BRIDGE_FILE_CONFLICT", "检测到不属于本工具的本地桥接文件，已保留原文件。");
  }
  const existingSession = await inspectExisting(sessionPath);
  if (existingSession !== undefined && !ownsConfig && !ownsManifest) {
    throw new BridgeSetupError("BRIDGE_FILE_CONFLICT", "检测到不属于本工具的本地连接会话，已保留原文件。");
  }
  let registryInfo;
  try { registryInfo = await lstat(registrationDir); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (registryInfo && (!registryInfo.isDirectory() || registryInfo.isSymbolicLink())) {
    throw new Error("Chrome Native Messaging registration directory is unsafe.");
  }
  const sourceInfo = await lstat(nativeHostSource);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Packaged Native Messaging host is unavailable.");
  const nativeHostBundle = await readFile(nativeHostSource);
  const socketProbe = join(root, "s-0123456789abcdef.sock");
  if (Buffer.byteLength(socketProbe, "utf8") > 103) throw new Error("The private bridge path is too long for a macOS socket.");

  const config = {
    version: 1,
    hostName: NATIVE_HOST_NAME,
    extensionId,
    profileDirectory: selectedProfile.directory,
    profileName: selectedProfile.name,
    chromeUserDataDir: resolve(chromeUserDataDir),
    appSupportDir: root,
    configPath,
    sessionPath,
  };
  const sameConfiguration = ownsConfig &&
    existingConfigValue.extensionId === config.extensionId &&
    existingConfigValue.profileDirectory === config.profileDirectory &&
    resolve(existingConfigValue.chromeUserDataDir ?? "") === config.chromeUserDataDir;
  let sessionId;
  if (sameConfiguration && existingSession !== undefined) {
    try {
      const previousSession = JSON.parse(existingSession);
      if (isBridgeSession(previousSession)) {
        sessionId = previousSession.sessionId;
      }
    } catch { /* Replace invalid owned session state with a fresh identifier. */ }
  }
  sessionId ??= randomUUID();
  const hostManifest = {
    name: NATIVE_HOST_NAME,
    description: HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const launcher = `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(hostPath)} ${shellQuote(configPath)} "$@"\n`;

  await ensurePrivateDirectory(root);
  await mkdir(registrationDir, { recursive: true, mode: 0o700 });
  await atomicWrite(hostPath, nativeHostBundle, 0o600, { replace: true });
  await atomicWrite(launcherPath, launcher, 0o700, { replace: true });
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600, { replace: true });
  await atomicWrite(sessionPath, `${JSON.stringify({ version: 1, sessionId })}\n`, 0o600, { replace: existingSession !== undefined });
  await atomicWrite(manifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`, 0o600, { replace: existingManifestText !== undefined });

  return { config, hostManifestPath: manifestPath, launcherPath, profile: selectedProfile };
}

export async function readBridgeInstallation({ appSupportDir = defaultAppSupportDir() } = {}) {
  const configPath = join(resolve(appSupportDir), "bridge.json");
  let value;
  try { value = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new BridgeSetupError("BRIDGE_CONFIG_INVALID", "本地连接配置无效，请重新运行 install-bridge。");
  }
  if (
    value?.version !== 1 ||
    value.hostName !== NATIVE_HOST_NAME ||
    !EXTENSION_ID_PATTERN.test(value.extensionId) ||
    typeof value.profileDirectory !== "string" ||
    !value.profileDirectory ||
    value.profileDirectory.includes("/") ||
    value.profileDirectory.includes("\\") ||
    resolve(value.appSupportDir) !== resolve(appSupportDir)
  ) throw new BridgeSetupError("BRIDGE_CONFIG_INVALID", "本地连接配置无效，请重新运行 install-bridge。");
  return value;
}

async function fileStatus(path, { allowSymlink = false, executable = false } = {}) {
  try {
    const info = allowSymlink ? await stat(path) : await lstat(path);
    if (!info.isFile() || (!allowSymlink && info.isSymbolicLink())) return { state: "invalid" };
    if (executable) {
      try { await access(path, constants.X_OK); }
      catch { return { state: "invalid" }; }
    }
    return { state: "present", size: info.size };
  } catch (error) {
    return { state: error.code === "ENOENT" ? "missing" : "unknown" };
  }
}

export async function inspectBridgeComponents(config, {
  registryDir = config?.chromeUserDataDir
    ? join(config.chromeUserDataDir, "NativeMessagingHosts")
    : join(defaultChromeUserDataDir(), "NativeMessagingHosts"),
} = {}) {
  if (!config) {
    return {
      registration: "unknown",
      host: "unknown",
      launcher: "unknown",
      node: "unknown",
      session: "unknown",
    };
  }
  const hostPath = join(config.appSupportDir, "native-host.mjs");
  const configPath = join(config.appSupportDir, "bridge.json");
  const launcherPath = join(config.appSupportDir, "native-host-launcher");
  const manifestPath = join(registryDir, `${NATIVE_HOST_NAME}.json`);
  const hostFile = await fileStatus(hostPath);
  const launcherFile = await fileStatus(launcherPath, { executable: true });
  const host = hostFile.state === "present"
    ? hostFile.size > 0 ? "present" : "invalid"
    : hostFile.state;
  let launcher = launcherFile.state === "present" ? "valid" : launcherFile.state;
  let node = "unknown";
  if (launcherFile.state === "present") {
    try {
      const text = await readFile(launcherPath, "utf8");
      const nodePath = launcherNodeExecutable(text, hostPath, configPath);
      if (!nodePath || !nodePath.startsWith("/")) {
        launcher = "invalid";
      } else {
        const nodeFile = await fileStatus(nodePath, { allowSymlink: true, executable: true });
        node = nodeFile.state === "present" ? "available" : nodeFile.state;
        if (node === "missing" || node === "invalid") launcher = "invalid";
        else if (node === "unknown") launcher = "unknown";
      }
    } catch (error) {
      launcher = error.code === "ENOENT" ? "missing" : "unknown";
    }
  }

  let registration = "unknown";
  try {
    const text = await inspectExisting(manifestPath);
    if (text === undefined) registration = "missing";
    else {
      const manifest = readJson(text, "Native Messaging registration");
      registration = isOwnedManifest(manifest, launcherPath) &&
        manifest.allowed_origins[0] === `chrome-extension://${config.extensionId}/`
        ? "valid"
        : "invalid";
    }
  } catch (error) {
    registration = error.code === "ENOENT" ? "missing" : error.code ? "unknown" : "invalid";
  }

  let session = "unknown";
  try {
    const value = JSON.parse(await readFile(join(config.appSupportDir, "session.json"), "utf8"));
    session = isBridgeSession(value) ? "available" : "invalid";
  } catch (error) {
    session = error.code === "ENOENT" ? "missing" : error.code ? "unknown" : "invalid";
  }
  return { registration, host, launcher, node, session };
}

export function bridgeSocketPath(config, sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Bridge session is invalid.");
  return join(config.appSupportDir, `s-${sessionId.replaceAll("-", "").slice(0, 16)}.sock`);
}

export async function readBridgeSession(config) {
  try {
    const session = JSON.parse(await readFile(join(config.appSupportDir, "session.json"), "utf8"));
    if (!isBridgeSession(session)) return null;
    return session.sessionId;
  } catch {
    return null;
  }
}
