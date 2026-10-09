#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export const RUNTIME_PROTOCOL = 1;

const execFileAsync = promisify(execFile);
const OWNER = "MC0571";
const REPOSITORY = "weixin-channels-video";
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/latest`;
const ARCHIVE_NAME = (version) => `${REPOSITORY}-skill-v${version}.tar.gz`;
const CACHE_ROOT = join(homedir(), "Library", "Caches", REPOSITORY, "skill-runtime");
const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 256;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
  if (value.split(".").some((part) => Number(part) > 65535)) return null;
  return value;
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("运行资源文件类型无效。");
}

async function readRegularFile(path) {
  await assertRegularFile(path);
  return readFile(path);
}

async function readRuntime(root, expectedVersion) {
  const metadata = JSON.parse((await readRegularFile(join(root, "runtime.json"))).toString("utf8"));
  if (
    !isRecord(metadata) || Object.keys(metadata).length !== 2 ||
    !parseVersion(metadata.version) ||
    !Number.isInteger(metadata.runtimeProtocol) ||
    metadata.runtimeProtocol !== RUNTIME_PROTOCOL ||
    (expectedVersion && metadata.version !== expectedVersion)
  ) fail("Skill 与运行资源版本不兼容，请更新 Skill 后重试。");

  const scriptsDir = join(root, "scripts");
  const extensionDir = join(root, "assets", "extension");
  await assertRegularFile(join(scriptsDir, "cli.mjs"));
  await assertRegularFile(join(scriptsDir, "native-host.mjs"));
  const extensionInfo = await lstat(extensionDir);
  if (!extensionInfo.isDirectory() || extensionInfo.isSymbolicLink()) fail("扩展运行资源目录无效。");
  const manifest = JSON.parse((await readRegularFile(join(extensionDir, "manifest.json"))).toString("utf8"));
  if (manifest.version !== metadata.version) fail("运行资源中的扩展版本与元数据不一致。");
  return {
    version: metadata.version,
    runtimeProtocol: metadata.runtimeProtocol,
    runtimeCLI: join(scriptsDir, "cli.mjs"),
    extensionAssets: extensionDir,
  };
}

async function fetchBytes(url, { maxBytes = MAX_DOWNLOAD_BYTES, json = false } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: json ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } : {},
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("无法连接 GitHub Releases，请检查网络后重试。");
  }
  if (!response.ok) fail(`GitHub Releases 请求失败（HTTP ${response.status}）。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) fail("GitHub Release 资源超过允许大小。");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function latestRelease() {
  const body = await fetchBytes(RELEASES_API, { maxBytes: 1024 * 1024, json: true });
  let release;
  try { release = JSON.parse(body.toString("utf8")); }
  catch { fail("GitHub Releases 返回了无效响应。"); }
  if (!isRecord(release) || release.draft !== false || release.prerelease !== false) {
    fail("没有可用的稳定 GitHub Release。");
  }
  const version = typeof release.tag_name === "string" && release.tag_name.startsWith("v")
    ? parseVersion(release.tag_name.slice(1))
    : null;
  if (!version) fail("最新 GitHub Release 的版本标签无效。");
  const archive = ARCHIVE_NAME(version);
  const assetNames = Array.isArray(release.assets) ? release.assets.map((asset) => asset?.name) : [];
  if (!assetNames.includes(archive) || !assetNames.includes("SHA256SUMS")) {
    fail(`GitHub Release v${version} 缺少 Skill 包或 SHA256SUMS。`);
  }
  return { version, archive };
}

function checksumFor(text, assetName) {
  const matchingRows = text.split(/\r?\n/).filter((row) => row.endsWith(`  ${assetName}`));
  if (matchingRows.length !== 1) fail("SHA256SUMS 中没有唯一匹配的 Skill 包校验值。");
  const match = matchingRows[0].match(/^([0-9a-f]{64})  [A-Za-z0-9._-]+$/);
  if (!match) fail("SHA256SUMS 格式无效。");
  return match[1];
}

function safeArchivePath(name) {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !normalized || normalized.startsWith("/") || normalized.includes("\\") ||
    normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    (normalized !== "weixin-channels-video" && !normalized.startsWith("weixin-channels-video/"))
  ) fail("Skill TAR 包包含越界路径。");
  return normalized;
}

function verboseMemberSize(line) {
  const fields = line.trim().split(/\s+/);
  const dateIndex = fields.findIndex((part) =>
    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(part) || /^\d{4}-\d{2}-\d{2}$/.test(part));
  const size = Number(fields[dateIndex - 1]);
  if (dateIndex < 2 || !Number.isSafeInteger(size) || size < 0) fail("Skill TAR 包成员信息无效。");
  return size;
}

async function inspectArchive(archivePath) {
  let namesOutput;
  let verboseOutput;
  try {
    [namesOutput, verboseOutput] = await Promise.all([
      execFileAsync("/usr/bin/tar", ["-tzf", archivePath], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024 }),
      execFileAsync("/usr/bin/tar", ["-tvzf", archivePath], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024 }),
    ]);
  } catch {
    fail("Skill TAR 包无法读取。");
  }
  const names = namesOutput.stdout.trimEnd().split(/\r?\n/);
  const details = verboseOutput.stdout.trimEnd().split(/\r?\n/);
  if (!names.length || names.length !== details.length || names.length > MAX_ARCHIVE_FILES) {
    fail("Skill TAR 包成员数量无效。");
  }

  const members = new Map();
  let totalBytes = 0;
  for (let index = 0; index < names.length; index += 1) {
    const type = details[index][0];
    if (type !== "-" && type !== "d") fail("Skill TAR 包只能包含普通文件和目录。");
    const path = safeArchivePath(names[index]);
    const directory = type === "d";
    if (directory !== names[index].endsWith("/")) fail("Skill TAR 包成员类型与路径不一致。");
    if (members.has(path)) fail("Skill TAR 包包含重复路径。");
    const size = verboseMemberSize(details[index]);
    if (directory && size !== 0) fail("Skill TAR 包目录成员大小无效。");
    totalBytes += size;
    if (totalBytes > MAX_UNPACKED_BYTES) fail("Skill TAR 包解压后超过允许大小。");
    members.set(path, directory ? "directory" : "file");
  }
  if (members.get("weixin-channels-video") !== "directory") fail("Skill TAR 包缺少根目录。");
  for (const path of members.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (members.get(parent) !== "directory") fail("Skill TAR 包目录层级无效。");
    }
  }
}

