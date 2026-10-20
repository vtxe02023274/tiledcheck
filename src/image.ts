import { closeSync, openSync, readSync } from 'node:fs';

/**
 * Reads the pixel size from the header of a PNG, GIF, BMP or JPEG file
 * without decoding it. Returns undefined for other formats.
 */
export function imageSize(path: string): { width: number; height: number } | undefined {
  const head = Buffer.alloc(64 * 1024);
  let length: number;
  const fd = openSync(path, 'r');
  try {
    length = readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const b = head.subarray(0, length);

  if (
    b.length >= 24 &&
    b.readUInt32BE(0) === 0x89504e47 &&
    b.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments to the first start-of-frame marker.
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return undefined;
      const marker = b[o + 1]!;
      const size = b.readUInt16BE(o + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5) };
      }
      o += 2 + size;
    }
  }
  return undefined;
}
