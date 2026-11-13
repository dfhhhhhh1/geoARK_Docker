import type { UserLayer } from '../types';

/** File types POST /api/layers reads (backend/user_layers.js). */
export const LAYER_EXT = /\.(geojson|json|zip|gpkg|kml)$/i;

/**
 * Upload a map layer for this session. The bytes go to the server once and
 * are converted there (a zipped shapefile or GeoPackage needs GDAL); nothing
 * is stored on disk, and the layer is forgotten after a few hours or a
 * restart.
 */
export async function uploadLayer(file: File): Promise<UserLayer> {
  const res = await fetch(`/api/layers?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  let data: (UserLayer & { error?: string }) | null = null;
  try { data = await res.json(); } catch { /* reported below */ }
  if (!res.ok || !data) throw new Error(data?.error || `upload failed (HTTP ${res.status})`);
  return data;
}
