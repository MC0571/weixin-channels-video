import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function publishStream(source, outputPath) {
  const tempDir = await mkdtemp(join(dirname(outputPath), '.weixin-channels-video-'));
  const tempPath = join(tempDir, randomUUID());
  let bytes = 0;
  try {
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(source, counter, createWriteStream(tempPath, { flags: 'wx' }));
    if (bytes === 0) throw new Error('Media response was empty.');
    await link(tempPath, outputPath);
    return { path: outputPath, bytes };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function saveMedia(url, outputPath, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`Media request failed with HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.startsWith('text/') || contentType.includes('json')) {
    await response.body.cancel();
    throw new Error('Media request returned a text response.');
  }
  return publishStream(Readable.fromWeb(response.body), outputPath);
}

export async function saveExistingFile(sourcePath, outputPath) {
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size === 0) throw new Error('Source media file is empty or unavailable.');
  return publishStream(createReadStream(sourcePath), outputPath);
}
