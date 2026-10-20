/*
 * tiledcheck extension for Tiled 1.10 and later.
 *
 * Copy this file into the Tiled extensions folder (Edit > Preferences >
 * Plugins > Open...). It adds Map > Check with tiledcheck, which runs
 * tiledcheck on the saved map file and lists every problem in the Issues view.
 * Double-click an issue to select the object or layer it is about.
 *
 * https://github.com/vtxe02023274/tiledcheck
 */

var tiledcheck = (function () {
  // The command that runs tiledcheck. `--json <map file>` is appended. To use a
  // local install, set it to for example ['node', 'C:/tools/tiledcheck/dist/bin.js'].
  // Extra options such as ['--ignore', 'missing-image'] go in `args`.
  const config = {
    command: ['npx', '--yes', 'tiledcheck'],
    args: [],
  };

  const normalize = (path) => {
    const p = String(path).replace(/\\/g, '/');
    // Windows paths are case insensitive.
    return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
  };

  const dirOf = (path) => {
    const p = String(path).replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    return i < 0 ? '.' : p.slice(0, i);
  };

  const baseName = (path) => String(path).replace(/\\/g, '/').split('/').pop();

  /** Reads the JSON report printed by `tiledcheck --json`. */
  function parseReport(text) {
    const start = text.indexOf('{');
    if (start < 0) throw new Error(text.trim() || 'tiledcheck printed nothing');
    const report = JSON.parse(text.slice(start));
    if (!report || !Array.isArray(report.diagnostics))
      throw new Error('unexpected output from tiledcheck');
    return report;
  }

  /**
   * Splits a diagnostic's `where` into the layer path and object it points to,
   * e.g. "layer 'Group/Ground' object 5 'Chest'".
   */
  function parseWhere(where) {
    const m =
      /^layer '(.*?)'(?: object (?:(\d+)|at \((-?[\d.e+-]+), (-?[\d.e+-]+)\))(?: '.*')?)?$/.exec(
        where,
      );
    if (m) {
      return {
        layer: m[1],
        objectId: m[2] !== undefined ? Number(m[2]) : undefined,
        objectAt: m[3] !== undefined ? { x: Number(m[3]), y: Number(m[4]) } : undefined,
      };
    }
    const world = /^map (.+)$/.exec(where);
    if (world) return { worldMap: world[1] };
    return {};
  }

  /** The text shown in the Issues view. */
  function issueText(d, mapFile) {
    const file = normalize(d.file) === normalize(mapFile) ? '' : `${baseName(d.file)}: `;
    return `tiledcheck: ${file}${d.where}: ${d.message} [${d.rule}]`;
  }

  function findLayer(layers, path, prefix) {
    for (const layer of layers) {
      const here = prefix ? `${prefix}/${layer.name}` : layer.name;
      if (here === path) return layer;
      if (layer.isGroupLayer) {
        const found = findLayer(layer.layers, path, here);
        if (found) return found;
      }
    }
    return null;
  }

  function objectLayers(layers, out) {
    for (const layer of layers) {
      if (layer.isObjectLayer) out.push(layer);
      else if (layer.isGroupLayer) objectLayers(layer.layers, out);
    }
    return out;
  }

  /** Finds the layer and object a diagnostic points to in an open map. */
  function locate(map, where) {
    const w = parseWhere(where);
    if (w.layer === undefined) return {};
    const layer = findLayer(map.layers, w.layer, '');
    if (w.objectId === undefined && !w.objectAt) return { layer };
    const match = (o) =>
      w.objectId !== undefined ? o.id === w.objectId : o.x === w.objectAt.x && o.y === w.objectAt.y;
    const search = layer && layer.isObjectLayer ? [layer] : objectLayers(map.layers, []);
    for (const group of search) {
      for (const object of group.objects) if (match(object)) return { layer: group, object };
    }
    return { layer };
  }

  function focus(map, target) {
    if (target.layer) {
      map.currentLayer = target.layer;
      map.selectedLayers = [target.layer];
    }
    if (!target.object) return;
    const o = target.object;
    map.selectedObjects = [o];
    // Tile objects are anchored at their bottom left corner.
    const cy = o.tile ? o.y - o.height / 2 : o.y + o.height / 2;
    const view = tiled.mapEditor.currentMapView;
    if (view) {
      const p = map.pixelToScreen(o.x + o.width / 2, cy);
      view.centerOn(p.x, p.y);
    }
  }

  /** Opens the file a diagnostic is about and selects what it points to. */
  function activate(d) {
    let file = d.file;
    const w = parseWhere(d.where);
    // A world problem about one of its maps opens that map.
    if (w.worldMap && /\.world$/i.test(file)) file = `${dirOf(file)}/${w.worldMap}`;
    const asset = tiled.open(file);
    if (!asset) return;
    tiled.activeAsset = asset;
    if (asset.isTileMap) focus(asset, locate(asset, d.where));
  }

  function exec(command, args, cwd) {
    const process = new Process();
    process.workingDirectory = cwd;
    let program = command[0];
    let code = process.exec(program, command.slice(1).concat(args), false);
    // npx and npm are .cmd scripts on Windows.
    if (code === -1 && tiled.platform === 'windows' && !/\.\w+$/.test(program)) {
      program += '.cmd';
      code = process.exec(program, command.slice(1).concat(args), false);
    }
    return { code, stdout: process.readStdOut(), stderr: process.readStdErr(), program };
  }

  /** Runs tiledcheck on a file and returns its report. Throws when it cannot. */
  function check(fileName) {
    const r = exec(config.command, config.args.concat(['--json', fileName]), dirOf(fileName));
    if (r.code === -1) throw new Error(`could not start ${config.command[0]}`);
    try {
      return parseReport(r.stdout);
    } catch (err) {
      throw new Error(`${r.stderr.trim() || r.stdout.trim() || err.message} (exit code ${r.code})`);
    }
  }

  /** Reports each diagnostic as an issue. Returns how many were reported. */
  function report(result, mapFile) {
    for (const d of result.diagnostics) {
      const text = issueText(d, mapFile);
      if (d.severity === 'error') tiled.error(text, () => activate(d));
      else tiled.warn(text, () => activate(d));
    }
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    tiled.log(
      `tiledcheck: ${baseName(mapFile)}: ${plural(result.errors, 'error')}, ${plural(result.warnings, 'warning')}`,
    );
    return result.diagnostics.length;
  }

  function run() {
    const map = tiled.activeAsset;
    if (!map || !map.isTileMap) {
      tiled.alert('Open a map first.', 'tiledcheck');
      return;
    }
    if (!map.fileName) {
      tiled.alert('Save the map first, tiledcheck checks the file on disk.', 'tiledcheck');
      return;
    }
    if (map.modified) {
      if (!tiled.confirm('The map has unsaved changes. Save it and check?', 'tiledcheck')) return;
      tiled.trigger('Save');
      if (map.modified) return;
    }
    let result;
    try {
      result = check(map.fileName);
    } catch (err) {
      tiled.error(`tiledcheck: ${err.message}`, () => {});
      return;
    }
    if (!report(result, map.fileName)) tiled.alert('No problems found.', 'tiledcheck');
  }

  if (typeof tiled !== 'undefined' && typeof tiled.registerAction === 'function') {
    const action = tiled.registerAction('TiledcheckCheckMap', run);
    action.text = 'Check with tiledcheck';
    const update = () => {
      const asset = tiled.activeAsset;
      action.enabled = !!asset && asset.isTileMap;
    };
    update();
    tiled.activeAssetChanged.connect(update);
    tiled.extendMenu('Map', [{ separator: true }, { action: 'TiledcheckCheckMap' }]);
  }

  return { config, parseReport, parseWhere, issueText, locate, activate, check, report, run };
})();
