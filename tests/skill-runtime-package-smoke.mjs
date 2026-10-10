import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = join(process.cwd(), "dist", "weixin-channels-video");
const runner = join(packageRoot, "scripts", "run.mjs");
const sourceRunner = join(process.cwd(), "skills", "weixin-channels-video", "scripts", "run.mjs");
const tempRoot = await mkdtemp(join(tmpdir(), "skill-runtime-smoke-"));
const env = { ...process.env };

if (process.platform === "win32") env.LOCALAPPDATA = join(tempRoot, "LocalAppData");
else env.HOME = join(tempRoot, "home");

function prepare() {
  const result = spawnSync(process.execPath, [runner, "prepare"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  const first = prepare();
  assert.equal(first.minimumNodeVersion, "22.22.2");
  assert.equal(first.runtimeProtocol, 2);
  assert.ok(isAbsolute(first.extensionAssets));
  assert.ok(existsSync(join(first.extensionAssets, "manifest.json")));

  const cacheRoot = dirname(first.extensionAssets);
  const marker = JSON.parse(await readFile(join(cacheRoot, "current.json"), "utf8"));
  const cachedRuntime = join(cacheRoot, marker.version);
  assert.ok(existsSync(join(cachedRuntime, "runtime.json")));
  assert.ok(existsSync(join(cachedRuntime, "scripts", "cli.mjs")));
  assert.ok(existsSync(join(cachedRuntime, "scripts", "native-host.mjs")));
  const preservedFile = join(cachedRuntime, "existing-cache-data");
  await writeFile(preservedFile, "keep");

  const sourceCommand = spawnSync(process.execPath, [sourceRunner, "help"], { encoding: "utf8", env });
  assert.equal(sourceCommand.status, 0, sourceCommand.stderr || sourceCommand.stdout);
  assert.match(sourceCommand.stdout, /^Usage: cli\.mjs/m);

  const second = prepare();
  assert.equal(second.extensionAssets, first.extensionAssets);
  assert.equal(await readFile(preservedFile, "utf8"), "keep");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
