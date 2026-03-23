const MARINETRAFFIC_BASE = 'https://services.marinetraffic.com/api';

export interface Vessel {
  mmsi: string;
  imo: string;
  name: string;
  shipType: string;
  flag: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  destination: string;
  eta: string;
  draught: number;
  lastUpdate: string;
}

export interface PortActivity {
  port: string;
  arrivals: number;
  departures: number;
  inPort: number;
  timestamp: number;
}

export class AisFeed {
  // Note: MarineTraffic requires paid API key for real-time data
  // This uses the free public vessel search as fallback

  async searchVessel(name: string): Promise<Vessel[]> {
    try {
      // Use the free vessel finder API (limited)
      const url = `https://www.vesselfinder.com/api/pub/search/v2?q=${encodeURIComponent(name)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Alphanix/1.0' } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).slice(0, 10).map((v: any) => ({
        mmsi: v.MMSI || '',
        imo: v.IMO || '',
        name: v.NAME || name,
        shipType: v.TYPE || 'Unknown',
        flag: v.FLAG || '',
        latitude: v.LAT || 0,
        longitude: v.LON || 0,
        speed: v.SPEED || 0,
        course: v.COURSE || 0,
        destination: v.DEST || '',
        eta: v.ETA || '',
        draught: v.DRAUGHT || 0,
        lastUpdate: v.LASTPOS || '',
      }));
    } catch { return []; }
  }

  // Stub for port activity (requires paid API)
  async getPortActivity(portName: string): Promise<PortActivity> {
    return {
      port: portName,
      arrivals: 0,
      departures: 0,
      inPort: 0,
      timestamp: Date.now(),
    };
  }
}
