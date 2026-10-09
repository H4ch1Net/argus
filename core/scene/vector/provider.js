import * as Cesium from 'cesium';

// A Cesium imagery provider over the vector basemap (./client.js): Web
// Mercator tiles of one kind (base, roads or places), drawn at 512 px for each
// 256 px tile Cesium asks for, to zoom 21 (source data stops at 14 and is
// drawn larger, never upsampled).

const CREDIT = new Cesium.Credit(
  'OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors',
  false,
);

let blank = null;
function emptyImage() {
  if (!blank) {
    blank = document.createElement('canvas');
    blank.width = 1;
    blank.height = 1;
  }
  return blank;
}

export class VectorTileImageryProvider {
  /**
   * @param {{ basemap: ReturnType<import('./client.js').createVectorBasemap>,
   *   kind: 'base'|'roads'|'places', maximumLevel?: number }} opts
   */
  constructor({ basemap, kind, maximumLevel = 21 }) {
    this._basemap = basemap;
    this._kind = kind;
    this._maximumLevel = maximumLevel;
    this._tilingScheme = new Cesium.WebMercatorTilingScheme();
    this._errorEvent = new Cesium.Event();
  }
  get tileWidth() {
    return 256;
  }
  get tileHeight() {
    return 256;
  }
  get maximumLevel() {
    return this._maximumLevel;
  }
  get minimumLevel() {
    return 0;
  }
  get tilingScheme() {
    return this._tilingScheme;
  }
  get rectangle() {
    return this._tilingScheme.rectangle;
  }
  get tileDiscardPolicy() {
    return undefined;
  }
  get errorEvent() {
    return this._errorEvent;
  }
  get credit() {
    return CREDIT;
  }
  get proxy() {
    return undefined;
  }
  get hasAlphaChannel() {
    return this._kind !== 'base';
  }
  get ready() {
    return true;
  }
  getTileCredits() {
    return undefined;
  }
  requestImage(x, y, level) {
    return this._basemap
      .render(this._kind, level, x, y)
      .then((img) => img ?? emptyImage());
  }
  pickFeatures() {
    return undefined;
  }
}
