import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

    await secureWindowsPath(directory, { ...settings, directory: true });
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
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.timeout, 5_000);
    const secureCommand = calls[0].args[3];
    assert.ok(secureCommand.indexOf("$currentOwner = $acl.GetOwner") < secureCommand.indexOf("Set-Acl -LiteralPath"));
    assert.match(secureCommand, /if \(\$currentOwner -ne \$identity\.Value\) \{ exit 22 \}/);
    assert.doesNotMatch(secureCommand, /TakeOwnership/);
  });
});

test("private Windows path helper refuses reparse points and failed ACL verification", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "private.json");
    await writeFile(path, "{}\n");
    await assert.rejects(assertWindowsPrivatePath(path, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: () => ({ status: 22 }),
    }), /WINDOWS_PATH_UNSAFE/);

    const link = join(root, "link.json");
    await symlink(path, link);
    await assert.rejects(secureWindowsPath(link, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: successfulPowerShell([]),
    }), /WINDOWS_PATH_UNSAFE/);
  });
});
