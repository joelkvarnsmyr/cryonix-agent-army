const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data';

export interface EcbRate {
  date: string;
  rate: number;
  series: string;
}

export class EcbFeed {
  async getMainRefinancingRate(): Promise<EcbRate[]> {
    return this.getSeries('FM/M.U2.EUR.4F.KR.MRR_FR.LEV');
  }

  async getEoniaRate(): Promise<EcbRate[]> {
    return this.getSeries('FM/D.U2.EUR.4F.KR.DFR.LEV');
  }

  async getEurUsdRate(): Promise<EcbRate[]> {
    return this.getSeries('EXR/D.USD.EUR.SP00.A');
  }

  private async getSeries(key: string): Promise<EcbRate[]> {
    try {
      const url = `${ECB_BASE}/${key}?lastNObservations=30&format=jsondata`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return [];
      const data = await res.json();
      const observations = data?.dataSets?.[0]?.series?.['0:0:0:0:0:0:0']?.observations || {};
      const times = data?.structure?.dimensions?.observation?.[0]?.values || [];
      return Object.entries(observations).map(([idx, vals]: any) => ({
        date: times[parseInt(idx)]?.id || '',
        rate: vals[0],
        series: key,
      }));
    } catch { return []; }
  }
}
