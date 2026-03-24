import type { SwarmSpawner } from '../swarm-spawner';
import { macroWorker } from './macro-worker';
import { sentimentWorker } from './sentiment-worker';
import { osintWorker } from './osint-worker';
import { altdataWorker } from './altdata-worker';
import { newsWorker } from './news-worker';

export function registerAllWorkers(spawner: SwarmSpawner): void {
  spawner.registerWorker('macro', macroWorker);
  spawner.registerWorker('sentiment', sentimentWorker);
  spawner.registerWorker('osint', osintWorker);
  spawner.registerWorker('altdata', altdataWorker);
  spawner.registerWorker('news', newsWorker);
  console.info('[SwarmWorkers] Registered: macro, sentiment, osint, altdata, news');
}
