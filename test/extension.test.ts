import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

// Loads extension/tiledcheck.js the way Tiled does, with a stand-in for the
// parts of the scripting API it uses. Process runs the real CLI in-process.

interface Issue {
  severity: 'error' | 'warning';
  text: string;
  activated: () => void;
}

const source = readFileSync(new URL('../extension/tiledcheck.js', import.meta.url), 'utf8');

function makeObject(id: number, x: number, y: number, extra: object = {}) {
  return { id, x, y, width: 16, height: 16, tile: null, ...extra };
}

function makeMap(fileName: string) {
  const chest = makeObject(5, 16, 0, { name: 'Chest' });
  const ground = { name: 'Ground', isObjectLayer: false, isGroupLayer: false };
  const things = { name: 'Things', isObjectLayer: true, isGroupLayer: false, objects: [chest] };
  const group = { name: 'Level', isObjectLayer: false, isGroupLayer: true, layers: [things] };
  return {
    fileName,
    isTileMap: true,
    modified: false,
    layers: [ground, group],
    currentLayer: null as unknown,
    selectedLayers: [] as unknown[],
    selectedObjects: [] as unknown[],
    pixelToScreen: (x: number, y: number) => ({ x, y }),
    parts: { chest, ground, things },
  };
}

function load(map: ReturnType<typeof makeMap> | null) {
  const issues: Issue[] = [];
  const log: string[] = [];
  const alerts: string[] = [];
  const opened: string[] = [];
  const execs: { program: string; args: string[]; cwd: string }[] = [];
  const centered: { x: number; y: number }[] = [];
  const menus: Record<string, unknown[]> = {};
  const actions: Record<string, { callback: () => void; text?: string; enabled?: boolean }> = {};

  class Process {
    workingDirectory = '';
    private out = '';
    exec(program: string, args: string[]) {
      execs.push({ program, args, cwd: this.workingDirectory });
      this.out = '';
      return run(args.slice(2), (s) => (this.out += s));
    }
    readStdOut() {
      return this.out;
    }
    readStdErr() {
      return '';
    }
  }

  const tiled = {
    platform: 'linux',
    activeAsset: map,
    activeAssetChanged: { connect: () => {} },
    mapEditor: { currentMapView: { centerOn: (x: number, y: number) => centered.push({ x, y }) } },
    registerAction(id: string, callback: () => void) {
      actions[id] = { callback };
      return actions[id];
    },
    extendMenu(name: string, items: unknown[]) {
      menus[name] = items;
    },
    error: (text: string, activated: () => void) =>
      issues.push({ severity: 'error', text, activated }),
    warn: (text: string, activated: () => void) =>
      issues.push({ severity: 'warning', text, activated }),
    log: (text: string) => log.push(text),
    alert: (text: string) => alerts.push(text),
    confirm: () => false,
    trigger: () => {},
    open(file: string) {
      opened.push(file);
      return map && file.replace(/\\/g, '/') === map.fileName ? map : { isTileMap: false };
    },
  };

  const context: Record<string, unknown> = { tiled, Process };
  runInNewContext(source, context);
  const api = context.tiledcheck as {
    parseWhere: (where: string) => Record<string, unknown>;
    issueText: (d: object, mapFile: string) => string;
  };
  return { api, tiled, issues, log, alerts, opened, execs, centered, menus, actions };
}

let dir: string;
let mapFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tiledcheck-ext-')).replace(/\\/g, '/');
  mapFile = `${dir}/level.tmj`;
  writeFileSync(
    mapFile,
    JSON.stringify({
      type: 'map',
      orientation: 'orthogonal',
      width: 2,
      height: 1,
      tilewidth: 16,
      tileheight: 16,
      infinite: false,
      nextobjectid: 3,
      layers: [
        { id: 1, name: 'Ground', type: 'tilelayer', width: 2, height: 1, data: [1, 9] },
        {
          id: 2,
          name: 'Level',
          type: 'group',
          layers: [
            {
              id: 3,
              name: 'Things',
              type: 'objectgroup',
              objects: [{ id: 5, name: 'Chest', x: 16, y: 0, width: 16, height: 16 }],
            },
          ],
        },
      ],
      tilesets: [{ firstgid: 1, source: 'missing.tsx' }],
    }),
  );
});

