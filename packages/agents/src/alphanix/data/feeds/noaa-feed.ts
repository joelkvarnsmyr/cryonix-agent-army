const NOAA_BASE = 'https://api.weather.gov';

export interface WeatherAlert {
  event: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  headline: string;
  description: string;
  onset: string;
  expires: string;
  areaDesc: string;
}

export interface WeatherForecast {
  period: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  shortForecast: string;
  detailedForecast: string;
}

export class NoaaFeed {
  private userAgent: string;

  constructor(userAgent: string = 'Alphanix/1.0 (research@alphanix.dev)') {
    this.userAgent = userAgent;
  }

  async getAlerts(state?: string): Promise<WeatherAlert[]> {
    try {
      const url = state
        ? `${NOAA_BASE}/alerts/active?area=${state}`
        : `${NOAA_BASE}/alerts/active?status=actual&severity=Extreme,Severe`;
      const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || []).map((f: any) => ({
        event: f.properties.event,
        severity: f.properties.severity,
        headline: f.properties.headline,
        description: f.properties.description?.slice(0, 500),
        onset: f.properties.onset,
        expires: f.properties.expires,
        areaDesc: f.properties.areaDesc,
      }));
    } catch { return []; }
  }

  async getExtremeAlerts(): Promise<WeatherAlert[]> {
    const alerts = await this.getAlerts();
    return alerts.filter(a => a.severity === 'Extreme' || a.severity === 'Severe');
  }

  async getHurricaneAlerts(): Promise<WeatherAlert[]> {
    const alerts = await this.getAlerts();
    return alerts.filter(a =>
      a.event.toLowerCase().includes('hurricane') ||
      a.event.toLowerCase().includes('tropical')
    );
  }
}
