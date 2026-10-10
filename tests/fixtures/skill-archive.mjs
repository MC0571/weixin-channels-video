import { gzipSync } from 'node:zlib';

function writeOctal(buffer, start, length, value) {
  Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0', 'ascii').copy(buffer, start);
}

export function tarEntry(name, contents = '', type = '0') {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0);
  writeOctal(header, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === '5' ? 0 : data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
  const padding = Buffer.alloc((512 - data.length % 512) % 512);
  return Buffer.concat([header, data, padding]);
}

export function skillArchive(entries) {
  return gzipSync(Buffer.concat([
    ...entries.map(([name, contents, type]) => tarEntry(name, contents, type)),
    Buffer.alloc(1024),
  ]));
}
