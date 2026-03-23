const TV_BASE = 'https://api.trafikinfo.trafikverket.se/v2/data.json';

export interface TrainAnnouncement {
  trainId: string;
  fromLocation: string;
  toLocation: string;
  advertisedTime: string;
  estimatedTime?: string;
  actualTime?: string;
  cancelled: boolean;
  deviations: string[];
}

export class TrafikverketFeed {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.TRAFIKVERKET_API_KEY || '';
  }

  async getTrainAnnouncements(fromStation: string, toStation: string): Promise<TrainAnnouncement[]> {
    if (!this.apiKey) {
      console.warn('[TrafikverketFeed] No API key — returning empty');
      return [];
    }

    const query = `
      <REQUEST>
        <LOGIN authenticationkey="${this.apiKey}" />
        <QUERY objecttype="TrainAnnouncement" schemaversion="1.6" limit="20">
          <FILTER>
            <AND>
              <EQ name="LocationSignature" value="${fromStation}" />
              <EQ name="ActivityType" value="Avgang" />
              <GT name="AdvertisedTimeAtLocation" value="$dateadd(-12:00:00)" />
            </AND>
          </FILTER>
          <INCLUDE>AdvertisedTrainIdent</INCLUDE>
          <INCLUDE>LocationSignature</INCLUDE>
          <INCLUDE>ToLocation</INCLUDE>
          <INCLUDE>AdvertisedTimeAtLocation</INCLUDE>
          <INCLUDE>EstimatedTimeAtLocation</INCLUDE>
          <INCLUDE>TimeAtLocation</INCLUDE>
          <INCLUDE>Canceled</INCLUDE>
          <INCLUDE>Deviation</INCLUDE>
        </QUERY>
      </REQUEST>`;

    const res = await fetch(TV_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: query,
    });

    if (!res.ok) return [];
    const data = await res.json();
    const results = data?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement || [];

    return results.map((t: any) => ({
      trainId: t.AdvertisedTrainIdent,
      fromLocation: t.LocationSignature,
      toLocation: t.ToLocation?.[0]?.LocationName || toStation,
      advertisedTime: t.AdvertisedTimeAtLocation,
      estimatedTime: t.EstimatedTimeAtLocation,
      actualTime: t.TimeAtLocation,
      cancelled: t.Canceled || false,
      deviations: t.Deviation || [],
    }));
  }

  async getMalmbanenStatus(): Promise<{ operational: boolean; delays: number; cancellations: number; trains: TrainAnnouncement[] }> {
    // Kiruna (KRA) → Narvik via Malmbanan
    const trains = await this.getTrainAnnouncements('KRA', 'NAV');
    const delays = trains.filter(t => t.estimatedTime && t.estimatedTime !== t.advertisedTime).length;
    const cancellations = trains.filter(t => t.cancelled).length;
    return {
      operational: cancellations < trains.length / 2,
      delays, cancellations, trains,
    };
  }
}
