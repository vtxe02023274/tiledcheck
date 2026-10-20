import { existsSync } from 'node:fs';
import { extname } from 'node:path';
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
  'missing-file': 'An external tileset, image or template does not exist',
  'gid-out-of-range': 'A tile refers to a gid that no tileset covers',
  'tileset-overlap': 'Two tilesets claim the same gid range',
  'terrain-colors': 'A terrain set has more colors than Tiled can load',
  'layer-size': 'A tile layer has a different number of tiles than its size',
  'tile-data': 'Tile data cannot be decoded',
  'duplicate-object-id': 'Two objects share an id',
  'next-object-id': 'An object id is not below the map nextobjectid',
  'object-outside-map': 'An object lies completely outside the map',
};

export function checkFile(file: string): Diagnostic[] {
  const ext = extname(file).toLowerCase();
  let map: TiledMap;
  try {
    if (ext === '.tsx' || ext === '.tsj') {
      const ts = loadTileset(file);
      const out: Diagnostic[] = [];
      checkTileset(ts, `tileset '${ts.name}'`, (d) => out.push(d));
      return out;
    }
    map = loadMap(file);
  } catch (err) {
    if (err instanceof LoadError) {
      return [{ severity: 'error', rule: 'load-error', file, where: 'file', message: err.message }];
    }
    throw err;
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
  const objectIds = new Map<number, string>();
  const mapWidth = map.width * map.tileWidth;
  const mapHeight = map.height * map.tileHeight;

  for (const { layer, path } of allLayers(map.layers)) {
    const where = `layer '${path}'`;
    switch (layer.kind) {
      case 'tile': {
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
          if (gid && !covered(gid)) bad.set(gid, (bad.get(gid) ?? 0) + 1);
        }
        for (const [gid, count] of bad) {
          report(
            'error',
            'gid-out-of-range',
            where,
            `gid ${gid} is not in any tileset (${count} tile${count > 1 ? 's' : ''})`,
          );
        }
        break;
      }
      case 'objects':
        for (const o of layer.objects) {
          const ow = `${where} object ${o.id}${o.name ? ` '${o.name}'` : ''}`;
          const seen = objectIds.get(o.id);
          if (seen !== undefined)
            report('error', 'duplicate-object-id', ow, `id ${o.id} is also used in ${seen}`);
          else objectIds.set(o.id, where);
          if (map.nextObjectId !== undefined && o.id >= map.nextObjectId) {
            report(
              'warning',
              'next-object-id',
              ow,
              `id ${o.id} is not below nextobjectid ${map.nextObjectId}`,
            );
          }
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
            map.orientation === 'orthogonal' &&
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
          report('error', 'missing-file', where, `image ${layer.image} does not exist`);
        }
        break;
    }
  }
  return out;
}

function checkTileset(ts: Tileset, where: string, push: (d: Diagnostic) => void): void {
  const report = (rule: string, at: string, message: string) =>
    push({ severity: 'error', rule, file: ts.file, where: at, message });
  if (ts.image && !existsSync(resolveRef(ts.file, ts.image))) {
    report('missing-file', where, `image ${ts.image} does not exist`);
  }
  for (const t of ts.tileImages) {
    if (!existsSync(resolveRef(ts.file, t.image))) {
      report('missing-file', `${where} tile ${t.id}`, `image ${t.image} does not exist`);
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
