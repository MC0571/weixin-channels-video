import { access, chmod, constants, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { listChromeProfiles, selectChromeProfile, defaultChromeUserDataDir } from "./chrome-profile.mjs";
import { assertWindowsPrivatePath, inspectWindowsPathSecurity, secureWindowsPath, windowsPowerShellBuiltinModuleImport, windowsPowerShellPath, WINDOWS_PRIVATE_PATH_ASSERTION } from "./windows-security.mjs";
import { supportsNodeVersion } from "./runtime-support.mjs";
import { NATIVE_HOST_NAME, SESSION_ID_PATTERN } from "../../../src/native-messaging.mjs";
import { windowsPipeName } from "../../../src/native-ipc.mjs";

const HOST_DESCRIPTION = "Local bridge for the Weixin Channels Video Chrome extension.";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const IPC_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const REGISTRY_KEY = `Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
const WINDOWS_UTILITY_MODULE_IMPORT = windowsPowerShellBuiltinModuleImport("Microsoft.PowerShell.Utility");
const WINDOWS_REGISTRY_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$keyName = $env:WCV_REGISTRY_KEY
$mode = $env:WCV_REGISTRY_MODE
$manifestPath = $env:WCV_REGISTRY_MANIFEST
if ([Environment]::Is64BitOperatingSystem) {
  $views = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)
} else {
  $views = @([Microsoft.Win32.RegistryView]::Registry32)
}
function Read-WcvRegistration($view, $keyName) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try {
    $key = $base.OpenSubKey($keyName, $false)
    if ($null -eq $key) { return $null }
    try { return $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Close() }
  } finally { $base.Close() }
}
function Set-WcvRegistration($view, $keyName, $value) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try {
    $key = $base.CreateSubKey($keyName, $true)
    if ($null -eq $key) { throw 'REGISTRY_CREATE_FAILED' }
    try { $key.SetValue('', $value, [Microsoft.Win32.RegistryValueKind]::String); $key.Flush() }
    finally { $key.Close() }
  } finally { $base.Close() }
}
function Remove-WcvRegistration($view, $keyName) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try {
    $key = $base.OpenSubKey($keyName, $true)
    if ($null -eq $key) { return }
    try { $key.DeleteValue('', $false); $key.Flush() }
    finally { $key.Close() }
  } finally { $base.Close() }
}
try {
  ${WINDOWS_UTILITY_MODULE_IMPORT}
  if ($mode -eq 'read') {
    $values = @($views | ForEach-Object { Read-WcvRegistration $_ $keyName })
    $present = @($values | Where-Object { $null -ne $_ })
    if ($present.Count -eq 0) { exit 10 }
    foreach ($value in $present) { if (-not [string]::Equals([string]$value, [string]$present[0], [StringComparison]::OrdinalIgnoreCase)) { exit 13 } }
    [Console]::Out.WriteLine([string]$present[0])
    if ($present.Count -ne $views.Count) { exit 17 }
    exit 0
  }
  if ($mode -eq 'delete') {
    $values = @($views | ForEach-Object { Read-WcvRegistration $_ $keyName })
    foreach ($current in $values) { if ($null -ne $current -and -not [string]::Equals([string]$current, $manifestPath, [StringComparison]::OrdinalIgnoreCase)) { exit 13 } }
    foreach ($view in $views) { Remove-WcvRegistration $view $keyName }
    exit 0
  }
  $previous = @($views | ForEach-Object { [PSCustomObject]@{ view = $_; value = (Read-WcvRegistration $_ $keyName) } })
  foreach ($entry in $previous) { if ($null -ne $entry.value -and -not [string]::Equals([string]$entry.value, $manifestPath, [StringComparison]::OrdinalIgnoreCase)) { exit 13 } }
  try {
    foreach ($view in $views) { Set-WcvRegistration $view $keyName $manifestPath }
    foreach ($view in $views) { if (-not [string]::Equals([string](Read-WcvRegistration $view $keyName), $manifestPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'REGISTRY_READBACK_FAILED' } }
    exit 0
  } catch {
    foreach ($entry in $previous) {
      if ($null -eq $entry.value) { Remove-WcvRegistration $entry.view $keyName }
      else { Set-WcvRegistration $entry.view $keyName $entry.value }
    }
    exit 15
  }
} catch { exit 15 }
`;
const WINDOWS_SHORT_PATH_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
try {
  ${WINDOWS_UTILITY_MODULE_IMPORT}
  $fso = New-Object -ComObject Scripting.FileSystemObject
  $path = $env:WCV_SHORT_PATH
  if ([System.IO.Directory]::Exists($path)) {
    $short = $fso.GetFolder($path).ShortPath
    $same = $fso.GetFolder($short).ShortPath
  } else {
    $short = $fso.GetFile($path).ShortPath
    $same = $fso.GetFile($short).ShortPath
  }
  if (-not $short -or $same -ne $short) { exit 20 }
  [Console]::Out.WriteLine($short)
  exit 0
} catch { exit 21 }
`;
const WINDOWS_LAUNCHER_COMMAND = String.raw`$ErrorActionPreference='Stop'; ${windowsPowerShellBuiltinModuleImport("Microsoft.PowerShell.Security")}; ${windowsPowerShellBuiltinModuleImport("Microsoft.PowerShell.Management")}; ${WINDOWS_UTILITY_MODULE_IMPORT}; ${WINDOWS_PRIVATE_PATH_ASSERTION.replaceAll(/\s+/g, " ")}; $manifestPath=$env:WCV_MANIFEST_PATH; $launcherPath=$env:WCV_LAUNCHER_PATH; $manifestRoot=[System.IO.Path]::GetDirectoryName($manifestPath); Assert-WcvPrivatePath $manifestRoot 'directory'; Assert-WcvPrivatePath $manifestPath 'file'; Assert-WcvPrivatePath $launcherPath 'file'; $manifest=Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json; $configPath=Join-Path $manifestRoot 'bridge.json'; Assert-WcvPrivatePath $configPath 'file'; $config=Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json; $root=$config.appSupportDir; if($config.version -ne 1 -or $config.hostName -ne '${NATIVE_HOST_NAME}' -or $config.platform -ne 'win32' -or $config.ipcProtocol -ne 2 -or $config.extensionId -notmatch '^[a-p]{32}$' -or $root -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)'){ exit 1 }; $expectedRoot=[System.IO.Path]::GetFullPath($root); $actualRoot=[System.IO.Path]::GetFullPath($manifestRoot); $sameRoot=[string]::Equals($expectedRoot,$actualRoot,[StringComparison]::OrdinalIgnoreCase); if(-not $sameRoot){ $fso=New-Object -ComObject Scripting.FileSystemObject; $sameRoot=[string]::Equals($fso.GetFolder($root).ShortPath,$fso.GetFolder($manifestRoot).ShortPath,[StringComparison]::OrdinalIgnoreCase) }; if(-not $sameRoot){ exit 1 }; $expectedConfig=[System.IO.Path]::GetFullPath((Join-Path $root 'bridge.json')); $actualConfig=[System.IO.Path]::GetFullPath($config.configPath); $sameConfig=[string]::Equals($actualConfig,$expectedConfig,[StringComparison]::OrdinalIgnoreCase); if(-not $sameConfig){ $fso=New-Object -ComObject Scripting.FileSystemObject; $sameConfig=[string]::Equals($fso.GetFile($actualConfig).ShortPath,$fso.GetFile($expectedConfig).ShortPath,[StringComparison]::OrdinalIgnoreCase) }; if(-not $sameConfig){ exit 1 }; $manifestLauncher=[System.IO.Path]::GetFullPath($manifest.path); $currentLauncher=[System.IO.Path]::GetFullPath($launcherPath); $sameLauncher=[string]::Equals($manifestLauncher,$currentLauncher,[StringComparison]::OrdinalIgnoreCase); if(-not $sameLauncher){ $fso=New-Object -ComObject Scripting.FileSystemObject; $sameLauncher=[string]::Equals($fso.GetFile($manifestLauncher).ShortPath,$fso.GetFile($currentLauncher).ShortPath,[StringComparison]::OrdinalIgnoreCase) }; $origin=$env:WCV_ORIGIN; if(-not $sameLauncher -or $manifest.allowed_origins.Count -ne 1 -or $manifest.allowed_origins[0] -ne $origin -or $origin -ne ('chrome-extension://'+$config.extensionId+'/') -or $origin -notmatch '^chrome-extension://[a-p]{32}/$'){ exit 1 }; Assert-WcvPrivatePath $root 'directory'; $hostPath=Join-Path $root 'native-host.mjs'; $sessionPath=Join-Path $root 'session.json'; Assert-WcvPrivatePath $hostPath 'file'; Assert-WcvPrivatePath $sessionPath 'file'; $nodePath=$config.nodeExecutable; if($nodePath -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+).+\.exe$'){ exit 1 }; $parentArg=$env:WCV_PARENT_WINDOW; $parentValue=$env:WCV_PARENT_WINDOW_VALUE; if([string]::IsNullOrEmpty($parentArg) -and [string]::IsNullOrEmpty($parentValue)){ $parent='0' } elseif($parentArg -match '^--parent-window=(\d+)$' -and [string]::IsNullOrEmpty($parentValue)){ $parent=$Matches[1] } elseif($parentArg -eq '--parent-window' -and $parentValue -match '^\d+$'){ $parent=$parentValue } else { exit 1 }; $quote=[char]34; $process=New-Object System.Diagnostics.ProcessStartInfo; $process.FileName=$nodePath; $process.Arguments=$quote+$hostPath+$quote+' '+$quote+$config.configPath+$quote+' '+$origin+' --parent-window='+$parent; $process.UseShellExecute=$false; $process.CreateNoWindow=$true; $child=New-Object System.Diagnostics.Process; $child.StartInfo=$process; if(-not $child.Start()){ exit 1 }; $child.WaitForExit(); exit $child.ExitCode`;

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

function defaultAppSupportDir({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("Local bridge storage is unavailable.");
    return win32.join(env.LOCALAPPDATA, "weixin-channels-video");
  }
  if (platform !== "darwin") throw new Error("The Native Messaging bridge supports macOS and Windows only.");
  return join(home, "Library", "Application Support", "weixin-channels-video");
}

async function ensurePrivateDirectory(path, platform = process.platform, securityOptions = {}) {
  const createdPath = await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Bridge directory is unsafe.");
  if (platform === "win32") await secureWindowsPath(path, {
    ...securityOptions,
    directory: true,
    newlyCreated: createdPath !== undefined,
  });
  else await chmod(path, 0o700);
}

async function inspectExisting(path, { platform = process.platform, securityOptions = {} } = {}) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Existing bridge registration is not a regular file.");
    if (platform === "win32") await assertWindowsPrivatePath(path, securityOptions);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path, content, mode, { replace = false, platform = process.platform, securityOptions = {} } = {}) {
  const existing = await inspectExisting(path);
  if (existing !== undefined && !replace) throw new Error("Refusing to replace an existing bridge file.");
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode, flag: "wx" });
    if (platform === "win32") await secureWindowsPath(tempPath, { ...securityOptions, newlyCreated: true });
    else await chmod(tempPath, mode);
    await rename(tempPath, path);
    if (platform === "win32") await secureWindowsPath(path, securityOptions);
    else await chmod(path, mode);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function installWindowsBundle(entries, securityOptions, register) {
  const transaction = entries.map((entry) => ({
    ...entry,
    stagePath: `${entry.path}.${randomUUID()}.stage`,
    backupPath: undefined,
    installed: false,
  }));
  try {
    for (const entry of transaction) {
      await writeFile(entry.stagePath, entry.content, { encoding: "utf8", mode: entry.mode, flag: "wx" });
      await secureWindowsPath(entry.stagePath, { ...securityOptions, newlyCreated: true });
    }
    for (const entry of transaction) {
      let existing;
      try { existing = await lstat(entry.path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing) {
        if (!entry.replace || !existing.isFile() || existing.isSymbolicLink()) {
          throw new Error("Refusing to replace an unowned bridge file.");
        }
        entry.backupPath = `${entry.path}.${randomUUID()}.backup`;
        await rename(entry.path, entry.backupPath);
      }
      await rename(entry.stagePath, entry.path);
      entry.installed = true;
      await secureWindowsPath(entry.path, securityOptions);
    }
    await register();
  } catch (error) {
    const recoveryErrors = [];
    for (const entry of [...transaction].reverse()) {
      try {
        if (entry.installed) await rm(entry.path, { force: true });
        if (entry.backupPath) await rename(entry.backupPath, entry.path);
      } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    await Promise.all(transaction.map((entry) => rm(entry.stagePath, { force: true })));
    if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], "Windows bridge installation rollback failed.");
    throw error;
  }
  await Promise.all(transaction.flatMap((entry) => [
    rm(entry.stagePath, { force: true }),
    entry.backupPath ? rm(entry.backupPath, { force: true }) : Promise.resolve(),
  ]));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runWindowsPowerShell(commandText, {
  env = process.env,
  spawnSyncImpl = spawnSync,
  variables = {},
} = {}) {
  return spawnSyncImpl(windowsPowerShellPath(env), [
    "-NoProfile", "-NonInteractive", "-Command", commandText,
  ], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    shell: false,
    env: { ...env, ...variables },
  });
}

