import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const WINDOWS_PRIVATE_PATH_ASSERTION = String.raw`
function Assert-WcvPrivatePath($path, $kind) {
  $attributes = [System.IO.File]::GetAttributes($path);
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT' };
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;
  if ($null -eq $identity) { throw 'MISSING_USER_SID' };
  $acl = Get-Acl -LiteralPath $path;
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'OWNER_MISMATCH' };
  if (-not $acl.AreAccessRulesProtected) { throw 'INHERITED_ACL' };
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]));
  if ($rules.Count -ne 1) { throw 'ACL_RULE_COUNT' };
  $rule = $rules[0];
  $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::None;
  if ($kind -eq 'directory') {
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;
  };
  if ($rule.IdentityReference.Value -ne $identity.Value -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $expectedInheritance -or
      $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
      $rule.IsInherited) { throw 'ACL_CHECK_FAILED' }
}
`;

const ACCESS_CONTROL_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:WCV_PRIVATE_PATH
$mode = $env:WCV_PRIVATE_MODE
$kind = $env:WCV_PRIVATE_KIND
$newlyCreated = $env:WCV_PRIVATE_NEWLY_CREATED -eq '1'
$stage = 30
${WINDOWS_PRIVATE_PATH_ASSERTION}
try {
  $stage = 30
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 20 }
  $stage = 31
  $token = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $identity = $token.User
  if ($null -eq $identity) { exit 21 }
  $stage = 32
  $acl = Get-Acl -LiteralPath $path
  if ($mode -eq 'secure') {
    $stage = 33
    $currentOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($currentOwner -ne $identity.Value) {
      $tokenOwner = $token.Owner
      if (-not $newlyCreated -or $null -eq $tokenOwner -or $currentOwner -ne $tokenOwner.Value) { exit 22 }
      $acl.SetOwner($identity)
    }
    $stage = 34
    $acl.SetAccessRuleProtection($true, $false)
    $rules = $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])
    for ($index = 0; $index -lt $rules.Count; $index++) {
      [void]$acl.RemoveAccessRuleAll($rules[$index])
    }
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
    $stage = 35
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  $stage = 36
  Assert-WcvPrivatePath $path $kind
  exit 0
} catch {
  if ($_.Exception.Message -eq 'MISSING_USER_SID') { exit 21 }
  if ($_.Exception.Message -eq 'OWNER_MISMATCH') { exit 22 }
  if ($_.Exception.Message -eq 'REPARSE_POINT') { exit 20 }
  if ($_.Exception.Message -eq 'INHERITED_ACL' -or
      $_.Exception.Message -eq 'ACL_RULE_COUNT' -or
      $_.Exception.Message -eq 'ACL_CHECK_FAILED') { exit 23 }
  if ($stage -eq 32) {
    if ($_.FullyQualifiedErrorId -like 'CouldNotAutoloadMatchingModule*') { exit 43 }
    if ($_.FullyQualifiedErrorId -like 'CommandNotFoundException*') { exit 40 }
    $exception = $_.Exception
    while ($null -ne $exception) {
      if ($exception -is [System.Management.Automation.CommandNotFoundException]) { exit 40 }
      if ($exception -is [System.UnauthorizedAccessException] -or
          $exception -is [System.Security.SecurityException]) { exit 41 }
      $exception = $exception.InnerException
    }
    exit 42
  }
  exit $stage
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
  newlyCreated = false,
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
      WCV_PRIVATE_NEWLY_CREATED: newlyCreated ? "1" : "0",
    },
  });
  if (result.error || result.status !== 0) {
    const failures = {
      20: "WINDOWS_PATH_UNSAFE",
      21: "WINDOWS_SECURITY_IDENTITY_UNAVAILABLE",
      22: "WINDOWS_PATH_OWNER_MISMATCH",
      23: "WINDOWS_ACL_CHECK_FAILED",
    };
    const code = failures[result.status] ?? "WINDOWS_SECURITY_COMMAND_FAILED";
    const error = new Error(code);
    error.code = code;
    error.exitCode = Number.isInteger(result.status) ? result.status : null;
    throw error;
  }
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
  newlyCreated = false,
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  await assertFileKind(path, directory);
  runAccessControl(path, "secure", directory, { newlyCreated, platform, env, spawnSyncImpl });
}

export async function inspectWindowsPathSecurity(path, options) {
  try {
    await assertWindowsPrivatePath(path, options);
    return "valid";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "invalid";
  }
}
