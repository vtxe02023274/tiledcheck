# tiledcheck

[中文](README.md)

Checks Tiled maps (.tmx / .tmj) for problems that break things in your game: tilesets, images and templates that do not exist, gids no tileset covers, duplicate object ids, and terrain sets Tiled itself silently drops. Run it locally or in CI.

```
$ tiledcheck maps/
maps/town.tmx: error: tileset (firstgid 1): ../tiles/town.tsx does not exist [missing-file]
maps/town.tmx: error: layer 'Ground': gid 97 is not in any tileset, used in 12 cells [gid-out-of-range]
tiles/walls.tsx: error: tileset 'walls' terrain set 'Walls': 255 colors, Tiled 1.10.2+ supports 254 and silently drops every terrain set of this tileset [terrain-colors]
3 files checked, 3 errors, 0 warnings
```

## Usage

Requires Node.js 20 or later.

```sh
npx github:vtxe02023274/tiledcheck maps/
```

Pass maps, tilesets (.tsx / .tsj), worlds (.world, which checks every map they list) or folders; folders are searched recursively for maps and worlds. The exit code is 1 when there is an error.

| Option            | Effect                                                      |
| ----------------- | ----------------------------------------------------------- |
| `--json`          | print JSON                                                  |
| `--github`        | print GitHub Actions annotations so problems show on the PR |
| `--no-warnings`   | only report errors                                          |
| `--ignore <rule>` | skip a rule, can be repeated                                |
| `--rules`         | list the rules                                              |

In GitHub Actions, problems show up as annotations on the PR:

```yaml
- uses: actions/checkout@v5
- uses: vtxe02023274/tiledcheck@main
  with:
    path: maps/ worlds/main.world
    # warnings: false
    # ignore: image-size missing-image
```

## Rules

| Rule                  | Level   | What it means                                                                                                                              |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `load-error`          | error   | The file cannot be read or parsed                                                                                                          |
| `missing-file`        | error   | An external tileset or object template is missing                                                                                          |
| `missing-image`       | error   | A tileset or image layer image is missing. Engines that load images separately, like Phaser, can turn it off with `--ignore missing-image` |
| `image-size`          | warning | A tileset image is not the size the tileset says, so tile ids shift (PNG, GIF, BMP, JPEG)                                                  |
| `gid-out-of-range`    | error   | A tile or object gid is not in any tileset (flip flags are removed first)                                                                  |
| `tileset-overlap`     | error   | Two tilesets claim the same gids                                                                                                           |
| `terrain-colors`      | error   | A terrain set has more than 254 colors; since Tiled 1.10.2 none of the tileset's terrain sets load                                         |
| `layer-size`          | error   | The number of tiles in a layer does not match width x height                                                                               |
| `tile-data`           | error   | Tile data cannot be decoded (zstd only warns, since it is not checked)                                                                     |
| `duplicate-object-id` | error   | Two objects share an id                                                                                                                    |
| `next-object-id`      | warning | An object id is not below the map's nextobjectid, so Tiled may renumber it                                                                 |
| `object-outside-map`  | warning | An object is entirely outside the map (orthogonal, finite maps only)                                                                       |
| `world-overlap`       | warning | Two maps in a .world are placed on top of each other                                                                                       |

CSV, base64 (uncompressed, zlib, gzip), the old XML tile format, infinite map chunks and group layers are supported. When an old file leaves out `tilecount`, it is worked out from the image size the way Tiled does, or extended up to the next tileset's firstgid.

Tested against the 22 example maps in the Tiled source tree, both the TMX originals and JSON copies exported by Tiled, with the same results and no false positives (only two warnings for objects that really are outside their map). It also ran over the 108 map files in phaserjs/examples (with `--ignore missing-image`) and only reported one map with a wrong tilecount and three files that are not Tiled maps at all.

## Development

```sh
npm install
npm test
npm run lint
npm run build   # writes dist/
```

## License

MIT
