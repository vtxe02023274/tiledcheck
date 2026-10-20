import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type {
  Layer,
  MapObject,
  TiledMap,
  Tileset,
  TilesetRef,
  TileLayer,
  WangSet,
} from './model.js';

export class LoadError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any -- parsed files are untyped by nature */

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    [
      'tileset',
      'layer',
      'objectgroup',
      'imagelayer',
      'group',
      'object',
      'tile',
      'wangset',
      'wangcolor',
      'chunk',
    ].includes(name),
});

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new LoadError(`cannot read file: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
}

function isJson(file: string): boolean {
  return ['.tmj', '.tsj', '.json', '.tj'].includes(extname(file).toLowerCase());
}

export function loadMap(file: string): TiledMap {
  const text = readText(file);
  return isJson(file) ? mapFromJson(file, parseJson(text)) : mapFromXml(file, text);
}

export function loadTileset(file: string): Tileset {
  const text = readText(file);
  if (isJson(file)) return tilesetFromJson(file, parseJson(text));
  const doc = xml.parse(text);
  const ts = doc.tileset?.[0];
  if (!ts) throw new LoadError('no <tileset> element');
  return tilesetFromXml(file, ts);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LoadError(`invalid JSON: ${(err as Error).message}`);
  }
}

/** Resolves an external reference the way Tiled does: relative to the referring file. */
export function resolveRef(from: string, ref: string): string {
  return resolve(dirname(from), ref);
}

function loadTilesetRef(
  mapFile: string,
  firstGid: number,
  source: string | undefined,
  inline: () => Tileset,
): TilesetRef {
  if (!source) return { firstGid, tileset: inline() };
  const path = resolveRef(mapFile, source);
  if (!existsSync(path)) return { firstGid, source };
  try {
    return { firstGid, source, tileset: loadTileset(path) };
  } catch {
    return { firstGid, source };
  }
}

/**
 * Old files often leave out tilecount. Work it out from the image the same
 * way Tiled does, or leave it unknown.
 */
function tileCountOf(
  count: unknown,
  imageWidth: unknown,
  imageHeight: unknown,
  tileWidth: unknown,
  tileHeight: unknown,
  margin: unknown,
  spacing: unknown,
): number | undefined {
  if (count !== undefined && count !== '') return num(count);
  const iw = num(imageWidth);
  const ih = num(imageHeight);
  const tw = num(tileWidth);
  const th = num(tileHeight);
  if (!iw || !ih || !tw || !th) return undefined;
  const m = num(margin);
  const sp = num(spacing);
  const cols = Math.floor((iw - 2 * m + sp) / (tw + sp));
  const rows = Math.floor((ih - 2 * m + sp) / (th + sp));
  return Math.max(0, cols) * Math.max(0, rows);
}

// --- JSON -------------------------------------------------------------------

function mapFromJson(file: string, j: any): TiledMap {
  if (j?.type !== 'map' && j?.tilesets === undefined) throw new LoadError('not a Tiled JSON map');
  return {
    file,
    orientation: j.orientation ?? 'orthogonal',
    width: num(j.width),
    height: num(j.height),
    tileWidth: num(j.tilewidth),
    tileHeight: num(j.tileheight),
    infinite: !!j.infinite,
    nextObjectId: j.nextobjectid === undefined ? undefined : num(j.nextobjectid),
    tilesets: (j.tilesets ?? []).map((t: any) =>
      loadTilesetRef(file, num(t.firstgid), t.source, () => tilesetFromJson(file, t)),
    ),
    layers: (j.layers ?? []).map((l: any) => layerFromJson(l, !!j.infinite)),
  };
}

function tilesetFromJson(file: string, t: any): Tileset {
  return {
    file,
    name: t.name ?? '',
    tileCount: tileCountOf(
      t.tilecount,
      t.imagewidth,
      t.imageheight,
      t.tilewidth,
      t.tileheight,
      t.margin,
      t.spacing,
    ),
    image: t.image,
    imageWidth: t.imagewidth === undefined ? undefined : num(t.imagewidth),
    imageHeight: t.imageheight === undefined ? undefined : num(t.imageheight),
    tileImages: jsonTiles(t.tiles)
      .filter((tile: any) => tile.image)
      .map((tile: any) => ({ id: num(tile.id), image: tile.image })),
    wangSets: (t.wangsets ?? []).map((w: any): WangSet => ({
      name: w.name ?? '',
      colorCount: (w.colors ?? []).length,
    })),
  };
}

/**
 * Tiled before 1.2 stored tiles as an object keyed by tile id instead of an
 * array, and Phaser and other tools still ship maps like that.
 */
function jsonTiles(tiles: unknown): any[] {
  if (Array.isArray(tiles)) return tiles;
  if (tiles && typeof tiles === 'object') {
    return Object.entries(tiles).map(([id, tile]) => ({ id: num(id), ...(tile as object) }));
  }
  return [];
}

function layerFromJson(l: any, infinite: boolean): Layer {
  const base = { name: l.name ?? '', id: l.id === undefined ? undefined : num(l.id) };
  switch (l.type) {
    case 'group':
      return {
        ...base,
        kind: 'group',
        layers: (l.layers ?? []).map((c: any) => layerFromJson(c, infinite)),
      };
    case 'objectgroup':
      return { ...base, kind: 'objects', objects: (l.objects ?? []).map(objectFromJson) };
    case 'imagelayer':
      return { ...base, kind: 'image', image: l.image || undefined };
    default: {
      const layer: TileLayer = {
        ...base,
        kind: 'tile',
        width: num(l.width),
        height: num(l.height),
      };
      try {
        if (infinite && l.chunks) {
          layer.gids = l.chunks.flatMap((c: any) => decodeData(c.data, l.encoding, l.compression));
        } else {
          layer.gids = decodeData(l.data, l.encoding, l.compression);
          layer.dataLength = layer.gids.length;
        }
      } catch (err) {
        layer.dataProblem = (err as Error).message;
      }
      return layer;
    }
  }
}

function objectFromJson(o: any): MapObject {
  return {
    id: o.id === undefined ? undefined : num(o.id),
    name: o.name ?? '',
    gid: o.gid === undefined ? undefined : num(o.gid),
    template: o.template,
    x: num(o.x),
    y: num(o.y),
    width: num(o.width),
    height: num(o.height),
  };
}

// --- XML --------------------------------------------------------------------

function mapFromXml(file: string, text: string): TiledMap {
  let doc: any;
  try {
    doc = xml.parse(text, true);
  } catch (err) {
    throw new LoadError(`invalid XML: ${(err as Error).message}`);
  }
  const m = doc.map;
  if (!m) throw new LoadError('no <map> element');
  const infinite = m.infinite === '1';
  return {
    file,
    orientation: m.orientation ?? 'orthogonal',
    width: num(m.width),
    height: num(m.height),
    tileWidth: num(m.tilewidth),
    tileHeight: num(m.tileheight),
    infinite,
    nextObjectId: m.nextobjectid === undefined ? undefined : num(m.nextobjectid),
    tilesets: (m.tileset ?? []).map((t: any) =>
      loadTilesetRef(file, num(t.firstgid), t.source, () => tilesetFromXml(file, t)),
    ),
    layers: layersFromXml(m, infinite),
  };
}

function tilesetFromXml(file: string, t: any): Tileset {
  return {
    file,
    name: t.name ?? '',
    tileCount: tileCountOf(
      t.tilecount,
      t.image?.width,
      t.image?.height,
      t.tilewidth,
      t.tileheight,
      t.margin,
      t.spacing,
    ),
    image: t.image?.source,
    imageWidth: t.image?.width === undefined ? undefined : num(t.image.width),
    imageHeight: t.image?.height === undefined ? undefined : num(t.image.height),
    tileImages: (t.tile ?? [])
      .filter((tile: any) => tile.image?.source)
      .map((tile: any) => ({ id: num(tile.id), image: tile.image.source })),
    wangSets: (t.wangsets?.wangset ?? []).map((w: any): WangSet => ({
      name: w.name ?? '',
      colorCount: (w.wangcolor ?? []).length,
    })),
  };
}

function layersFromXml(parent: any, infinite: boolean): Layer[] {
  const layers: Layer[] = [];
  const base = (l: any) => ({ name: l.name ?? '', id: l.id === undefined ? undefined : num(l.id) });
  for (const l of parent.layer ?? []) {
    const layer: TileLayer = {
      ...base(l),
      kind: 'tile',
      width: num(l.width),
      height: num(l.height),
    };
    const data = l.data;
    try {
      if (data?.chunk) {
        layer.gids = data.chunk.flatMap((c: any) =>
          c.tile
            ? c.tile.map((t: any) => num(t.gid))
            : decodeData(text(c), data.encoding, data.compression),
        );
      } else if (data?.tile) {
        // Plain XML format: one <tile gid=""/> per cell.
        const gids: number[] = data.tile.map((t: any) => num(t.gid));
        layer.gids = gids;
        layer.dataLength = gids.length;
      } else {
        layer.gids = decodeData(text(data), data?.encoding, data?.compression);
        if (!infinite) layer.dataLength = layer.gids.length;
      }
    } catch (err) {
      layer.dataProblem = (err as Error).message;
    }
    layers.push(layer);
  }
  for (const g of parent.objectgroup ?? []) {
    layers.push({
      ...base(g),
      kind: 'objects',
      objects: (g.object ?? []).map((o: any) => ({
        id: o.id === undefined ? undefined : num(o.id),
        name: o.name ?? '',
        gid: o.gid === undefined ? undefined : num(o.gid),
        template: o.template,
        x: num(o.x),
        y: num(o.y),
        width: num(o.width),
        height: num(o.height),
      })),
    });
  }
  for (const i of parent.imagelayer ?? []) {
    layers.push({ ...base(i), kind: 'image', image: i.image?.source });
  }
  for (const g of parent.group ?? []) {
    layers.push({ ...base(g), kind: 'group', layers: layersFromXml(g, infinite) });
  }
  return layers;
}

function text(node: any): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  return String(node['#text'] ?? '');
}

// --- tile data --------------------------------------------------------------

function decodeData(data: unknown, encoding?: string, compression?: string): number[] {
  if (Array.isArray(data)) return data.map((v) => num(v));
  if (data === undefined || data === null || data === '') return [];
  const s = String(data).trim();
  if (encoding === 'csv') {
    return s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => num(v));
  }
  if (encoding !== 'base64') throw new Error(`unknown tile data encoding '${encoding}'`);
  let bytes = Buffer.from(s, 'base64');
  if (compression === 'zlib') bytes = inflateSync(bytes);
  else if (compression === 'gzip') bytes = gunzipSync(bytes);
  else if (compression === 'zstd') throw new Error('zstd compressed tile data is not checked');
  else if (compression) throw new Error(`unknown compression '${compression}'`);
  const gids: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) gids.push(bytes.readUInt32LE(i));
  return gids;
}
