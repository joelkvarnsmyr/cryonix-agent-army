import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';

// Major financial centers: lat, lon, radius in degrees (~300km)
const FINANCIAL_CENTERS = [
  { name: 'New York', lat: 40.7, lon: -74.0 },
  { name: 'London', lat: 51.5, lon: -0.1 },
  { name: 'Tokyo', lat: 35.7, lon: 139.7 },
  { name: 'Shanghai', lat: 31.2, lon: 121.5 },
  { name: 'Frankfurt', lat: 50.1, lon: 8.7 },
  { name: 'Hong Kong', lat: 22.3, lon: 114.2 },
];
const PROXIMITY_DEG = 3; // ~300km

/**
 * OSINT worker — earthquake data from USGS (magnitude 4.5+ today).
 * Flags infrastructure risk if significant quake near a financial center.
 */
export async function osintWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Alphanix/1.0' } });
    if (!res.ok) {
      return { taskId: task.id, success: true, data: { type: 'osint', earthquakes: 0, significant: false, alerts: [] }, durationMs: Date.now() - start };
    }

    const data = await res.json();
    const features = data?.features || [];
    const alerts: string[] = [];
    let significant = false;

    for (const f of features) {
      const [lon, lat] = f.geometry?.coordinates || [0, 0, 0];
      const mag = f.properties?.mag || 0;
      const place = f.properties?.place || 'Unknown';

      for (const center of FINANCIAL_CENTERS) {
        const dLat = Math.abs(lat - center.lat);
        const dLon = Math.abs(lon - center.lon);
        if (dLat < PROXIMITY_DEG && dLon < PROXIMITY_DEG) {
          significant = true;
          alerts.push(`M${mag} near ${center.name}: ${place}`);
        }
      }

      // M6.5+ anywhere is globally significant
      if (mag >= 6.5 && !alerts.some(a => a.includes(place))) {
        alerts.push(`M${mag} major quake: ${place}`);
      }
    }

    return {
      taskId: task.id,
      success: true,
      data: {
        type: 'osint',
        earthquakes: features.length,
        significant,
        alerts: alerts.slice(0, 5),
      },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: { type: 'osint', earthquakes: 0, significant: false, alerts: [] }, error: err.message, durationMs: Date.now() - start };
  }
}
