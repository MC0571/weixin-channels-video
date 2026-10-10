#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { MIN_NODE_VERSION, RUNTIME_PROTOCOL, supportsNodeVersion } from "./runtime-support.mjs";
import { assertWindowsPrivatePath, secureWindowsPath } from "./windows-security.mjs";

export { MIN_NODE_VERSION, RUNTIME_PROTOCOL, supportsNodeVersion };

const OWNER = "MC0571";
const REPOSITORY = "weixin-channels-video";
const RELEASES_API = "https://api.github.com/repos/" + OWNER + "/" + REPOSITORY + "/releases/latest";
const RELEASE_DOWNLOADS = "https://github.com/" + OWNER + "/" + REPOSITORY + "/releases/download";
const ARCHIVE_NAME = (version) => REPOSITORY + "-skill-v" + version + ".tar.gz";
const SKILL_ZIP_NAME = (version) => REPOSITORY + "-skill-v" + version + ".zip";
const EXTENSION_ZIP_NAME = (version) => REPOSITORY + "-extension-v" + version + ".zip";
const LEGACY_CACHE_ROOT = platformCacheRoot() ?? join(homedir(), ".cache", REPOSITORY, "skill-runtime");
const CACHE_ROOT = join(LEGACY_CACHE_ROOT, "protocol-" + RUNTIME_PROTOCOL);
const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 256;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = MAX_UNPACKED_BYTES + (MAX_ARCHIVE_FILES * 2 + 2) * 512;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

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

export function platformCacheRoot({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  if (platform === "darwin") {
    if (!isAbsolute(home)) fail("工具缓存路径必须是绝对路径。");
    return join(home, "Library", "Caches", REPOSITORY, "skill-runtime");
  }
  if (platform === "win32") {
    const path = win32;
    const root = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    if (!path.isAbsolute(root)) fail("工具缓存路径必须是绝对路径。");
    return path.join(root, REPOSITORY, "skill-runtime");
  }
  return null;
}

function assertSupportedNode() {
  if (!supportsNodeVersion()) fail("此 Skill 需要 Node.js " + MIN_NODE_VERSION + " 或更高版本。");
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("运行资源文件类型无效。");
}

async function readRegularFile(path) {
  await assertRegularFile(path);
  return readFile(path);
}

async function secureNewCacheDirectory(path) {
  if (process.platform === "win32") {
    await secureWindowsPath(path, { directory: true, newlyCreated: true });
  }
}

async function assertPrivateCacheDirectory(path) {
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(path, { directory: true });
  }
}

async function createOrAssertCacheDirectory(path) {
  let newlyCreated = false;
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
    newlyCreated = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("运行资源缓存目录不安全。");
  if (newlyCreated) await secureNewCacheDirectory(path);
  else await assertPrivateCacheDirectory(path);
}

async function ensureNewCacheDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 });
  await secureNewCacheDirectory(path);
}

async function assertPrivateRuntime(root) {
  if (process.platform !== "win32") return;
  await assertWindowsPrivatePath(root, { directory: true });
  await assertWindowsPrivatePath(join(root, "runtime.json"));
  await assertWindowsPrivatePath(join(root, "scripts"), { directory: true });
  await assertWindowsPrivatePath(join(root, "assets"), { directory: true });
  await assertWindowsPrivatePath(join(root, "scripts", "cli.mjs"));
  await assertWindowsPrivatePath(join(root, "scripts", "native-host.mjs"));
  await assertWindowsPrivatePath(join(root, "assets", "extension"), { directory: true });
}

