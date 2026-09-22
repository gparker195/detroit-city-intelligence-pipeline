/**
 * Small planar geometry helpers for scoping fetches to a study area. WGS84 lon/lat in,
 * distances in metres via a local equirectangular projection around the polygon centroid.
 * Written fresh; no OSM data, no external dependency.
 */

import type { Envelope } from '../arcgis/featureServiceClient.ts';

export type Ring = [number, number][];
export type LonLat = [number, number];

export interface PolygonRings {
  /** Outer ring first, holes after; each ring closed (first == last) or not, both accepted. */
  rings: Ring[];
}

const EARTH_RADIUS_M = 6_371_008.8;

export function ringsBbox(rings: readonly Ring[]): Envelope {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

/** Expands a WGS84 envelope by `metres` on every side. */
export function expandEnvelope(env: Envelope, metres: number): Envelope {
  const [minX, minY, maxX, maxY] = env;
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  const dLat = (metres / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos(midLat), 1e-6);
  return [minX - dLon, minY - dLat, maxX + dLon, maxY + dLat];
}

/** Even-odd ray cast against every ring: inside the outer ring and outside the holes. */
export function pointInRings(point: LonLat, rings: readonly Ring[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
  }
  return inside;
}

export function haversineMetres(a: LonLat, b: LonLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

function project(point: LonLat, originLat: number): [number, number] {
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  return [point[0] * k * Math.cos(originLat * (Math.PI / 180)), point[1] * k];
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** Metres from a point to the nearest edge of any ring (0 is not implied for interior points). */
export function distanceToRingsMetres(point: LonLat, rings: readonly Ring[]): number {
  const originLat = point[1];
  const p = project(point, originLat);
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = segmentDistance(p, project(ring[i]!, originLat), project(ring[j]!, originLat));
      if (d < best) best = d;
    }
  }
  return best;
}

/** True when the point is inside the polygon or within `bufferMetres` of its boundary. */
export function pointWithinBuffer(point: LonLat, rings: readonly Ring[], bufferMetres: number): boolean {
  if (pointInRings(point, rings)) return true;
  if (bufferMetres <= 0) return false;
  return distanceToRingsMetres(point, rings) <= bufferMetres;
}

/** Reads a point from an ArcGIS feature: geometry {x,y} first, else longitude/latitude attributes. */
export function featurePoint(attributes: Record<string, unknown>, geometry: unknown): LonLat | null {
  const g = geometry as { x?: unknown; y?: unknown } | null | undefined;
  if (g && typeof g.x === 'number' && typeof g.y === 'number' && Number.isFinite(g.x) && Number.isFinite(g.y)) return [g.x, g.y];
  const lon = Number(attributes.longitude ?? attributes.Longitude ?? attributes.LONGITUDE);
  const lat = Number(attributes.latitude ?? attributes.Latitude ?? attributes.LATITUDE);
  if (Number.isFinite(lon) && Number.isFinite(lat) && (lon !== 0 || lat !== 0)) return [lon, lat];
  return null;
}
