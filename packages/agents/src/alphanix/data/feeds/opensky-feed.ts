const OPENSKY_BASE = 'https://opensky-network.org/api';

export interface Flight {
  icao24: string;
  callsign: string;
  originCountry: string;
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
  onGround: boolean;
  lastContact: number;
}

export interface AirportArrival {
  icao24: string;
  callsign: string;
  estDepartureAirport: string;
  estArrivalAirport: string;
  firstSeen: number;
  lastSeen: number;
}

export class OpenSkyFeed {
  async getFlightsInArea(latMin: number, latMax: number, lonMin: number, lonMax: number): Promise<Flight[]> {
    const url = `${OPENSKY_BASE}/states/all?lamin=${latMin}&lamax=${latMax}&lomin=${lonMin}&lomax=${lonMax}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.states || []).map((s: any[]) => ({
      icao24: s[0], callsign: (s[1] || '').trim(),
      originCountry: s[2], latitude: s[6], longitude: s[5],
      altitude: s[7], velocity: s[9], onGround: s[8], lastContact: s[4],
    }));
  }

  async getAirportArrivals(airport: string, hoursBack: number = 12): Promise<AirportArrival[]> {
    const end = Math.floor(Date.now() / 1000);
    const begin = end - hoursBack * 3600;
    const url = `${OPENSKY_BASE}/flights/arrival?airport=${airport}&begin=${begin}&end=${end}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((f: any) => ({
      icao24: f.icao24, callsign: (f.callsign || '').trim(),
      estDepartureAirport: f.estDepartureAirport,
      estArrivalAirport: f.estArrivalAirport,
      firstSeen: f.firstSeen, lastSeen: f.lastSeen,
    }));
  }

  async getAirportDepartures(airport: string, hoursBack: number = 12): Promise<AirportArrival[]> {
    const end = Math.floor(Date.now() / 1000);
    const begin = end - hoursBack * 3600;
    const url = `${OPENSKY_BASE}/flights/departure?airport=${airport}&begin=${begin}&end=${end}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((f: any) => ({
      icao24: f.icao24, callsign: (f.callsign || '').trim(),
      estDepartureAirport: f.estDepartureAirport,
      estArrivalAirport: f.estArrivalAirport,
      firstSeen: f.firstSeen, lastSeen: f.lastSeen,
    }));
  }
}
