import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWindowsPrivatePath, inspectWindowsPathSecurity, secureWindowsPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

async function withTempDir(callback) {
  const root = await mkdtemp(join(tmpdir(), "wcv-acl-test-"));
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function successfulPowerShell(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, error: undefined };
  };
}

test("private Windows path helper runs fixed PowerShell with paths as arguments", async () => {
  await withTempDir(async (root) => {
    const directory = join(root, "tool cache");
    await mkdir(directory);
    const calls = [];
    const spawnSyncImpl = successfulPowerShell(calls);
    const settings = { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawnSyncImpl };

    await secureWindowsPath(directory, { ...settings, directory: true, newlyCreated: true });
    await assertWindowsPrivatePath(directory, { ...settings, directory: true });
    assert.equal(await inspectWindowsPathSecurity(directory, { ...settings, directory: true }), "valid");

    assert.equal(calls.length, 3);
    assert.equal(calls[0].args[0], "-NoProfile");
    assert.equal(calls[0].args[1], "-NonInteractive");
    assert.equal(calls[0].args[2], "-Command");
    assert.equal(calls[0].args.length, 4);
    assert.equal(calls[0].options.env.WCV_PRIVATE_PATH, directory);
    assert.equal(calls[0].options.env.WCV_PRIVATE_MODE, "secure");
    assert.equal(calls[0].options.env.WCV_PRIVATE_KIND, "directory");
    assert.equal(calls[0].options.env.WCV_PRIVATE_NEWLY_CREATED, "1");
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.timeout, 5_000);
    const secureCommand = calls[0].args[3];
    assert.ok(secureCommand.indexOf("$currentOwner = $acl.GetOwner") < secureCommand.indexOf("Set-Acl -LiteralPath"));
    assert.match(secureCommand, /if \(-not \$newlyCreated -or \$null -eq \$tokenOwner -or \$currentOwner -ne \$tokenOwner\.Value\) \{ exit 22 \}/);
    assert.match(secureCommand, /\$acl\.SetOwner\(\$identity\)/);
    assert.match(secureCommand, /MISSING_USER_SID'\) \{ exit 21 \}/);
    assert.match(secureCommand, /INHERITED_ACL' -or[\s\S]+ACL_RULE_COUNT' -or[\s\S]+ACL_CHECK_FAILED'\) \{ exit 23 \}/);
    assert.match(secureCommand, /\$acl\.GetAccessRules\(\$true, \$false, \[System\.Security\.Principal\.SecurityIdentifier\]\)/);
    assert.doesNotMatch(secureCommand, /\$acl\.Access/);
    for (const stage of [30, 31, 32, 33, 34, 35, 36]) assert.match(secureCommand, new RegExp(`\\$stage = ${stage}`));
    assert.match(secureCommand, /exit \$stage/);
    assert.doesNotMatch(secureCommand, /TakeOwnership/);
  });
});

test("private Windows path helper refuses reparse points and failed ACL verification", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "private.json");
    await writeFile(path, "{}\n");
    for (const [status, code] of [
      [20, "WINDOWS_PATH_UNSAFE"],
      [21, "WINDOWS_SECURITY_IDENTITY_UNAVAILABLE"],
      [22, "WINDOWS_PATH_OWNER_MISMATCH"],
      [23, "WINDOWS_ACL_CHECK_FAILED"],
      [30, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [31, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [32, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [33, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [34, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [35, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [36, "WINDOWS_SECURITY_COMMAND_FAILED"],
      [1, "WINDOWS_SECURITY_COMMAND_FAILED"],
    ]) {
      await assert.rejects(assertWindowsPrivatePath(path, {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        spawnSyncImpl: () => ({ status, stdout: "C:\\private\\path", stderr: "raw PowerShell detail" }),
      }), (error) => error.code === code && error.exitCode === status &&
        error.message === code && !error.message.includes(path) &&
        !error.message.includes("raw PowerShell detail"));
    }
    await assert.rejects(assertWindowsPrivatePath(path, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: () => ({ error: Object.assign(new Error("private error"), { code: "EACCES" }), status: null }),
    }), (error) => error.code === "WINDOWS_SECURITY_COMMAND_FAILED" &&
      error.exitCode === null && error.message === "WINDOWS_SECURITY_COMMAND_FAILED");
    assert.equal(await inspectWindowsPathSecurity(path, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: () => ({ status: 22 }),
    }), "invalid");

    const link = join(root, "link.json");
    await symlink(path, link);
    await assert.rejects(secureWindowsPath(link, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: successfulPowerShell([]),
    }), /WINDOWS_PATH_UNSAFE/);
  });
});

test("secure helper refuses an existing non-user-owned directory without mutation", async () => {
  await withTempDir(async (root) => {
    const directory = join(root, "existing");
    await mkdir(directory);
    const childPath = join(directory, "data.txt");
    await writeFile(childPath, "preserve exactly\n", { flag: "wx" });
    let invocation;
    await assert.rejects(secureWindowsPath(directory, {
      platform: "win32",
      directory: true,
      newlyCreated: false,
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: (_executable, args, options) => {
        invocation = { args, options };
        return { status: 22 };
      },
    }), (error) => error.code === "WINDOWS_PATH_OWNER_MISMATCH" && error.exitCode === 22);
    assert.equal(invocation.options.env.WCV_PRIVATE_NEWLY_CREATED, "0");
    const command = invocation.args[3];
    const ownerMismatchGuard = command.indexOf("if (-not $newlyCreated -or $null -eq $tokenOwner -or $currentOwner -ne $tokenOwner.Value) { exit 22 }");
    assert.ok(ownerMismatchGuard >= 0);
    assert.ok(ownerMismatchGuard < command.indexOf("$acl.SetOwner($identity)"));
    assert.ok(ownerMismatchGuard < command.indexOf("$acl.SetAccessRuleProtection($true, $false)"));
    assert.equal(await readFile(childPath, "utf8"), "preserve exactly\n");
  });
});