async function writeCacheFile(path, contents) {
  if (process.platform === "win32") {
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    await secureWindowsPath(path, { newlyCreated: true });
    await writeFile(path, contents);
    return;
  }
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

async function copyCacheFile(source, destination) {
  if (process.platform === "win32") {
    await writeCacheFile(destination, await readRegularFile(source));
    return;
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function readRuntime(root, expectedVersion, { requirePrivate = false } = {}) {
  if (requirePrivate) await assertPrivateRuntime(root);
  const metadata = JSON.parse((await readRegularFile(join(root, "runtime.json"))).toString("utf8"));
  if (
    !isRecord(metadata) || Object.keys(metadata).length !== 3 ||
    !parseVersion(metadata.version) ||
    !Number.isInteger(metadata.runtimeProtocol) ||
    metadata.runtimeProtocol !== RUNTIME_PROTOCOL ||
    metadata.minimumNodeVersion !== MIN_NODE_VERSION ||
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
    minimumNodeVersion: metadata.minimumNodeVersion,
    runtimeCLI: join(scriptsDir, "cli.mjs"),
    extensionAssets: extensionDir,
  };
}

async function fetchBytes(url, {
  maxBytes = MAX_DOWNLOAD_BYTES,
  json = false,
  expectedSize,
  contentTypes,
} = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: json ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } : {},
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("无法连接 GitHub Releases，请检查网络后重试。");
  }
  if (!response.ok) fail("GitHub Releases 请求失败（HTTP " + response.status + "）。");
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentTypes && !contentTypes.includes(contentType)) fail("GitHub Release 资源类型无效。");
  const contentLength = response.headers.get("content-length");
  if (expectedSize !== undefined && contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) !== expectedSize)) {
    fail("GitHub Release 资源大小与元数据不一致。");
  }
  if (!response.body) fail("GitHub Releases 返回了空响应。");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) fail("GitHub Release 资源超过允许大小。");
    chunks.push(Buffer.from(chunk));
  }
  if (expectedSize !== undefined && size !== expectedSize) fail("GitHub Release 资源大小与元数据不一致。");
  return Buffer.concat(chunks, size);
}

function releaseAsset(release, version, name, maxBytes, contentTypes) {
  const matches = Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset?.name === name)
    : [];
  if (matches.length !== 1) fail("GitHub Release v" + version + " 缺少唯一资源 " + name + "。");
  const asset = matches[0];
  const expectedUrl = RELEASE_DOWNLOADS + "/v" + version + "/" + name;
  if (
    !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes ||
    typeof asset.content_type !== "string" || !contentTypes.includes(asset.content_type.split(";")[0].trim().toLowerCase()) ||
    asset.browser_download_url !== expectedUrl
  ) fail("GitHub Release 资源元数据无效。");
  return { name, size: asset.size };
}

async function latestRelease() {
  const body = await fetchBytes(RELEASES_API, {
    maxBytes: 1024 * 1024,
    json: true,
    contentTypes: ["application/json", "application/vnd.github+json"],
  });
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
  const archive = releaseAsset(release, version, ARCHIVE_NAME(version), MAX_DOWNLOAD_BYTES,
    ["application/gzip", "application/x-gzip", "application/octet-stream"]);
  releaseAsset(release, version, SKILL_ZIP_NAME(version), MAX_DOWNLOAD_BYTES,
    ["application/zip", "application/octet-stream"]);
  releaseAsset(release, version, EXTENSION_ZIP_NAME(version), MAX_DOWNLOAD_BYTES,
    ["application/zip", "application/octet-stream"]);
  const checksums = releaseAsset(release, version, "SHA256SUMS", 64 * 1024,
    ["text/plain", "application/octet-stream"]);
  return { version, archive, checksums };
}

function checksumFor(text, assetName) {
  const matchingRows = text.split(/\r?\n/).filter((row) => row.endsWith("  " + assetName));
  if (matchingRows.length !== 1) fail("SHA256SUMS 中没有唯一匹配的 Skill 包校验值。");
  const match = matchingRows[0].match(/^([0-9a-f]{64})  [A-Za-z0-9._-]+$/);
  if (!match) fail("SHA256SUMS 格式无效。");
  return match[1];
}

