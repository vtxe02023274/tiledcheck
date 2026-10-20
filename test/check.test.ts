import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as zlib from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkFile, type Diagnostic } from '../src/check.js';
import { run } from '../src/cli.js';

let dir: string;
const file = (name: string, content: string | Buffer) => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const rules = (ds: Diagnostic[]) => ds.map((d) => `${d.rule}: ${d.where}: ${d.message}`);

const TSX = `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" name="tiles" tilewidth="16" tileheight="16" tilecount="4" columns="2">
 <image source="tiles.png" width="32" height="32"/>
</tileset>`;

const tmx = (body: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" orientation="orthogonal" width="3" height="2" tilewidth="16" tileheight="16" infinite="0" nextobjectid="10"${extra}>
${body}
</map>`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tiledcheck-'));
  file('tiles.png', '');
  file('tiles.tsx', TSX);
  file('enemy.tx', '<template/>');
});

describe('clean maps', () => {
  it('accepts a CSV map with an external tileset', () => {
    const map = file(
      'ok.tmx',
      tmx(`<tileset firstgid="1" source="tiles.tsx"/>
 <layer id="1" name="Ground" width="3" height="2"><data encoding="csv">1,2,3,
4,0,2147483649</data></layer>
 <objectgroup id="2" name="Things"><object id="1" x="8" y="8" width="16" height="16"/>
  <object id="2" gid="2" x="16" y="32" width="16" height="16" template="enemy.tx"/></objectgroup>`),
    );
    expect(rules(checkFile(map))).toEqual([]);
  });

  it('accepts JSON maps with base64 zlib chunks on an infinite map', () => {
    const gids = Buffer.alloc(4 * 4);
    [1, 0, 3, 4].forEach((g, i) => gids.writeUInt32LE(g, i * 4));
    const map = file(
      'infinite.tmj',
      JSON.stringify({
        type: 'map',
        orientation: 'orthogonal',
        width: 2,
        height: 2,
        tilewidth: 16,
        tileheight: 16,
        infinite: true,
        tilesets: [{ firstgid: 1, source: 'tiles.tsx' }],
        layers: [
          {
            type: 'tilelayer',
            name: 'Ground',
            encoding: 'base64',
            compression: 'zlib',
            width: 2,
            height: 2,
            chunks: [
              { x: 0, y: 0, width: 2, height: 2, data: zlib.deflateSync(gids).toString('base64') },
            ],
          },
        ],
      }),
    );
    expect(rules(checkFile(map))).toEqual([]);
  });

  it('reads XML format chunks on an infinite map', () => {
    const map = file(
      'infinite-xml.tmx',
      tmx(
        `<tileset firstgid="1" source="tiles.tsx"/>
 <layer id="1" name="Ground" width="2" height="1"><data><chunk x="0" y="0" width="2" height="1"><tile gid="1"/><tile gid="99"/></chunk></data></layer>`,
        ' infinite="1"',
      ).replace(' infinite="0"', ''),
    );
    expect(rules(checkFile(map))).toEqual([
      "gid-out-of-range: layer 'Ground': gid 99 is not in any tileset, used in 1 cell",
    ]);
  });

  it('reads old JSON maps that keep tiles in an object keyed by id', () => {
    const map = file(
      'old-json.json',
      JSON.stringify({
        width: 1,
        height: 1,
        tilewidth: 16,
        tileheight: 16,
        orientation: 'orthogonal',
        tilesets: [
          {
            firstgid: 1,
            name: 'collection',
            tilecount: 2,
            tiles: { '0': { image: 'tiles.png' }, '1': { image: 'gone.png' } },
          },
        ],
        layers: [{ type: 'tilelayer', name: 'L', width: 1, height: 1, data: [2] }],
      }),
    );
    expect(rules(checkFile(map))).toEqual([
      "missing-image: tileset 'collection' (firstgid 1) tile 1: image gone.png does not exist",
    ]);
  });

  it('works out the tile count of old tilesets from the image size', () => {
    const map = file(
      'old.tmx',
      tmx(`<tileset firstgid="1" name="old" tilewidth="16" tileheight="16" spacing="1" margin="1">
  <image source="tiles.png" width="35" height="18"/></tileset>
 <layer name="L" width="3" height="2"><data encoding="csv">1,2,0,0,0,3</data></layer>`),
    );
    // (35 - 2 + 1) / 17 = 2 columns, (18 - 2 + 1) / 17 = 1 row: gid 3 is out of range.
    expect(rules(checkFile(map))).toEqual([
      "gid-out-of-range: layer 'L': gid 3 is not in any tileset, used in 1 cell",
    ]);
  });
});

describe('problems', () => {
  it('reports missing tilesets, images and templates', () => {
    const map = file(
      'missing.tmx',
      tmx(`<tileset firstgid="1" source="gone.tsx"/>
 <tileset firstgid="5" name="inline" tilewidth="16" tileheight="16" tilecount="1" columns="1"><image source="gone.png"/></tileset>
 <imagelayer id="3" name="Sky"><image source="sky.png"/></imagelayer>
 <objectgroup id="2" name="O"><object id="1" template="boss.tx" x="0" y="0"/></objectgroup>`),
    );
    expect(rules(checkFile(map))).toEqual([
      'missing-file: tileset (firstgid 1): gone.tsx does not exist',
      "missing-image: tileset 'inline' (firstgid 5): image gone.png does not exist",
      "missing-file: layer 'O' object 1: template boss.tx does not exist",
      "missing-image: layer 'Sky': image sky.png does not exist",
    ]);
  });

  it('reports gids no tileset covers, ignoring flip flags', () => {
    const map = file(
      'gids.tmx',
      tmx(`<tileset firstgid="1" source="tiles.tsx"/>
 <layer name="Ground" width="3" height="2"><data encoding="csv">1,5,5,${0x80000009},0,0</data></layer>
 <objectgroup name="O"><object id="3" gid="7" x="0" y="16" width="16" height="16"/></objectgroup>`),
    );
    expect(rules(checkFile(map))).toEqual([
      "gid-out-of-range: layer 'Ground': gid 5 is not in any tileset, used in 2 cells",
      "gid-out-of-range: layer 'Ground': gid 9 is not in any tileset, used in 1 cell",
      "gid-out-of-range: layer 'O' object 3: gid 7 is not in any tileset",
    ]);
  });

  it('reports overlapping tilesets and wrong layer sizes', () => {
    const map = file(
      'overlap.tmx',
      tmx(`<tileset firstgid="1" source="tiles.tsx"/>
 <tileset firstgid="3" source="tiles.tsx"/>
 <layer name="Short" width="3" height="2"><data encoding="csv">1,2,3</data></layer>`),
    );
    expect(rules(checkFile(map))).toEqual([
      "tileset-overlap: tileset 'tiles' (firstgid 3): gids 3-4 are also covered by tileset 'tiles' (firstgid 1)",
      "layer-size: layer 'Short': 3 tiles for a 3x2 layer (expected 6)",
    ]);
  });

  it('reports duplicate object ids, ids past nextobjectid and objects off the map', () => {
    const map = file(
      'objects.tmx',
      tmx(`<objectgroup name="A"><object id="1" x="0" y="0"/><object id="12" x="500" y="0" width="10" height="10"/></objectgroup>
 <group name="G"><objectgroup name="B"><object id="1" x="0" y="0"/></objectgroup></group>`),
    );
    expect(rules(checkFile(map))).toEqual([
      "next-object-id: layer 'A' object 12: id 12 is not below nextobjectid 10",
      "object-outside-map: layer 'A' object 12: at (500, 0), the map is 48x32 px",
      "duplicate-object-id: layer 'G/B' object 1: id 1 is also used in layer 'A'",
    ]);
  });

  it('warns when a tileset image is not the size the tileset says', () => {
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(48, 16);
    png.writeUInt32BE(32, 20);
    file('resized.png', png);
    const map = file(
      'resized.tmx',
      tmx(`<tileset firstgid="1" name="r" tilewidth="16" tileheight="16" tilecount="4" columns="2">
  <image source="resized.png" width="32" height="32"/></tileset>
<layer id="1" name="L" width="3" height="2"><data encoding="csv">1,0,0,0,0,0</data></layer>`),
    );
    expect(checkFile(map).map((d) => `${d.severity} ${d.rule}: ${d.message}`)).toEqual([
      'warning image-size: resized.png is 48x32 but the tileset says 32x32, open and save the tileset in Tiled to update it',
    ]);
  });

  it('uses the unrotated grid for objects on isometric maps', () => {
    // 4x4 tiles of 64x32: isometric object positions go up to 4 * 32 on both axes.
    const map = file(
      'iso-objects.tmx',
      `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" orientation="isometric" width="4" height="4" tilewidth="64" tileheight="32" infinite="0" nextobjectid="3">
<objectgroup id="1" name="O"><object id="1" x="100" y="120"/><object id="2" x="200" y="50"/></objectgroup>
</map>`,
    );
    expect(rules(checkFile(map))).toEqual([
      "object-outside-map: layer 'O' object 2: at (200, 50), the map is 128x128 px",
    ]);
  });

  it('warns about tilesets nothing in the map uses', () => {
    const tileset = (first: number, name: string) =>
      `<tileset firstgid="${first}" name="${name}" tilewidth="16" tileheight="16" tilecount="4" columns="2"><image source="tiles.png" width="32" height="32"/></tileset>`;
    const map = file(
      'unused.tmx',
      tmx(
        `${tileset(1, 'ground')}${tileset(5, 'items')}${tileset(9, 'spare')}
<layer id="1" name="L" width="3" height="2"><data encoding="csv">1,2,0,0,0,0</data></layer>
<objectgroup id="2" name="O"><object id="1" gid="2147483654" x="0" y="16" width="16" height="16"/></objectgroup>`,
      ),
    );
    // The object uses items (gid 6, flipped), only spare is unused.
    expect(rules(checkFile(map))).toEqual([
      "unused-tileset: tileset 'spare' (firstgid 9): no tile or object in this map uses it",
    ]);

    const withTemplate = file(
      'unused-template.tmx',
      tmx(
        `${tileset(1, 'ground')}<objectgroup id="1" name="O"><object id="1" template="enemy.tx" x="0" y="0"/></objectgroup>`,
      ),
    );
    // A template may bring a tile object from that tileset, so stay quiet.
    expect(rules(checkFile(withTemplate))).toEqual([]);
  });

  it('skips id checks for objects from maps older than object ids', () => {
    const map = file(
      'no-ids.tmx',
      tmx(
        '<objectgroup name="O"><object x="1" y="1"/><object name="p" x="2" y="2"/></objectgroup>',
      ),
    );
    expect(rules(checkFile(map))).toEqual([]);
  });

  it('reports terrain sets with more colors than Tiled loads', () => {
    const colors = Array.from(
      { length: 255 },
      (_, i) => `<wangcolor name="c${i}" color="#000000" tile="-1" probability="1"/>`,
    );
    const tsx = file(
      'terrain.tsx',
      `<tileset name="walls" tilewidth="16" tileheight="16" tilecount="4" columns="2"><image source="tiles.png"/>
 <wangsets><wangset name="Walls" type="corner" tile="-1">${colors.join('')}</wangset>
 <wangset name="Ok" type="corner" tile="-1"><wangcolor name="a" color="#000000" tile="-1" probability="1"/></wangset></wangsets></tileset>`,
    );
    expect(rules(checkFile(tsx))).toEqual([
      "terrain-colors: tileset 'walls' terrain set 'Walls': 255 colors, Tiled 1.10.2+ supports 254 and silently drops every terrain set of this tileset",
    ]);
  });

  it('reports files it cannot read', () => {
    expect(rules(checkFile(file('broken.tmj', '{ nope')))[0]).toMatch(
      /^load-error: file: invalid JSON/,
    );
    expect(rules(checkFile(file('broken.tmx', '<notamap/>')))).toEqual([
      'load-error: file: no <map> element',
    ]);
  });

  it('checks zstd compressed tile data when Node can decompress it', () => {
    const zstdCompress = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
    const gids = Buffer.alloc(6 * 4);
    [1, 5, 0, 0, 0, 0].forEach((g, i) => gids.writeUInt32LE(g, i * 4));
    const map = file(
      'zstd.tmx',
      tmx(
        `<tileset firstgid="1" source="tiles.tsx"/><tileset firstgid="5" source="tiles.tsx"/>
<layer name="Z" width="3" height="2"><data encoding="base64" compression="zstd">${zstdCompress ? zstdCompress(gids).toString('base64') : 'AAAA'}</data></layer>`,
      ),
    );
    expect(rules(checkFile(map))).toEqual(
      zstdCompress ? [] : ["tile-data: layer 'Z': zstd compressed tile data is not checked"],
    );
  });

  it('does not call tilesets unused when a layer cannot be decoded', () => {
    const map = file(
      'undecodable.tmx',
      tmx(
        `<tileset firstgid="1" source="tiles.tsx"/><tileset firstgid="5" source="tiles.tsx"/>
<layer name="Z" width="3" height="2"><data encoding="base64" compression="lzma">AAAA</data></layer>`,
      ),
    );
    expect(rules(checkFile(map))).toEqual(["tile-data: layer 'Z': unknown compression 'lzma'"]);
  });
});

describe('worlds', () => {
  it('checks every map in a world and reports missing and overlapping maps', () => {
    file(
      'world/a.tmx',
      tmx('<layer name="L" width="3" height="2"><data encoding="csv">9,0,0,0,0,0</data></layer>'),
    );
    file('world/b.tmx', tmx(''));
    const world = file(
      'world/test.world',
      JSON.stringify({
        type: 'world',
        maps: [
          { fileName: 'a.tmx', x: 0, y: 0, width: 48, height: 32 },
          { fileName: 'b.tmx', x: 40, y: 0, width: 48, height: 32 },
          { fileName: 'gone.tmx', x: 200, y: 0, width: 48, height: 32 },
        ],
      }),
    );
    expect(rules(checkFile(world))).toEqual([
      "gid-out-of-range: layer 'L': gid 9 is not in any tileset, used in 1 cell",
      'missing-file: map gone.tmx: gone.tmx does not exist',
      'world-overlap: map b.tmx: overlaps a.tmx',
    ]);
  });
});

describe('cli', () => {
  it('walks folders, sets the exit code and can print JSON', () => {
    const sub = join(dir, 'cli');
    file(
      'cli/a.tmx',
      tmx('<layer name="L" width="3" height="2"><data encoding="csv">0,0,0,0,0,0</data></layer>'),
    );
    file('cli/nested/b.tmj', '{ broken');
    let out = '';
    expect(run([sub], (s) => (out += s))).toBe(1);
    expect(out).toMatch(/2 files checked, 1 error, 0 warnings/);

    out = '';
    expect(run([sub, '--json', '--ignore', 'load-error'], (s) => (out += s))).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ files: 2, errors: 0, diagnostics: [] });
  });

  it('reports a problem once when a folder holds a world and its maps', () => {
    file(
      'cli-world/a.tmx',
      tmx('<layer name="L" width="3" height="2"><data encoding="csv">9,0,0,0,0,0</data></layer>'),
    );
    file(
      'cli-world/w.world',
      JSON.stringify({ type: 'world', maps: [{ fileName: 'a.tmx', x: 0, y: 0 }] }),
    );
    let out = '';
    expect(
      run([relative(process.cwd(), join(dir, 'cli-world')), '--json'], (s) => (out += s)),
    ).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ files: 2, errors: 1 });
  });

  it('prints GitHub Actions annotations', () => {
    const map = file('gh/a.tmx', tmx('<tileset firstgid="1" source="x,y.tsx"/>'));
    let out = '';
    expect(run([map, '--github'], (s) => (out += s))).toBe(1);
    expect(out).toMatch(
      /^::error file=.*a\.tmx,title=missing-file::tileset \(firstgid 1\): x,y\.tsx does not exist\n$/,
    );
  });

  it('rejects unknown rules and missing paths', () => {
    let out = '';
    expect(run(['x', '--ignore', 'nope'], (s) => (out += s))).toBe(2);
    expect(run([join(dir, 'does-not-exist')], (s) => (out += s))).toBe(2);
  });
});