async function ensureCacheRoot() {
  if (process.platform !== "darwin") fail("此 Skill 目前只支持 macOS。");
  const appCacheRoot = dirname(CACHE_ROOT);
  await mkdir(appCacheRoot, { recursive: true, mode: 0o700 });
  const appInfo = await lstat(appCacheRoot);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) fail("工具缓存目录不安全。");
  await mkdir(CACHE_ROOT, { recursive: true, mode: 0o700 });
  const info = await lstat(CACHE_ROOT);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("运行资源缓存目录不安全。");
  await chmod(CACHE_ROOT, 0o700);
}

async function writeCurrentVersion(version) {
  const markerPath = join(CACHE_ROOT, "current.json");
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) fail("运行资源缓存标记不是普通文件。");
    const previous = JSON.parse((await readFile(markerPath, "utf8")));
    if (
      !isRecord(previous) || Object.keys(previous).length !== 2 ||
      !parseVersion(previous.version) || !Number.isInteger(previous.runtimeProtocol) || previous.runtimeProtocol < 1
    ) fail("运行资源缓存标记无效，已保留原文件。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const tempPath = join(CACHE_ROOT, `.current-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify({ version, runtimeProtocol: RUNTIME_PROTOCOL })}\n`, { flag: "wx", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, markerPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function prepareFromRelease() {
  const { version, archive } = await latestRelease();
  const destination = join(CACHE_ROOT, version);
  let destinationInfo;
  try {
    destinationInfo = await lstat(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) fail("同版本运行资源缓存不是普通目录，已保留原数据。");
    const runtime = await readRuntime(destination, version);
    await writeCurrentVersion(version);
    return runtime;
  }

  const tag = `v${version}`;
  const releaseBase = `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${tag}`;
  const [sumsBytes, archiveBytes] = await Promise.all([
    fetchBytes(`${releaseBase}/SHA256SUMS`, { maxBytes: 64 * 1024 }),
    fetchBytes(`${releaseBase}/${archive}`),
  ]);
  const expectedHash = checksumFor(sumsBytes.toString("utf8"), archive);
  const actualHash = createHash("sha256").update(archiveBytes).digest("hex");
  if (actualHash !== expectedHash) fail("Skill TAR 包 SHA256 校验失败。");
  if (archiveBytes.length < 18 || archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b ||
      archiveBytes.readUInt32LE(archiveBytes.length - 4) > MAX_UNPACKED_BYTES) {
    fail("Skill TAR 包格式无效或解压后超过允许大小。");
  }

  await ensureCacheRoot();
  const stage = await mkdtemp(join(CACHE_ROOT, `.prepare-${version}-`));
  try {
    const archivePath = join(stage, "skill.tar.gz");
    const payload = join(stage, "payload");
    await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
    await inspectArchive(archivePath);
    await mkdir(payload, { mode: 0o700 });
    try {
      await execFileAsync("/usr/bin/tar", ["-xzf", archivePath, "-C", payload], { maxBuffer: 1024 * 1024 });
    } catch {
      fail("Skill TAR 包解压失败。");
    }
    const source = join(payload, "weixin-channels-video");
    const runtime = await readRuntime(source, version);
    await rename(source, destination);
    await writeCurrentVersion(version);
    return { ...runtime, runtimeCLI: join(destination, "scripts", "cli.mjs"), extensionAssets: join(destination, "assets", "extension") };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function packagedRuntime() {
  try { await lstat(join(SKILL_ROOT, "runtime.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return readRuntime(SKILL_ROOT);
}

async function currentRuntime() {
  const bundled = await packagedRuntime();
  if (bundled) return bundled;

  const markerPath = join(CACHE_ROOT, "current.json");
  let marker;
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) fail("运行资源缓存标记不是普通文件。");
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      await ensureCacheRoot();
      return prepareFromRelease();
    }
    throw error;
  }
  if (
    !isRecord(marker) || Object.keys(marker).length !== 2 ||
    !parseVersion(marker.version) || marker.runtimeProtocol !== RUNTIME_PROTOCOL
  ) fail("当前缓存与 Skill runner 不兼容，请执行 node scripts/run.mjs prepare。");
  const runtimeRoot = join(CACHE_ROOT, marker.version);
  const runtimeInfo = await lstat(runtimeRoot);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) fail("当前运行资源缓存目录无效。");
  return readRuntime(runtimeRoot, marker.version);
}

function execute(runtimeCLI, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtimeCLI, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function run(args = process.argv.slice(2)) {
  if (args[0] === "prepare") {
    if (args.length !== 1) fail("Usage: run.mjs prepare");
    const runtime = await packagedRuntime() ?? await (async () => {
      await ensureCacheRoot();
      return prepareFromRelease();
    })();
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
    return 0;
  }
  if (!args.length) fail("Usage: run.mjs prepare | <cli-command> [options]");
  const runtime = await currentRuntime();
  return execute(runtime.runtimeCLI, args);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
