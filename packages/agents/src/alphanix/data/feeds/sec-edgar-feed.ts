const EDGAR_FILINGS = 'https://data.sec.gov/submissions';

export interface InsiderTrade {
  filer: string;
  symbol: string;
  transactionType: 'P' | 'S';  // Purchase or Sale
  shares: number;
  pricePerShare: number;
  date: string;
}

export interface Filing {
  accessionNumber: string;
  form: string;
  filedAt: string;
  primaryDocument: string;
}

export class SecEdgarFeed {
  private userAgent: string;

  constructor(userAgent: string = 'Alphanix/1.0 (research@alphanix.dev)') {
    this.userAgent = userAgent;
  }

  async getRecentFilings(cik: string, formType?: string, limit: number = 10): Promise<Filing[]> {
    const paddedCik = cik.padStart(10, '0');
    const url = `${EDGAR_FILINGS}/CIK${paddedCik}.json`;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error(`EDGAR API error: ${res.status}`);
    const data = await res.json();
    const recent = data.filings?.recent;
    if (!recent) return [];

    const filings: Filing[] = [];
    const scanLimit = formType ? recent.accessionNumber.length : limit;
    for (let i = 0; i < Math.min(recent.accessionNumber.length, scanLimit); i++) {
      const form = recent.form[i];
      if (formType && form !== formType) continue;
      filings.push({
        accessionNumber: recent.accessionNumber[i],
        form,
        filedAt: recent.filingDate[i],
        primaryDocument: recent.primaryDocument[i],
      });
      if (filings.length >= limit) break;
    }
    return filings;
  }

  async searchFilings(query: string, formType?: string): Promise<Filing[]> {
    const params = new URLSearchParams({ q: query, dateRange: 'custom', startdt: this.daysAgo(30), enddt: this.today() });
    if (formType) params.set('forms', formType);
    const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits?.hits || []).map((h: any) => ({
      accessionNumber: h._source?.file_num || '',
      form: h._source?.form_type || '',
      filedAt: h._source?.file_date || '',
      primaryDocument: '',
    }));
  }

  private today(): string { return new Date().toISOString().split('T')[0]; }
  private daysAgo(n: number): string {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }
}