function safeArchivePath(name) {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !normalized || normalized.startsWith("/") || normalized.includes("\\") ||
    normalized.includes("\0") || normalized.split("/").some((part) => !isPortableSegment(part)) ||
    (normalized !== "weixin-channels-video" && !normalized.startsWith("weixin-channels-video/"))
  ) fail("Skill TAR 包包含越界路径。");
  return normalized;
}

function isPortableSegment(part) {
  return Boolean(
    part && part !== "." && part !== ".." &&
    !/[<>:"|?*\u0000-\u001f]/.test(part) &&
    !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    part === part.normalize("NFC")
  );
}

function parseTarText(field) {
  const end = field.indexOf(0);
  const bytes = end < 0 ? field : field.subarray(0, end);
  if (end >= 0 && field.subarray(end).some((byte) => byte !== 0)) fail("Skill TAR 包头部无效。");
  try { return TEXT_DECODER.decode(bytes); }
  catch { fail("Skill TAR 包路径不是有效的 UTF-8。"); }
}

function parseTarNumber(field) {
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) fail("Skill TAR 包成员大小无效。");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail("Skill TAR 包成员大小无效。");
  return value;
}

function parseSkillTar(tar) {
  const blockSize = 512;
  if (!Buffer.isBuffer(tar) || tar.length < blockSize * 2 || tar.length % blockSize !== 0) {
    fail("Skill TAR 包格式无效。");
  }
  const members = new Map();
  const canonicalPaths = new Set();
  let totalBytes = 0;
  let offset = 0;
  let ended = false;

  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) {
      if (offset + blockSize * 2 > tar.length ||
          tar.subarray(offset, offset + blockSize * 2).some((byte) => byte !== 0) ||
          tar.subarray(offset + blockSize * 2).some((byte) => byte !== 0)) {
        fail("Skill TAR 包结束标记无效。");
      }
      ended = true;
      break;
    }
    if (header.subarray(257, 263).toString("ascii") !== "ustar\0" ||
        header.subarray(263, 265).toString("ascii") !== "00") {
      fail("Skill TAR 包必须使用 USTAR 格式。");
    }

    let checksum = 0;
    for (let index = 0; index < blockSize; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (checksum !== parseTarNumber(header.subarray(148, 156))) fail("Skill TAR 包校验无效。");

    const name = parseTarText(header.subarray(0, 100));
    const prefix = parseTarText(header.subarray(345, 500));
    const fullName = prefix ? prefix + "/" + name : name;
    const typeFlag = header[156];
    const directory = typeFlag === 53;
    if (!directory && typeFlag !== 0 && typeFlag !== 48) fail("Skill TAR 包只能包含普通文件和目录。");
    if (!directory && fullName.endsWith("/")) fail("Skill TAR 包成员类型与路径不一致.");
    const path = safeArchivePath(fullName);
    const canonicalPath = path.split("/").map((part) => part.toLowerCase()).join("/");
    if (canonicalPaths.has(canonicalPath)) fail("Skill TAR 包包含重复路径。");
    canonicalPaths.add(canonicalPath);

    const size = parseTarNumber(header.subarray(124, 136));
    if (directory && size !== 0) fail("Skill TAR 包目录成员大小无效。");
    totalBytes += size;
    if (totalBytes > MAX_UNPACKED_BYTES || members.size >= MAX_ARCHIVE_FILES) {
      fail("Skill TAR 包解压后超过允许大小。");
    }
    const dataStart = offset + blockSize;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / blockSize) * blockSize;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > tar.length ||
        tar.subarray(dataEnd, nextOffset).some((byte) => byte !== 0)) {
      fail("Skill TAR 包成员范围无效。");
    }
    if (members.has(path)) fail("Skill TAR 包包含重复路径。");
    members.set(path, {
      directory,
      size,
      data: directory ? undefined : tar.subarray(dataStart, dataEnd),
    });
    offset = nextOffset;
  }

  if (!ended || members.get("weixin-channels-video")?.directory !== true) {
    fail("Skill TAR 包缺少根目录。");
  }
  for (const path of members.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (members.get(parent)?.directory !== true) fail("Skill TAR 包目录层级无效。");
    }
  }
  return members;
}

