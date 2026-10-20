/**
 * Format independent view of a Tiled map, holding only what the checks need.
 * Both TMX/TSX (XML) and TMJ/TSJ (JSON) files load into it.
 */

export interface TiledMap {
  file: string;
  orientation: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  infinite: boolean;
  nextObjectId?: number;
  tilesets: TilesetRef[];
  layers: Layer[];
}

export interface TilesetRef {
  firstGid: number;
  /** External file as written in the map, if any. */
  source?: string;
  /** Loaded tileset; undefined when the external file could not be read. */
  tileset?: Tileset;
}

export interface Tileset {
  file: string;
  name: string;
  /** Undefined when the file does not say and the image size is unknown. */
  tileCount?: number;
  image?: string;
  /** Image size as written in the tileset, to compare against the real file. */
  imageWidth?: number;
  imageHeight?: number;
  /** Image per tile, for collection of images tilesets. */
  tileImages: { id: number; image: string }[];
  wangSets: WangSet[];
}

export interface WangSet {
  name: string;
  colorCount: number;
}

export type Layer = TileLayer | ObjectLayer | ImageLayer | GroupLayer;

interface LayerBase {
  name: string;
  id?: number;
}

export interface TileLayer extends LayerBase {
  kind: 'tile';
  width: number;
  height: number;
  /** All gids in the layer, chunks flattened. Undefined when the data could not be decoded. */
  gids?: number[];
  /** Why the data could not be decoded. */
  dataProblem?: string;
  /** Decoded length for finite layers, to compare against width * height. */
  dataLength?: number;
}

export interface MapObject {
  /** Undefined in very old maps, written before Tiled gave objects ids. */
  id?: number;
  name: string;
  gid?: number;
  template?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise around x and y. */
  rotation: number;
  /** Polygon or polyline points, relative to x and y. */
  points?: { x: number; y: number }[];
}

export interface ObjectLayer extends LayerBase {
  kind: 'objects';
  objects: MapObject[];
}

export interface ImageLayer extends LayerBase {
  kind: 'image';
  image?: string;
}

export interface GroupLayer extends LayerBase {
  kind: 'group';
  layers: Layer[];
}

/** Tiled keeps flip and rotation flags in the top four bits of a gid. */
export const GID_MASK = 0x0fffffff;

export function* allLayers(layers: Layer[], path = ''): Generator<{ layer: Layer; path: string }> {
  for (const layer of layers) {
    const here = path ? `${path}/${layer.name}` : layer.name;
    yield { layer, path: here };
    if (layer.kind === 'group') yield* allLayers(layer.layers, here);
  }
}
