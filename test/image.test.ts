import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/image.js';

const dir = mkdtempSync(join(tmpdir(), 'tiledcheck-img-'));
const write = (name: string, bytes: Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

describe('imageSize', () => {
  it('reads GIF, BMP and JPEG headers', () => {
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(300, 6);
    gif.writeUInt16LE(200, 8);
    expect(imageSize(write('a.gif', gif))).toEqual({ width: 300, height: 200 });

    const bmp = Buffer.alloc(54);
    bmp.write('BM', 0, 'ascii');
    bmp.writeInt32LE(64, 18);
    bmp.writeInt32LE(-32, 22); // top-down bitmaps store a negative height
    expect(imageSize(write('a.bmp', bmp))).toEqual({ width: 64, height: 32 });

    // SOI, an APP0 segment to skip, then a baseline SOF0.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x60,
      0x00, 0x80, 0x03,
    ]);
    expect(imageSize(write('a.jpg', Buffer.concat([jpeg, Buffer.alloc(16)])))).toEqual({
      width: 128,
      height: 96,
    });
  });

  it('reads OS/2 bitmaps and JPEG markers after fill bytes', () => {
    const os2 = Buffer.alloc(26);
    os2.write('BM', 0, 'ascii');
    os2.writeUInt32LE(12, 14);
    os2.writeUInt16LE(64, 18);
    os2.writeUInt16LE(32, 20);
    os2.writeUInt16LE(1, 22);
    os2.writeUInt16LE(24, 24);
    expect(imageSize(write('os2.bmp', os2))).toEqual({ width: 64, height: 32 });

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x60, 0x00, 0x80, 0x03,
    ]);
    expect(imageSize(write('fill.jpg', Buffer.concat([jpeg, Buffer.alloc(16)])))).toEqual({
      width: 128,
      height: 96,
    });
  });

  it('returns undefined for formats it does not know', () => {
    expect(imageSize(write('a.webp', Buffer.from('RIFF....WEBP')))).toBeUndefined();
  });
});
