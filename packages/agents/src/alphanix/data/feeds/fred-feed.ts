const FRED_BASE = 'https://api.stlouisfed.org/fred';

export interface FredSeries {
  seriesId: string;
  title: string;
  observations: Array<{ date: string; value: number }>;
}

export class FredFeed {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.FRED_API_KEY || '';
  }

  async getSeries(seriesId: string, limit: number = 30): Promise<FredSeries> {
    if (!this.apiKey) throw new Error('FRED_API_KEY not set');
    const url = `${FRED_BASE}/series/observations?series_id=${seriesId}&api_key=${this.apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FRED API error: ${res.status}`);
    const data = await res.json();
    return {
      seriesId,
      title: seriesId,
      observations: (data.observations || [])
        .filter((o: any) => o.value !== '.')
        .map((o: any) => ({ date: o.date, value: parseFloat(o.value) })),
    };
  }

  async getInflation(): Promise<FredSeries> { return this.getSeries('CPIAUCSL'); }
  async getFedFundsRate(): Promise<FredSeries> { return this.getSeries('FEDFUNDS'); }
  async getUnemployment(): Promise<FredSeries> { return this.getSeries('UNRATE'); }
  async getGDP(): Promise<FredSeries> { return this.getSeries('GDP'); }
  async get10YearYield(): Promise<FredSeries> { return this.getSeries('DGS10'); }
  async getVIX(): Promise<FredSeries> { return this.getSeries('VIXCLS'); }

  async getMacroSnapshot(): Promise<Record<string, FredSeries>> {
    const keys = ['CPIAUCSL', 'FEDFUNDS', 'UNRATE', 'GDP', 'DGS10', 'VIXCLS'];
    const results: Record<string, FredSeries> = {};
    for (const key of keys) {
      try { results[key] = await this.getSeries(key, 5); } catch { /* skip failed */ }
    }
    return results;
  }
}