describe('tiled extension', () => {
  it('adds an action to the Map menu', () => {
    const { actions, menus } = load(makeMap(mapFile));
    expect(actions.TiledcheckCheckMap?.text).toBe('Check with tiledcheck');
    expect(actions.TiledcheckCheckMap?.enabled).toBe(true);
    expect(menus.Map).toContainEqual({ action: 'TiledcheckCheckMap' });
  });

  it('disables the action without a map', () => {
    expect(load(null).actions.TiledcheckCheckMap?.enabled).toBe(false);
  });

  it('runs tiledcheck --json on the map and reports each problem', () => {
    const map = makeMap(mapFile);
    const { actions, issues, log, execs } = load(map);
    actions.TiledcheckCheckMap!.callback();
    expect(execs).toEqual([
      { program: 'npx', args: ['--yes', 'tiledcheck', '--json', mapFile], cwd: dir },
    ]);
    expect(issues.map((i) => `${i.severity} ${i.text}`)).toEqual([
      'error tiledcheck: tileset (firstgid 1): missing.tsx does not exist [missing-file]',
      `warning tiledcheck: layer 'Level/Things' object 5 'Chest': id 5 is not below nextobjectid 3 [next-object-id]`,
    ]);
    expect(log).toEqual(['tiledcheck: level.tmj: 1 error, 1 warning']);
  });

  it('selects and centers the object an issue is about', () => {
    const map = makeMap(mapFile);
    const { actions, issues, centered } = load(map);
    actions.TiledcheckCheckMap!.callback();
    issues[1]!.activated();
    expect(map.currentLayer).toBe(map.parts.things);
    expect(map.selectedObjects).toEqual([map.parts.chest]);
    expect(centered).toEqual([{ x: 24, y: 8 }]);
  });

  it('selects the layer an issue is about', () => {
    const map = makeMap(mapFile);
    const { api } = load(map);
    (api as unknown as { activate: (d: object) => void }).activate({
      severity: 'error',
      rule: 'gid-out-of-range',
      file: mapFile.replace(/\//g, '\\'),
      where: "layer 'Ground'",
      message: 'gid 9 is not in any tileset, used in 1 cell',
    });
    expect(map.currentLayer).toBe(map.parts.ground);
    expect(map.selectedLayers).toEqual([map.parts.ground]);
    expect(map.selectedObjects).toEqual([]);
  });

  it('opens the map a world problem is about', () => {
    const { api, opened } = load(makeMap(mapFile));
    (api as unknown as { activate: (d: object) => void }).activate({
      file: `${dir}/main.world`,
      where: 'map level.tmj',
    });
    expect(opened).toEqual([`${dir}/level.tmj`]);
  });

  it('parses where strings', () => {
    const { api } = load(null);
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
    expect(plain(api.parseWhere("layer 'A/B' object 3 'it''s'"))).toEqual({
      layer: 'A/B',
      objectId: 3,
    });
    expect(plain(api.parseWhere("layer 'A' object at (1.5, -2)"))).toEqual({
      layer: 'A',
      objectAt: { x: 1.5, y: -2 },
    });
    expect(plain(api.parseWhere("tileset 'x' (firstgid 1)"))).toEqual({});
    expect(
      api.issueText(
        { file: `${dir}/t.tsx`, where: "tileset 't'", message: 'm', rule: 'r' },
        mapFile,
      ),
    ).toBe("tiledcheck: t.tsx: tileset 't': m [r]");
  });

  it('says so when the map is clean or not saved', () => {
    const clean = `${dir}/clean.tmj`;
    writeFileSync(
      clean,
      JSON.stringify({
        type: 'map',
        orientation: 'orthogonal',
        width: 1,
        height: 1,
        tilewidth: 16,
        tileheight: 16,
        infinite: false,
        layers: [],
        tilesets: [],
      }),
    );
    const a = load(makeMap(clean));
    a.actions.TiledcheckCheckMap!.callback();
    expect(a.alerts).toEqual(['No problems found.']);

    const unsaved = makeMap(mapFile);
    unsaved.modified = true;
    const b = load(unsaved);
    b.actions.TiledcheckCheckMap!.callback();
    expect(b.execs).toEqual([]);
  });
});
