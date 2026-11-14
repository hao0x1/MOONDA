// "Data detail": how sharp the NASA data under each part of the map is (nothing on the map is guessed).
//   sharp    south of 80° S: LOLA heights at 80 m per pixel, south-pole photos down to a few metres
//   global   everywhere else: LOLA heights about 1.9 km per pixel, LRO WAC photo mosaic about 100 m per pixel
//   rebuilt  90° W to 180° (north of 80° S): the WAC mosaic there is lit from the other side, so the picture is
//            NASA's albedo map x hill shading computed from the LOLA heights (imagery.ts, createSeamFixProvider)
// Three Okabe-Ito colours (safe for colour-blind eyes), drawn as a quiet tint.

import { ImageryLayer, Rectangle, SingleTileImageryProvider } from 'cesium';
import { MOON_ELLIPSOID } from './ellipsoid';
import { displayToTrueLatLon } from './frame';

export type DetailClass = 'sharp' | 'global' | 'rebuilt';
export const DETAIL_COLORS: Record<DetailClass, [number, number, number]> = {
  sharp: [0, 158, 115], // bluish green
  global: [86, 180, 233], // sky blue
  rebuilt: [230, 159, 0], // orange
};
export const DETAIL_ALPHA = 0.4;
export const detailCss = (c: DetailClass) => `rgb(${DETAIL_COLORS[c].join(',')})`;

/** The data-detail class of a TRUE lat/lon (degrees). */
export function detailClass(lat: number, lon: number): DetailClass {
  if (lat < -80) return 'sharp';
  const l = ((lon + 540) % 360) - 180;
  return l >= -180 && l < -90 ? 'rebuilt' : 'global';
}

let cachedUrl: string | null = null;
/** A picture of the classes in Cesium's DISPLAY lon/lat frame (see frame.ts), made once (about 30 ms). */
function displayPicture(): string {
  if (cachedUrl) return cachedUrl;
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const a = Math.round(255 * DETAIL_ALPHA);
  for (let y = 0; y < H; y++) {
    const dLat = Math.PI / 2 - (y + 0.5) * Math.PI / H; // radians, as displayToTrueLatLon takes them
    for (let x = 0; x < W; x++) {
      const t = displayToTrueLatLon(dLat, -Math.PI + (x + 0.5) * 2 * Math.PI / W);
      const col = DETAIL_COLORS[detailClass(t.lat, t.lon)];
      const i = (y * W + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  cachedUrl = c.toDataURL('image/png');
  return cachedUrl;
}

/** The Data detail layer for the globe (one picture of the whole Moon, see-through). */
export function createDataDetailLayer(): ImageryLayer {
  const provider = new SingleTileImageryProvider({
    url: displayPicture(), tileWidth: 2048, tileHeight: 1024,
    rectangle: Rectangle.clone(Rectangle.MAX_VALUE), ellipsoid: MOON_ELLIPSOID, credit: 'MOONDA · from README data sources',
  } as never);
  return new ImageryLayer(provider, { alpha: 1 });
}
