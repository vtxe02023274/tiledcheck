import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { imageSize } from './image.js';
import { readFileSync } from 'node:fs';
import { LoadError, loadMap, loadTileset, resolveRef } from './load.js';
import { allLayers, GID_MASK, type TiledMap, type Tileset } from './model.js';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  rule: string;
  file: string;
  /** Where in the file, e.g. "layer 'Ground'" or "tileset 'terrain' (firstgid 1)". */
  where: string;
  message: string;
}

/** Tiled 1.10.2 and later keep at most 254 colors per terrain set. */
export const MAX_TERRAIN_COLORS = 254;

export const RULES: Record<string, string> = {
  'load-error': 'The file cannot be read or parsed',
  'missing-file': 'An external tileset or object template does not exist',
  'missing-image': 'A tileset or image layer image does not exist',
  'image-size': 'A tileset image is not the size the tileset says, so tile ids shift',
  'gid-out-of-range': 'A tile refers to a gid that no tileset covers',
  'tileset-overlap': 'Two tilesets claim the same gid range',
  'terrain-colors': 'A terrain set has more colors than Tiled can load',
  'layer-size': 'A tile layer has a different number of tiles than its size',
  'tile-data': 'Tile data cannot be decoded',
  'duplicate-object-id': 'Two objects share an id',
  'next-object-id': 'An object id is not below the map nextobjectid',
  'object-outside-map': 'An object lies completely outside the map',
  'world-overlap': 'Two maps in a world are placed on top of each other',
  'unused-tileset': 'No tile or object in the map uses a tileset',
};

export function checkFile(file: string): Diagnostic[] {
  const ext = extname(file).toLowerCase();
  let map: TiledMap;
  try {
    if (ext === '.world') return checkWorld(file);
    if (ext === '.tsx' || ext === '.tsj') {
      const ts = loadTileset(file);
      const out: Diagnostic[] = [];
      checkTileset(ts, `tileset '${ts.name}'`, (d) => out.push(d));
      return out;
    }
    map = loadMap(file);
  } catch (err) {
    // Files in the wild have every shape imaginable; report instead of crashing.
    const message =
      err instanceof LoadError ? err.message : `cannot parse: ${(err as Error).message}`;
    return [{ severity: 'error', rule: 'load-error', file, where: 'file', message }];
  }
  return checkMap(map);
}

export function checkMap(map: TiledMap): Diagnostic[] {
  const out: Diagnostic[] = [];
  const report = (
    severity: Severity,
    rule: string,
    where: string,
    message: string,
    file = map.file,
  ) => out.push({ severity, rule, file, where, message });

  // --- tilesets
  const ranges: { first: number; last: number; where: string }[] = [];
  for (const ref of map.tilesets) {
    const where = `tileset ${ref.tileset?.name ? `'${ref.tileset.name}' ` : ''}(firstgid ${ref.firstGid})`;
    if (ref.source && !ref.tileset) {
      const exists = existsSync(resolveRef(map.file, ref.source));
      report(
        'error',
        exists ? 'load-error' : 'missing-file',
        where,
        exists ? `cannot load ${ref.source}` : `${ref.source} does not exist`,
      );
      continue;
    }
    const ts = ref.tileset!;
    checkTileset(ts, ts.file === map.file ? where : `tileset '${ts.name}'`, (d) => out.push(d));
    // Collection tilesets can have gaps in their ids, so use the largest id.
    // An unknown count reaches up to the next tileset, which is how Tiled maps gids.
    const count =
      ts.tileCount === undefined
        ? undefined
        : Math.max(ts.tileCount, ...ts.tileImages.map((t) => t.id + 1));
    ranges.push({
      first: ref.firstGid,
      last: count === undefined ? Infinity : ref.firstGid + count - 1,
      where,
    });
  }
  for (const r of ranges) {
    if (r.last !== Infinity) continue;
    const next = ranges.filter((o) => o.first > r.first).map((o) => o.first);
    r.last = next.length ? Math.min(...next) - 1 : Infinity;
  }
  const sorted = [...ranges].sort((a, b) => a.first - b.first);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.first <= sorted[i - 1]!.last) {
      report(
        'error',
        'tileset-overlap',
        sorted[i]!.where,
        `gids ${sorted[i]!.first}-${sorted[i - 1]!.last} are also covered by ${sorted[i - 1]!.where}`,
      );
    }
  }
  // Tilesets that failed to load cannot be checked against, so skip gid checks for them.
  const unknownRanges = map.tilesets.some((t) => !t.tileset);
  const covered = (gid: number) =>
    unknownRanges || ranges.some((r) => gid >= r.first && gid <= r.last);

  // --- layers and objects
  const used = new Set<number>();
  let usageKnown = true;
  const objectIds = new Map<number, string>();
  // Isometric maps store object positions on the unrotated grid, where a
  // tile is tileHeight wide on both axes.
  const isometric = map.orientation === 'isometric';
  const boundsKnown = map.orientation === 'orthogonal' || isometric;
  const mapWidth = map.width * (isometric ? map.tileHeight : map.tileWidth);
  const mapHeight = map.height * map.tileHeight;

  for (const { layer, path } of allLayers(map.layers)) {
    const where = `layer '${path}'`;
    switch (layer.kind) {
      case 'tile': {
        if (!layer.gids) usageKnown = false;
        if (layer.dataProblem) {
          report(
            layer.dataProblem.includes('not checked') ? 'warning' : 'error',
            'tile-data',
            where,
            layer.dataProblem,
          );
          break;
        }
        if (
          !map.infinite &&
          layer.dataLength !== undefined &&
          layer.dataLength !== layer.width * layer.height
        ) {
          report(
            'error',
            'layer-size',
            where,
            `${layer.dataLength} tiles for a ${layer.width}x${layer.height} layer (expected ${layer.width * layer.height})`,
          );
        }
        const bad = new Map<number, number>();
        for (const raw of layer.gids ?? []) {
          const gid = raw & GID_MASK;
          if (gid) used.add(gid);
          if (gid && !covered(gid)) bad.set(gid, (bad.get(gid) ?? 0) + 1);
        }
        for (const [gid, count] of bad) {
          report(
            'error',
            'gid-out-of-range',
            where,
            `gid ${gid} is not in any tileset, used in ${count} cell${count > 1 ? 's' : ''}`,
          );
        }
        break;
      }
      case 'objects':
        for (const o of layer.objects) {
          const label = o.id !== undefined ? `object ${o.id}` : `object at (${o.x}, ${o.y})`;
          const ow = `${where} ${label}${o.name ? ` '${o.name}'` : ''}`;
          if (o.id !== undefined) {
            const seen = objectIds.get(o.id);
            if (seen !== undefined)
              report('error', 'duplicate-object-id', ow, `id ${o.id} is also used in ${seen}`);
            else objectIds.set(o.id, where);
          }
          if (o.id !== undefined && map.nextObjectId !== undefined && o.id >= map.nextObjectId) {
            report(
              'warning',
              'next-object-id',
              ow,
              `id ${o.id} is not below nextobjectid ${map.nextObjectId}`,
            );
          }
          if (o.gid !== undefined) used.add(o.gid & GID_MASK);
          // A template can bring its own tileset, so it may use one the map lists.
          if (o.template) usageKnown = false;
          if (o.gid !== undefined && o.gid & GID_MASK && !covered(o.gid & GID_MASK)) {
            report(
              'error',
              'gid-out-of-range',
              ow,
              `gid ${o.gid & GID_MASK} is not in any tileset`,
            );
          }
          if (o.template && !existsSync(resolveRef(map.file, o.template))) {
            report('error', 'missing-file', ow, `template ${o.template} does not exist`);
          }
          if (
            !map.infinite &&
            boundsKnown &&
            (o.x + o.width < 0 ||
              o.y + o.height < 0 ||
              o.x - o.width > mapWidth ||
              o.y - o.height > mapHeight)
          ) {
            report(
              'warning',
              'object-outside-map',
              ow,
              `at (${o.x}, ${o.y}), the map is ${mapWidth}x${mapHeight} px`,
            );
          }
        }
        break;
      case 'image':
        if (layer.image && !existsSync(resolveRef(map.file, layer.image))) {
          report('error', 'missing-image', where, `image ${layer.image} does not exist`);
        }
        break;
    }
  }

  if (usageKnown && !unknownRanges) {
    const usedGids = [...used];
    for (const r of ranges) {
      if (!usedGids.some((gid) => gid >= r.first && gid <= r.last)) {
        report('warning', 'unused-tileset', r.where, 'no tile or object in this map uses it');
      }
    }
  }
  return out;
}

