import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const WINDOWS_PRIVATE_PATH_ASSERTION = String.raw`
function Assert-WcvPrivatePath($path, $kind) {
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $identity) { throw 'MISSING_USER_SID' }
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'OWNER_MISMATCH' }
  if (-not $acl.AreAccessRulesProtected) { throw 'INHERITED_ACL' }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { throw 'ACL_RULE_COUNT' }
  $rule = $rules[0]
  $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($kind -eq 'directory') {
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  if ($rule.IdentityReference.Value -ne $identity.Value -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $expectedInheritance -or
      $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
      $rule.IsInherited) { throw 'ACL_RULE_MISMATCH' }
}
`;

const ACCESS_CONTROL_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:WCV_PRIVATE_PATH
$mode = $env:WCV_PRIVATE_MODE
$kind = $env:WCV_PRIVATE_KIND
${WINDOWS_PRIVATE_PATH_ASSERTION}
try {
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 20 }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $identity) { exit 21 }
  $acl = Get-Acl -LiteralPath $path
  if ($mode -eq 'secure') {
    $currentOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($currentOwner -ne $identity.Value) { exit 22 }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($entry) }
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($kind -eq 'directory') {
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  Assert-WcvPrivatePath $path $kind
  exit 0
} catch {
  exit 26
}
`;

export function windowsPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot)) {
    throw new Error("WINDOWS_SECURITY_UNAVAILABLE");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runAccessControl(path, mode, directory, {
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "win32") throw new Error("WINDOWS_SECURITY_UNAVAILABLE");
  const result = spawnSyncImpl(windowsPowerShellPath(env), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    ACCESS_CONTROL_COMMAND,
  ], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5_000,
    shell: false,
    env: {
      ...env,
      WCV_PRIVATE_PATH: path,
      WCV_PRIVATE_MODE: mode,
      WCV_PRIVATE_KIND: directory ? "directory" : "file",
    },
  });
  if (result.error || result.status !== 0) throw new Error("WINDOWS_PATH_UNSAFE");
}

async function assertFileKind(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error("WINDOWS_PATH_UNSAFE");
  }
}

export async function assertWindowsPrivatePath(path, {
  directory = false,
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  await assertFileKind(path, directory);
  runAccessControl(path, "check", directory, { platform, env, spawnSyncImpl });
}

export async function secureWindowsPath(path, {
  directory = false,
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  await assertFileKind(path, directory);
  runAccessControl(path, "secure", directory, { platform, env, spawnSyncImpl });
}

export async function inspectWindowsPathSecurity(path, options) {
  try {
    await assertWindowsPrivatePath(path, options);
    return "valid";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "invalid";
  }
}