export function parseSkillArchive(archiveBytes) {
  if (
    !Buffer.isBuffer(archiveBytes) || archiveBytes.length < 18 ||
    archiveBytes.length > MAX_DOWNLOAD_BYTES ||
    archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b
  ) fail("Skill TAR 包格式无效。");
  let tar;
  try { tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_TAR_BYTES }); }
  catch { fail("Skill TAR 包无法读取或解压后超过允许大小。"); }
  return parseSkillTar(tar);
}

export async function unpackSkillArchive(archiveBytes, destination) {
  const members = parseSkillArchive(archiveBytes);
  const destinationRoot = resolve(destination);
  await ensureNewCacheDirectory(destinationRoot);
  const directories = [...members].filter(([, member]) => member.directory)
    .sort(([first], [second]) => first.split("/").length - second.split("/").length);
  for (const [path] of directories) {
    const target = resolve(destinationRoot, ...path.split("/"));
    if (target !== destinationRoot && !target.startsWith(destinationRoot + sep)) fail("Skill TAR 包包含越界路径。");
    await ensureNewCacheDirectory(target);
  }
  for (const [path, member] of members) {
    if (member.directory) continue;
    const target = resolve(destinationRoot, ...path.split("/"));
    if (target !== destinationRoot && !target.startsWith(destinationRoot + sep)) fail("Skill TAR 包包含越界路径。");
    await writeCacheFile(target, member.data);
  }
}

async function ensureCacheRoot() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    fail("此 Skill 目前支持 macOS 和 Windows。");
  }
  const appCacheRoot = dirname(LEGACY_CACHE_ROOT);
  await mkdir(appCacheRoot, { recursive: true, mode: 0o700 });
  const appInfo = await lstat(appCacheRoot);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) fail("工具缓存目录不安全。");
  await createOrAssertCacheDirectory(LEGACY_CACHE_ROOT);
  await createOrAssertCacheDirectory(CACHE_ROOT);
  if (process.platform === "darwin") {
    await chmod(LEGACY_CACHE_ROOT, 0o700);
    await chmod(CACHE_ROOT, 0o700);
  }
}

async function inspectExtensionTree(root, copyTo) {
  let files = 0;
  let totalBytes = 0;
  async function visit(source, destination) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) fail("扩展运行资源不能包含符号链接。");
    if (info.isDirectory()) {
      files += 1;
      if (files > MAX_ARCHIVE_FILES) fail("扩展运行资源成员过多。");
      if (destination) {
        await mkdir(destination, { recursive: false, mode: 0o700 });
        await secureNewCacheDirectory(destination);
      }
      for (const name of await readdir(source)) {
        if (!isPortableSegment(name)) fail("扩展运行资源路径无效。");
        await visit(join(source, name), destination ? join(destination, name) : undefined);
      }
      return;
    }
    if (!info.isFile()) fail("扩展运行资源只能包含普通文件和目录。");
    files += 1;
    totalBytes += info.size;
    if (files > MAX_ARCHIVE_FILES || totalBytes > MAX_UNPACKED_BYTES) fail("扩展运行资源超过允许大小。");
    if (destination) await copyCacheFile(source, destination);
  }
  await visit(root, copyTo);
  const manifest = JSON.parse((await readRegularFile(join(root, "manifest.json"))).toString("utf8"));
  return manifest;
}

function extensionLocationPath(location) {
  if (location === "extension") return join(CACHE_ROOT, "extension");
  const legacy = typeof location === "string" && location.match(/^legacy:(.+)$/);
  if (legacy && parseVersion(legacy[1])) return join(LEGACY_CACHE_ROOT, legacy[1], "assets", "extension");
  fail("扩展加载目录记录无效。");
}

