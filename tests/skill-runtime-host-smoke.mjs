import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startNativeHost } from "../dist/weixin-channels-video/scripts/native-host.mjs";

const extensionId = "a".repeat(32);
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const root = await mkdtemp(join(tmpdir(), "wcv-host-"));
const configPath = join(root, "bridge.json");
const input = new PassThrough();
const output = new PassThrough();
let buffered = Buffer.alloc(0);
let pending;
const queued = [];

output.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < length + 4) break;
    const message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    if (pending) {
      pending.resolve(message);
      pending = undefined;
    } else queued.push(message);
  }
});

function nextMessage() {
  if (queued.length) return Promise.resolve(queued.shift());
  return new Promise((resolve, reject) => { pending = { resolve, reject }; });
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

let host;
try {
  await writeFile(configPath, JSON.stringify({
    version: 1,
    hostName: "com.mc0571.weixin_channels_video",
    extensionId,
    appSupportDir: root,
  }));
  await writeFile(join(root, "session.json"), JSON.stringify({ version: 1, sessionId }));
  host = await startNativeHost({
    configPath,
    extensionOrigin: "chrome-extension://" + extensionId + "/",
    input,
    output,
  });
  const readyMessage = nextMessage();
  let timeout;
  input.write(frame({ type: "hello", version: 1, sessionId }));
  try {
    assert.deepEqual(await Promise.race([
      readyMessage,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Native host did not send its ready frame.")), 10000); }),
    ]), { type: "ready", version: 1 });
  } finally {
    clearTimeout(timeout);
  }
  await host.close();
  host = undefined;
} finally {
  if (host) await host.close();
  await rm(root, { recursive: true, force: true });
}
