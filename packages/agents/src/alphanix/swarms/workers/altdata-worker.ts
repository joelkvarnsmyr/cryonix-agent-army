import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';
import { OpenSkyFeed } from '../../data/feeds/opensky-feed';
import { TrafikverketFeed } from '../../data/feeds/trafikverket-feed';

export async function altdataWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const results: any = {};
    const source = (task.params.source as string) || 'all';

    if (source === 'all' || source === 'flights') {
      const opensky = new OpenSkyFeed();
      // Check Stockholm Arlanda arrivals as default
      const airport = (task.params.airport as string) || 'ESSA';
      results.flights = await opensky.getAirportArrivals(airport, 6);
    }

    if (source === 'all' || source === 'rail') {
      const tv = new TrafikverketFeed();
      results.malmbanen = await tv.getMalmbanenStatus();
    }

    return {
      taskId: task.id,
      success: true,
      data: { type: 'altdata', ...results },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: null, error: err.message, durationMs: Date.now() - start };
  }
}