async function resolveWindowsShortPath(path, options) {
  const result = runWindowsPowerShell(WINDOWS_SHORT_PATH_COMMAND, {
    ...options,
    variables: { WCV_SHORT_PATH: path },
  });
  const shortPath = result.error || result.status !== 0 ? "" : result.stdout.trim();
  if (!/^[A-Za-z0-9 _:\\.~+-]+$/.test(shortPath)) {
    throw new BridgeSetupError("UNSAFE_LAUNCHER_PATH", "Windows 无法为本地桥接路径提供安全的短路径名。");
  }
  return shortPath;
}

const WINDOWS_UNSAFE_LAUNCHER_PATH = /[%!&^()|<>]/;

async function windowsLauncherEntryPath(launcherPath, root, shortPathResolver) {
  if (!WINDOWS_UNSAFE_LAUNCHER_PATH.test(launcherPath)) return launcherPath;
  let shortRoot;
  try { shortRoot = await shortPathResolver(root); }
  catch (error) {
    if (error instanceof BridgeSetupError && error.code === "UNSAFE_LAUNCHER_PATH") throw error;
    throw new BridgeSetupError("UNSAFE_LAUNCHER_PATH", "Windows 无法为本地桥接启动器提供安全的短路径名。");
  }
  const registeredPath = win32.join(shortRoot, win32.basename(launcherPath));
  if (WINDOWS_UNSAFE_LAUNCHER_PATH.test(registeredPath) || !/^[A-Za-z0-9 _:\\.~+-]+$/.test(registeredPath)) {
    throw new BridgeSetupError("UNSAFE_LAUNCHER_PATH", "Windows 无法为本地桥接启动器提供安全的短路径名。");
  }
  return registeredPath;
}