async function assertPrivateExtensionLocation(location) {
  if (process.platform !== "win32") return;
  if (location === "extension") return;
  const legacy = typeof location === "string" && location.match(/^legacy:(.+)$/);
  if (!legacy || !parseVersion(legacy[1])) fail("扩展加载目录记录无效。");
  const versionRoot = join(LEGACY_CACHE_ROOT, legacy[1]);
  await assertWindowsPrivatePath(versionRoot, { directory: true });
  await assertWindowsPrivatePath(join(versionRoot, "assets"), { directory: true });
  await assertWindowsPrivatePath(join(versionRoot, "assets", "extension"), { directory: true });
}

async function readCurrentMarker({ missingOk = false } = {}) {
  const markerPath = join(CACHE_ROOT, "current.json");
  try {
    await assertRegularFile(markerPath);
    if (process.platform === "win32") await assertWindowsPrivatePath(markerPath);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (
      !isRecord(marker) || Object.keys(marker).length !== 3 ||
      !parseVersion(marker.version) || marker.runtimeProtocol !== RUNTIME_PROTOCOL ||
      !(marker.extensionLocation === "extension" ||
        (typeof marker.extensionLocation === "string" && /^legacy:.+$/.test(marker.extensionLocation)))
    ) fail("运行资源缓存标记无效，已保留原文件。");
    extensionLocationPath(marker.extensionLocation);
    return marker;
  } catch (error) {
    if (error.code === "ENOENT" && missingOk) return null;
    throw error;
  }
}