function checkTileset(ts: Tileset, where: string, push: (d: Diagnostic) => void): void {
  const report = (rule: string, at: string, message: string, severity: Severity = 'error') =>
    push({ severity, rule, file: ts.file, where: at, message });
  if (ts.image) {
    const path = resolveRef(ts.file, ts.image);
    if (!existsSync(path)) {
      report('missing-image', where, `image ${ts.image} does not exist`);
    } else if (ts.imageWidth && ts.imageHeight) {
      const real = imageSize(path);
      if (real && (real.width !== ts.imageWidth || real.height !== ts.imageHeight)) {
        report(
          'image-size',
          where,
          `${ts.image} is ${real.width}x${real.height} but the tileset says ${ts.imageWidth}x${ts.imageHeight}, open and save the tileset in Tiled to update it`,
          'warning',
        );
      }
    }
  }
  for (const t of ts.tileImages) {
    if (!existsSync(resolveRef(ts.file, t.image))) {
      report('missing-image', `${where} tile ${t.id}`, `image ${t.image} does not exist`);
    }
  }
  for (const w of ts.wangSets) {
    if (w.colorCount > MAX_TERRAIN_COLORS) {
      report(
        'terrain-colors',
        `${where} terrain set '${w.name}'`,
        `${w.colorCount} colors, Tiled 1.10.2+ supports ${MAX_TERRAIN_COLORS} and silently drops every terrain set of this tileset`,
      );
    }
  }
}

/**
 * A world lists maps and where they sit. Every map in it is checked, and
 * maps that do not exist or overlap each other are reported.
 */
function checkWorld(file: string): Diagnostic[] {
  let world: {
    maps?: { fileName: string; x: number; y: number; width?: number; height?: number }[];
  };
  try {
    world = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return [
      {
        severity: 'error',
        rule: 'load-error',
        file,
        where: 'file',
        message: `invalid world: ${(err as Error).message}`,
      },
    ];
  }
  const out: Diagnostic[] = [];
  const placed: { name: string; x: number; y: number; w: number; h: number }[] = [];
  for (const entry of world.maps ?? []) {
    const path = resolveRef(file, entry.fileName);
    if (!existsSync(path)) {
      out.push({
        severity: 'error',
        rule: 'missing-file',
        file,
        where: `map ${entry.fileName}`,
        message: `${entry.fileName} does not exist`,
      });
      continue;
    }
    out.push(...checkFile(path));
    if (entry.width && entry.height) {
      placed.push({
        name: entry.fileName,
        x: entry.x,
        y: entry.y,
        w: entry.width,
        h: entry.height,
      });
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        out.push({
          severity: 'warning',
          rule: 'world-overlap',
          file,
          where: `map ${b.name}`,
          message: `overlaps ${a.name}`,
        });
      }
    }
  }
  return out;
}