function windowsLauncher() {
  const launcher = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `set "WCV_MANIFEST_PATH=%~dp0${NATIVE_HOST_NAME}.json"`,
    `set "WCV_LAUNCHER_PATH=%~f0"`,
    "set " + String.raw`"WCV_ORIGIN=%~1"`,
    "set " + String.raw`"WCV_PARENT_WINDOW=%~2"`,
    "set " + String.raw`"WCV_PARENT_WINDOW_VALUE=%~3"`,
    String.raw`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "${WINDOWS_LAUNCHER_COMMAND}"`,
    "",
  ].join("\r\n");
  if (!/^[\x00-\x7f]*$/.test(launcher)) {
    throw new BridgeSetupError("UNSAFE_LAUNCHER_PATH", "Windows 本地桥接启动器必须只包含 ASCII 字符。");
  }
  return launcher;
}

function createWindowsRegistry({ env, spawnSyncImpl } = {}) {
  const inspect = async (keyName) => {
    const result = runWindowsPowerShell(WINDOWS_REGISTRY_COMMAND, {
      env,
      spawnSyncImpl,
      variables: { WCV_REGISTRY_KEY: keyName, WCV_REGISTRY_MODE: "read", WCV_REGISTRY_MANIFEST: "" },
    });
    if (result.error) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
    if (result.status === 10) return { state: "missing", path: null };
    if (result.status === 13 || result.status === 16) return { state: "conflict", path: null };
    if (result.status === 17) return { state: "partial", path: result.stdout.trim() };
    if (result.status !== 0) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
    return { state: "valid", path: result.stdout.trim() };
  };
  return {
    inspect,
    async read(keyName) {
      const result = await inspect(keyName);
      if (result.state === "conflict") throw new BridgeSetupError("HOST_REGISTRATION_CONFLICT", "Windows 32 位与 64 位 Native Messaging 注册不一致，已保留原注册。");
      return result.path;
    },
    async write(keyName, manifestPath) {
      const result = runWindowsPowerShell(WINDOWS_REGISTRY_COMMAND, {
        env,
        spawnSyncImpl,
        variables: { WCV_REGISTRY_KEY: keyName, WCV_REGISTRY_MODE: "write", WCV_REGISTRY_MANIFEST: manifestPath },
      });
      if (result.error || result.status === 12 || result.status === 15) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
      if (result.status === 13) throw new BridgeSetupError("HOST_REGISTRATION_CONFLICT", "检测到同名但不属于本工具的 Native Messaging 注册，已保留原注册。");
      if (result.status !== 0) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
    },
    async remove(keyName, expectedManifestPath) {
      const result = runWindowsPowerShell(WINDOWS_REGISTRY_COMMAND, {
        env,
        spawnSyncImpl,
        variables: { WCV_REGISTRY_KEY: keyName, WCV_REGISTRY_MODE: "delete", WCV_REGISTRY_MANIFEST: expectedManifestPath },
      });
      if (result.error) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
      if (result.status === 13 || result.status === 16) throw new BridgeSetupError("HOST_REGISTRATION_CONFLICT", "注册信息已被其他程序更改或视图不一致，未删除该注册。");
      if (result.status !== 0) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
    },
  };
}