async function chooseExtensionLocation() {
  const current = await readCurrentMarker({ missingOk: true });
  if (current) return current.extensionLocation;

  const legacyMarkerPath = join(LEGACY_CACHE_ROOT, "current.json");
  let legacyMarker;
  try {
    await assertRegularFile(legacyMarkerPath);
    if (process.platform === "win32") await assertWindowsPrivatePath(legacyMarkerPath);
    legacyMarker = JSON.parse(await readFile(legacyMarkerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "extension";
    throw error;
  }
  if (!isRecord(legacyMarker) || Object.keys(legacyMarker).length !== 2 ||
      !parseVersion(legacyMarker.version) || legacyMarker.runtimeProtocol !== 1) {
    fail("旧运行资源缓存无法安全迁移，请保留现有扩展并检查缓存标记。");
  }
  const legacyPath = join(LEGACY_CACHE_ROOT, legacyMarker.version, "assets", "extension");
  await assertPrivateExtensionLocation("legacy:" + legacyMarker.version);
  const info = await lstat(legacyPath);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("旧扩展加载目录无效，已保留现有资源。");
  const manifest = await inspectExtensionTree(legacyPath);
  if (manifest.version !== legacyMarker.version) fail("旧扩展加载目录与缓存版本不一致，已保留现有资源。");
  return "legacy:" + legacyMarker.version;
}

async function writeCurrentVersion(version, extensionLocation) {
  await readCurrentMarker({ missingOk: true });
  const markerPath = join(CACHE_ROOT, "current.json");
  const tempPath = join(CACHE_ROOT, ".current-" + randomUUID() + ".tmp");
  try {
    await writeCacheFile(tempPath, Buffer.from(JSON.stringify({
      version,
      runtimeProtocol: RUNTIME_PROTOCOL,
      extensionLocation,
    }) + "\n"));
    if (process.platform === "darwin") await chmod(tempPath, 0o600);
    await rename(tempPath, markerPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function replaceExtensionAssets(source, location, version) {
  const destination = extensionLocationPath(location);
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  await assertPrivateExtensionLocation(location);
  const sourceManifest = await inspectExtensionTree(source);
  if (sourceManifest.version !== version) fail("扩展运行资源版本与 Skill 版本不一致。");
  if (sourcePath === destinationPath) {
    return { path: destination, commit: async () => {}, rollback: async () => {}, changed: false };
  }

  let destinationInfo;
  try { destinationInfo = await lstat(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) fail("扩展加载目录无效，已保留现有资源。");
    if (process.platform === "win32") await assertWindowsPrivatePath(destination, { directory: true });
    const currentManifest = await inspectExtensionTree(destination);
    if (currentManifest.key !== sourceManifest.key) {
      fail("新扩展会改变当前加载目录的扩展 ID，已保留现有资源。");
    }
    if (currentManifest.version === version) {
      return { path: destination, commit: async () => {}, rollback: async () => {}, changed: false };
    }
  }

  const parent = dirname(destination);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail("扩展加载目录无效，已保留现有资源。");
  await assertPrivateCacheDirectory(parent);
  const stage = join(parent, ".extension-stage-" + randomUUID());
  const backup = destinationInfo ? join(parent, ".extension-previous-" + randomUUID()) : null;
  try {
    await inspectExtensionTree(source, stage);
    const stagedManifest = JSON.parse((await readRegularFile(join(stage, "manifest.json"))).toString("utf8"));
    if (stagedManifest.version !== version || stagedManifest.key !== sourceManifest.key) {
      fail("扩展运行资源暂存校验失败。");
    }
    if (backup) await rename(destination, backup);
    try {
      await rename(stage, destination);
    } catch (error) {
      if (backup) await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return {
    path: destination,
    changed: true,
    commit: async () => {
      if (backup) await rm(backup, { recursive: true, force: true });
    },
    rollback: async () => {
      await rm(destination, { recursive: true, force: true });
      if (backup) await rename(backup, destination);
    },
  };
}

async function prepareFromRelease() {
  const { version, archive, checksums } = await latestRelease();
  const destination = join(CACHE_ROOT, version);
  let runtime;
  let destinationInfo;
  try { destinationInfo = await lstat(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
      fail("同版本运行资源缓存不是普通目录，已保留原数据。");
    }
    runtime = await readRuntime(destination, version, { requirePrivate: true });
  } else {
    const tag = "v" + version;
    const releaseBase = RELEASE_DOWNLOADS + "/" + tag;
    const archiveName = archive.name;
    const [sumsBytes, archiveBytes] = await Promise.all([
      fetchBytes(releaseBase + "/SHA256SUMS", {
        maxBytes: 64 * 1024,
        expectedSize: checksums.size,
        contentTypes: ["text/plain", "application/octet-stream"],
      }),
      fetchBytes(releaseBase + "/" + archiveName, {
        expectedSize: archive.size,
        contentTypes: ["application/gzip", "application/x-gzip", "application/octet-stream"],
      }),
    ]);
    const expectedHash = checksumFor(sumsBytes.toString("utf8"), archiveName);
    const actualHash = createHash("sha256").update(archiveBytes).digest("hex");
    if (actualHash !== expectedHash) fail("Skill TAR 包 SHA256 校验失败。");

    await ensureCacheRoot();
    const stage = await mkdtemp(join(CACHE_ROOT, ".prepare-" + version + "-"));
    try {
      await secureNewCacheDirectory(stage);
      const payload = join(stage, "payload");
      await unpackSkillArchive(archiveBytes, payload);
      const source = join(payload, "weixin-channels-video");
      runtime = await readRuntime(source, version, { requirePrivate: true });
      await rename(source, destination);
      runtime = { ...runtime, runtimeCLI: join(destination, "scripts", "cli.mjs"), extensionAssets: join(destination, "assets", "extension") };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  await ensureCacheRoot();
  return materializeRuntime(runtime);
}

async function cachePackagedRuntime(runtime) {
  const destination = join(CACHE_ROOT, runtime.version);
  let destinationInfo;
  try { destinationInfo = await lstat(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
      fail("同版本运行资源缓存不是普通目录，已保留原数据。");
    }
    return readRuntime(destination, runtime.version, { requirePrivate: true });
  }

  const stage = await mkdtemp(join(CACHE_ROOT, ".package-" + runtime.version + "-"));
  try {
    await secureNewCacheDirectory(stage);
    const scripts = join(stage, "scripts");
    const assets = join(stage, "assets");
    await ensureNewCacheDirectory(scripts);
    await ensureNewCacheDirectory(assets);
    await copyCacheFile(join(SKILL_ROOT, "runtime.json"), join(stage, "runtime.json"));
    await copyCacheFile(runtime.runtimeCLI, join(scripts, "cli.mjs"));
    await copyCacheFile(join(dirname(runtime.runtimeCLI), "native-host.mjs"), join(scripts, "native-host.mjs"));
    await inspectExtensionTree(runtime.extensionAssets, join(assets, "extension"));
    await readRuntime(stage, runtime.version, { requirePrivate: true });

    try {
      await rename(stage, destination);
    } catch (error) {
      let existing;
      try { existing = await lstat(destination); }
      catch { throw error; }
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw error;
    }
    return readRuntime(destination, runtime.version, { requirePrivate: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function materializeRuntime(runtime, { writeMarker = writeCurrentVersion } = {}) {
  const previous = await readCurrentMarker({ missingOk: true });
  const extensionLocation = previous?.extensionLocation ?? await chooseExtensionLocation();
  const extension = await replaceExtensionAssets(runtime.extensionAssets, extensionLocation, runtime.version);
  if (
    extension.changed || !previous || previous.version !== runtime.version ||
    previous.extensionLocation !== extensionLocation
  ) {
    try {
      await writeMarker(runtime.version, extensionLocation);
    } catch (error) {
      await extension.rollback();
      throw error;
    }
  }
  await extension.commit();
  return {
    ...runtime,
    extensionAssets: extension.path,
  };
}

async function packagedRuntime() {
  try { await lstat(join(SKILL_ROOT, "runtime.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const runtime = await readRuntime(SKILL_ROOT);
  await ensureCacheRoot();
  return cachePackagedRuntime(runtime);
}

async function currentRuntime() {
  const bundled = await packagedRuntime();
  if (bundled) {
    return materializeRuntime(bundled);
  }

  await ensureCacheRoot();
  const marker = await readCurrentMarker({ missingOk: true });
  if (!marker) {
    return prepareFromRelease();
  }
  const runtimeRoot = join(CACHE_ROOT, marker.version);
  const runtimeInfo = await lstat(runtimeRoot);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) fail("当前运行资源缓存目录无效。");
  const runtime = await readRuntime(runtimeRoot, marker.version, { requirePrivate: true });
  const extension = await replaceExtensionAssets(runtime.extensionAssets, marker.extensionLocation, marker.version);
  if (extension.changed) {
    try { await writeCurrentVersion(marker.version, marker.extensionLocation); }
    catch (error) { await extension.rollback(); throw error; }
  }
  await extension.commit();
  return {
    ...runtime,
    runtimeCLI: join(runtimeRoot, "scripts", "cli.mjs"),
    extensionAssets: extension.path,
  };
}

function execute(runtimeCLI, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runtimeCLI, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

export async function run(args = process.argv.slice(2)) {
  assertSupportedNode();
  if (args[0] === "prepare") {
    if (args.length !== 1) fail("Usage: run.mjs prepare");
    const bundled = await packagedRuntime();
    const runtime = bundled ? await materializeRuntime(bundled) : await prepareFromRelease();
    process.stdout.write(JSON.stringify(runtime) + "\n");
    return 0;
  }
  if (!args.length) fail("Usage: run.mjs prepare | <cli-command> [options]");
  const runtime = await currentRuntime();
  return execute(runtime.runtimeCLI, args);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
