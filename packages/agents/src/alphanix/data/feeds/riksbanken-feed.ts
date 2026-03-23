const RB_BASE = 'https://api.riksbank.se/swea/v1';

export interface RiksbankRate {
  date: string;
  value: number;
  seriesId: string;
}

export class RiksbankenFeed {
  async getPolicyRate(): Promise<RiksbankRate[]> {
    return this.getSeries('SECBREPOEFF');
  }

  async getSekEurRate(): Promise<RiksbankRate[]> {
    return this.getSeries('SEKEURPMI');
  }

  async getSekUsdRate(): Promise<RiksbankRate[]> {
    return this.getSeries('SEKUSDPMI');
  }

  private async getSeries(seriesId: string): Promise<RiksbankRate[]> {
    try {
      const to = new Date().toISOString().split('T')[0];
      const from = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
      const url = `${RB_BASE}/Observations/${seriesId}/${from}/${to}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).map((d: any) => ({
        date: d.date,
        value: parseFloat(d.value),
        seriesId,
      }));
    } catch { return []; }
  }
}