function sameWindowsPath(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

async function assertWindowsRegistration(registry, manifestPath) {
  const registeredPath = await registry.read(REGISTRY_KEY);
  if (registeredPath !== null && !sameWindowsPath(registeredPath, manifestPath)) {
    throw new BridgeSetupError("HOST_REGISTRATION_CONFLICT", "检测到同名但不属于本工具的 Native Messaging 注册，已保留原注册。");
  }
  return registeredPath;
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
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.version !== 1 || !SESSION_ID_PATTERN.test(value.sessionId)) return false;
  if (value.ipcProtocol === undefined) {
    return Object.keys(value).length === 2;
  }
  return value.ipcProtocol === 2 && Object.keys(value).length === 4 && IPC_SECRET_PATTERN.test(value.ipcSecret);
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
    !value.profileDirectory.includes("\\") &&
    (value.ipcProtocol === undefined || value.ipcProtocol === 2);
}

export async function listBridgeProfiles(chromeUserDataDir) {
  try { return await listChromeProfiles(chromeUserDataDir); }
  catch (error) { throw profileError(error); }
}

export async function installBridge(options = {}) {
  const {
    extensionId,
    profile,
    appSupportDir: requestedAppSupportDir,
    chromeUserDataDir: requestedChromeUserDataDir,
    registryDir: requestedRegistryDir,
    nodeExecutable = process.execPath,
    nativeHostSource = join(packageScriptsDir(), "native-host.mjs"),
    platform = process.platform,
    env = process.env,
    registry: suppliedRegistry,
    shortPathResolver: suppliedShortPathResolver,
    securitySpawnSyncImpl = spawnSync,
    powershellSpawnSyncImpl = spawnSync,
  } = options;
  if (platform !== "darwin" && platform !== "win32") {
    throw new BridgeSetupError("UNSUPPORTED_PLATFORM", "本地桥接安装仅支持 macOS 和 Windows。");
  }
  if (typeof extensionId !== "string" || !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new BridgeSetupError("INVALID_EXTENSION_ID", "扩展 ID 必须是由 a 到 p 组成的 32 个字符。");
  }
  const appSupportDir = requestedAppSupportDir ?? defaultAppSupportDir({ platform, env });
  const chromeUserDataDir = requestedChromeUserDataDir ?? defaultChromeUserDataDir({ platform, env });
  const registryDir = platform === "darwin"
    ? requestedRegistryDir ?? join(chromeUserDataDir, "NativeMessagingHosts")
    : undefined;
  const registry = suppliedRegistry ?? createWindowsRegistry({ env, spawnSyncImpl: powershellSpawnSyncImpl });
  const shortPathResolver = suppliedShortPathResolver ?? ((path) => resolveWindowsShortPath(path, {
    env,
    spawnSyncImpl: powershellSpawnSyncImpl,
  }));
  const securityOptions = { platform, env, spawnSyncImpl: securitySpawnSyncImpl };
  const nodePathIsAbsolute = platform === "win32"
    ? typeof nodeExecutable === "string" && win32.isAbsolute(nodeExecutable)
    : typeof nodeExecutable === "string" && nodeExecutable.startsWith("/");
  if (!nodePathIsAbsolute) {
    throw new Error("An absolute Node.js executable path is required.");
  }
  let selectedProfile;
  try { selectedProfile = await selectChromeProfile(profile, chromeUserDataDir); }
  catch (error) { throw profileError(error); }
  const root = resolve(appSupportDir);
  const registrationDir = registryDir ? resolve(registryDir) : undefined;
  const hostPath = join(root, "native-host.mjs");
  const configPath = join(root, "bridge.json");
  const sessionPath = join(root, "session.json");
  const launcherPath = join(root, platform === "win32" ? "native-host-launcher.cmd" : "native-host-launcher");
  const manifestPath = platform === "darwin"
    ? join(registrationDir, `${NATIVE_HOST_NAME}.json`)
    : join(root, `${NATIVE_HOST_NAME}.json`);

  const previousRegistrationPath = platform === "win32"
    ? await assertWindowsRegistration(registry, manifestPath)
    : null;
  if (platform === "win32") await ensurePrivateDirectory(root, platform, securityOptions);
  const manifestLauncherPath = platform === "win32"
    ? await windowsLauncherEntryPath(launcherPath, root, shortPathResolver)
    : launcherPath;

  const existingFileOptions = { platform, securityOptions };
  const existingManifestText = await inspectExisting(manifestPath, existingFileOptions);
  let ownsManifest = false;
  if (existingManifestText !== undefined) {
    const existingManifest = readJson(existingManifestText, "Existing Native Messaging registration");
    if (!isOwnedManifest(existingManifest, manifestLauncherPath)) {
      throw new BridgeSetupError("HOST_REGISTRATION_CONFLICT", "检测到同名但不属于本工具的 Native Messaging 注册，已保留原文件。");
    }
    ownsManifest = true;
  }
  const existingConfig = await inspectExisting(configPath, existingFileOptions);
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
  const existingHost = await inspectExisting(hostPath, existingFileOptions);
  const existingLauncher = await inspectExisting(launcherPath, existingFileOptions);
  if ((existingHost !== undefined || existingLauncher !== undefined) && !ownsConfig && !ownsManifest) {
    throw new BridgeSetupError("BRIDGE_FILE_CONFLICT", "检测到不属于本工具的本地桥接文件，已保留原文件。");
  }
  const existingSession = await inspectExisting(sessionPath, existingFileOptions);
  if (existingSession !== undefined && !ownsConfig && !ownsManifest) {
    throw new BridgeSetupError("BRIDGE_FILE_CONFLICT", "检测到不属于本工具的本地连接会话，已保留原文件。");
  }
  if (registrationDir) {
    let registryInfo;
    try { registryInfo = await lstat(registrationDir); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (registryInfo && (!registryInfo.isDirectory() || registryInfo.isSymbolicLink())) {
      throw new Error("Chrome Native Messaging registration directory is unsafe.");
    }
  }
  const sourceInfo = await lstat(nativeHostSource);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Packaged Native Messaging host is unavailable.");
  const nativeHostBundle = await readFile(nativeHostSource);
  if (platform === "darwin") {
    const socketProbe = join(root, "s-0123456789abcdef.sock");
    if (Buffer.byteLength(socketProbe, "utf8") > 103) throw new Error("The private bridge path is too long for a macOS socket.");
  }

  const config = {
    version: 1,
    hostName: NATIVE_HOST_NAME,
    platform,
    ipcProtocol: 2,
    extensionId,
    nodeExecutable,
    profileDirectory: selectedProfile.directory,
    profileName: selectedProfile.name,
    chromeUserDataDir: resolve(chromeUserDataDir),
    appSupportDir: root,
    configPath,
    sessionPath,
  };
  const sameConfiguration = ownsConfig &&
    existingConfigValue.platform === config.platform &&
    existingConfigValue.extensionId === config.extensionId &&
    existingConfigValue.profileDirectory === config.profileDirectory &&
    resolve(existingConfigValue.chromeUserDataDir ?? "") === config.chromeUserDataDir;
  let sessionId;
  if (sameConfiguration && existingSession !== undefined) {
    try {
      const previousSession = JSON.parse(existingSession);
      if (existingConfigValue.ipcProtocol === 2 && previousSession.ipcProtocol === 2 && isBridgeSession(previousSession)) {
        sessionId = previousSession.sessionId;
      }
    } catch { /* Replace invalid owned session state with a fresh identifier. */ }
  }
  sessionId ??= randomUUID();
  let ipcSecret;
  if (sameConfiguration && existingSession !== undefined) {
    try {
      const previousSession = JSON.parse(existingSession);
      if (sessionId === previousSession.sessionId && previousSession.ipcProtocol === 2 && isBridgeSession(previousSession)) {
        ipcSecret = previousSession.ipcSecret;
      }
    } catch { /* Replace invalid owned session state with a fresh secret. */ }
  }
  ipcSecret ??= randomBytes(32).toString("hex");
  const session = { version: 1, sessionId, ipcProtocol: 2, ipcSecret };
  const hostManifest = {
    name: NATIVE_HOST_NAME,
    description: HOST_DESCRIPTION,
    path: manifestLauncherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  if (platform !== "win32") await ensurePrivateDirectory(root, platform, securityOptions);
  if (registrationDir) await mkdir(registrationDir, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const entries = [
      { path: hostPath, content: nativeHostBundle, mode: 0o600, replace: existingHost !== undefined },
      { path: configPath, content: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600, replace: ownsConfig },
      { path: sessionPath, content: `${JSON.stringify(session)}\n`, mode: 0o600, replace: existingSession !== undefined },
      { path: launcherPath, content: windowsLauncher(), mode: 0o700, replace: existingLauncher !== undefined },
      { path: manifestPath, content: `${JSON.stringify(hostManifest, null, 2)}\n`, mode: 0o600, replace: existingManifestText !== undefined },
    ];
    await installWindowsBundle(entries, securityOptions, async () => {
      if (!sameWindowsPath(manifestLauncherPath, launcherPath)) {
        const verifiedPath = await shortPathResolver(launcherPath);
        if (!sameWindowsPath(verifiedPath, manifestLauncherPath)) {
          throw new BridgeSetupError("UNSAFE_LAUNCHER_PATH", "Windows 启动器短路径与实际文件不一致。");
        }
      }
      try {
        await registry.write(REGISTRY_KEY, manifestPath);
        if (!sameWindowsPath(await registry.read(REGISTRY_KEY), manifestPath)) throw new Error("WINDOWS_REGISTRATION_UNAVAILABLE");
      } catch (error) {
        try {
          const currentPath = await registry.read(REGISTRY_KEY);
          if (previousRegistrationPath === null && sameWindowsPath(currentPath, manifestPath)) {
            await registry.remove(REGISTRY_KEY, manifestPath);
          } else if (previousRegistrationPath !== null && !sameWindowsPath(currentPath, previousRegistrationPath)) {
            await registry.write(REGISTRY_KEY, previousRegistrationPath);
          }
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Windows bridge registration rollback failed.");
        }
        throw error;
      }
    });
  } else {
    await atomicWrite(hostPath, nativeHostBundle, 0o600, { replace: true, platform, securityOptions });
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600, { replace: true, platform, securityOptions });
    await atomicWrite(sessionPath, `${JSON.stringify(session)}\n`, 0o600, { replace: existingSession !== undefined, platform, securityOptions });
    const launcher = `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(hostPath)} ${shellQuote(configPath)} "$@"\n`;
    await atomicWrite(launcherPath, launcher, 0o700, { replace: true, platform, securityOptions });
    await atomicWrite(manifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`, 0o600, { replace: existingManifestText !== undefined, platform, securityOptions });
  }

  return { config, hostManifestPath: manifestPath, launcherPath, profile: selectedProfile };
}

export async function readBridgeInstallation({ appSupportDir = defaultAppSupportDir() } = {}) {
  const root = resolve(appSupportDir);
  const configPath = join(root, "bridge.json");
  let value;
  try {
    if (process.platform === "win32") {
      await assertWindowsPrivatePath(root, { directory: true });
      await assertWindowsPrivatePath(configPath);
    }
    value = JSON.parse(await readFile(configPath, "utf8"));
  }
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
    resolve(value.appSupportDir) !== root ||
    (value.ipcProtocol !== undefined && value.ipcProtocol !== 2)
  ) throw new BridgeSetupError("BRIDGE_CONFIG_INVALID", "本地连接配置无效，请重新运行 install-bridge。");
  return value;
}

export async function readBridgeSessionInfo(config, {
  platform = config?.platform ?? process.platform,
  env = process.env,
  securitySpawnSyncImpl = spawnSync,
} = {}) {
  if (!config?.appSupportDir) return null;
  const sessionPath = join(config.appSupportDir, "session.json");
  try {
    if (platform === "win32") {
      const securityOptions = { platform, env, spawnSyncImpl: securitySpawnSyncImpl };
      await assertWindowsPrivatePath(config.appSupportDir, { ...securityOptions, directory: true });
      await assertWindowsPrivatePath(join(config.appSupportDir, "bridge.json"), securityOptions);
      await assertWindowsPrivatePath(sessionPath, securityOptions);
    }
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    if (!isBridgeSession(session)) return null;
    const sessionProtocol = session.ipcProtocol ?? 1;
    if (sessionProtocol !== (config.ipcProtocol ?? 1)) return null;
    return {
      sessionId: session.sessionId,
      ipcProtocol: sessionProtocol,
      ...(sessionProtocol === 2 ? { ipcSecret: session.ipcSecret } : {}),
    };
  } catch {
    return null;
  }
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

function isAbsoluteExecutablePath(path, platform) {
  return typeof path === "string" && (platform === "win32" ? win32.isAbsolute(path) : path.startsWith("/"));
}

function controlledNodeEnvironment(env, platform) {
  if (platform !== "win32") return { PATH: "" };
  return Object.fromEntries(["SystemRoot", "WINDIR"]
    .filter((key) => typeof env[key] === "string")
    .map((key) => [key, env[key]]));
}

function inspectNodeExecutable(nodePath, {
  platform,
  env,
  spawnSyncImpl,
}) {
  if (!isAbsoluteExecutablePath(nodePath, platform)) return { state: "invalid", version: null };
  const result = spawnSyncImpl(nodePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3_000,
    shell: false,
    windowsHide: true,
    env: controlledNodeEnvironment(env, platform),
  });
  if (result.error) {
    if (result.error.code === "ENOENT") return { state: "missing", version: null };
    if (["EACCES", "EPERM"].includes(result.error.code)) return { state: "access_failed", version: null };
    return { state: "unknown", version: null };
  }
  if (result.status !== 0) return { state: "access_failed", version: null };
  const match = /^v(\d+\.\d+\.\d+)$/.exec((result.stdout ?? "").trim());
  if (!match) return { state: "invalid", version: null };
  return {
    state: supportsNodeVersion(match[1]) ? "available" : "version_incompatible",
    version: match[1],
  };
}

export async function inspectBridgeComponents(config, {
  registryDir: configuredRegistryDir,
  platform = config?.platform ?? process.platform,
  env = process.env,
  registry: suppliedRegistry,
  shortPathResolver: suppliedShortPathResolver,
  securitySpawnSyncImpl = spawnSync,
  powershellSpawnSyncImpl = spawnSync,
  nodeSpawnSyncImpl = spawnSync,
} = {}) {
  if (!config) {
    return {
      registration: "unknown",
      host: "unknown",
      launcher: "unknown",
      node: "unknown",
      nodeVersion: null,
      session: "unknown",
      security: "unknown",
    };
  }
  const registryDir = platform === "darwin"
    ? configuredRegistryDir ?? join(config.chromeUserDataDir ?? defaultChromeUserDataDir({ platform }), "NativeMessagingHosts")
    : undefined;
  const registry = suppliedRegistry ?? createWindowsRegistry({ env, spawnSyncImpl: powershellSpawnSyncImpl });
  const shortPathResolver = suppliedShortPathResolver ?? ((path) => resolveWindowsShortPath(path, {
    env,
    spawnSyncImpl: powershellSpawnSyncImpl,
  }));
  const hostPath = join(config.appSupportDir, "native-host.mjs");
  const configPath = join(config.appSupportDir, "bridge.json");
  const launcherPath = join(config.appSupportDir, platform === "win32" ? "native-host-launcher.cmd" : "native-host-launcher");
  const manifestPath = platform === "darwin"
    ? join(registryDir, `${NATIVE_HOST_NAME}.json`)
    : join(config.appSupportDir, `${NATIVE_HOST_NAME}.json`);
  let manifestLauncherPath = launcherPath;
  if (platform === "win32") {
    try { manifestLauncherPath = await windowsLauncherEntryPath(launcherPath, config.appSupportDir, shortPathResolver); }
    catch { manifestLauncherPath = undefined; }
  }
  const securityOptions = { platform, env, spawnSyncImpl: securitySpawnSyncImpl };
  let security = "unknown";
  if (platform === "win32") {
    const paths = [
      [config.appSupportDir, true],
      [configPath, false],
      [join(config.appSupportDir, "session.json"), false],
      [hostPath, false],
      [launcherPath, false],
      [manifestPath, false],
    ];
    try {
      const statuses = await Promise.all(paths.map(([path, directory]) => inspectWindowsPathSecurity(path, {
        ...securityOptions,
        directory,
      })));
      security = statuses.every((status) => status === "valid") ? "valid" : "invalid";
    } catch { security = "unknown"; }
  }
  const hostFile = await fileStatus(hostPath);
  const launcherFile = await fileStatus(launcherPath, { executable: platform !== "win32" });
  const host = hostFile.state === "present"
    ? hostFile.size > 0 ? "present" : "invalid"
    : hostFile.state;
  let launcher = launcherFile.state === "present" ? "valid" : launcherFile.state;
  let node = "unknown";
  let nodeVersion = null;
  if (launcherFile.state === "present") {
    try {
      if (platform === "win32") await assertWindowsPrivatePath(launcherPath, securityOptions);
      const text = await readFile(launcherPath, "utf8");
      if (platform === "win32") {
        if (config.ipcProtocol !== 2 || typeof config.nodeExecutable !== "string") {
          launcher = "invalid";
        } else {
          launcher = text === windowsLauncher() ? "valid" : "invalid";
          const result = inspectNodeExecutable(config.nodeExecutable, { platform, env, spawnSyncImpl: nodeSpawnSyncImpl });
          node = result.state;
          nodeVersion = result.version;
        }
      } else {
        const nodePath = launcherNodeExecutable(text, hostPath, configPath);
        if (!nodePath || !nodePath.startsWith("/")) {
          launcher = "invalid";
        } else {
          const result = inspectNodeExecutable(nodePath, { platform, env, spawnSyncImpl: nodeSpawnSyncImpl });
          node = result.state;
          nodeVersion = result.version;
        }
      }
    } catch (error) {
      launcher = error.code === "ENOENT" ? "missing" : "unknown";
    }
  }

  let registration = "unknown";
  try {
    const text = await inspectExisting(manifestPath, { platform, securityOptions });
    let manifestValid = false;
    if (text !== undefined) {
      try {
        const manifest = readJson(text, "Native Messaging registration");
        manifestValid = isOwnedManifest(manifest, platform === "win32" ? manifestLauncherPath : launcherPath) &&
          manifest.allowed_origins[0] === `chrome-extension://${config.extensionId}/`;
      } catch { manifestValid = false; }
    }
    if (platform === "win32") {
      const details = typeof registry.inspect === "function"
        ? await registry.inspect(REGISTRY_KEY)
        : { state: "valid", path: await registry.read(REGISTRY_KEY) };
      registration = details.state === "missing" ? "missing"
        : details.state === "valid" && manifestValid && sameWindowsPath(details.path, manifestPath) ? "valid"
          : "invalid";
    } else {
      registration = text === undefined ? "missing" : manifestValid ? "valid" : "invalid";
    }
  } catch (error) {
    registration = error.code === "ENOENT" ? "missing" : error.code ? "unknown" : "invalid";
  }

  let session = "unknown";
  try {
    const sessionPath = join(config.appSupportDir, "session.json");
    if (platform === "win32") await assertWindowsPrivatePath(sessionPath, securityOptions);
    const value = JSON.parse(await readFile(sessionPath, "utf8"));
    session = !isBridgeSession(value) ? "invalid"
      : (value.ipcProtocol ?? 1) !== (config.ipcProtocol ?? 1) ? "invalid"
        : value.ipcProtocol === 2 ? "available" : "legacy";
  } catch (error) {
    session = error.code === "ENOENT" ? "missing" : error.code ? "unknown" : "invalid";
  }
  return {
    registration,
    host,
    launcher,
    node,
    nodeVersion,
    session,
    security,
  };
}

export function bridgeSocketPath(config, sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Bridge session is invalid.");
  if ((config?.platform ?? process.platform) === "win32") return `\\\\.\\pipe\\${windowsPipeName(config.appSupportDir, sessionId)}`;
  return join(config.appSupportDir, `s-${sessionId.replaceAll("-", "").slice(0, 16)}.sock`);
}

export async function readBridgeSession(config) {
  return (await readBridgeSessionInfo(config))?.sessionId ?? null;
}
