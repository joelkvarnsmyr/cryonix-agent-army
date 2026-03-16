/**
 * Bayesian Self-Learning Trading System
 *
 * Uses Beta-Binomial conjugate priors to learn from every trade.
 * Each dimension (pattern, symbol, hour, regime) maintains a Beta(alpha, beta)
 * distribution that updates incrementally with O(1) cost per trade.
 *
 * P(win_rate | data) = Beta(alpha + wins, beta + losses)
 * Mean estimate = alpha / (alpha + beta)
 */

import Redis from 'ioredis';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BayesianPrior {
  alpha: number;        // pseudo-count of successes
  beta: number;         // pseudo-count of failures
  n: number;            // total observations
  totalPnl: number;     // cumulative PnL
  avgWin: number;       // average winning trade PnL (%)
  avgLoss: number;      // average losing trade PnL (%)
  lastUpdated: string;  // ISO timestamp
}

export interface BayesianAdjustment {
  winProb: number;            // Bayesian estimate of win probability
  confidenceModifier: number; // -15 to +15 confidence adjustment
  kellyFraction: number;      // Bayesian Kelly sizing (0 to 1)
  sampleSize: number;         // how many trades inform this estimate
  dimensions: Record<string, { winProb: number; n: number }>;
}

export interface TradeOutcome {
  system: 'cryonix' | 'aktienix';
  pattern: string;
  symbol: string;
  regime?: string;
  hour: number;         // UTC hour (0-23)
  pnlPct: number;       // P&L percentage
  exitReason?: string;
}

type Dimension = 'pattern' | 'symbol' | 'hour' | 'regime' | 'combo' | 'exit';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PRIOR: BayesianPrior = {
  alpha: 1.5,
  beta: 1.5,
  n: 0,
  totalPnl: 0,
  avgWin: 0,
  avgLoss: 0,
  lastUpdated: new Date().toISOString(),
};

const REDIS_TTL = 7 * 24 * 60 * 60;        // 7 days
const MIN_OBSERVATIONS = 10;                 // minimum trades before adjustments apply
const MAX_CONFIDENCE_MODIFIER = 15;          // cap at ±15%
const DECAY_FACTOR = 0.995;                  // daily decay for old observations

// ── Core Functions ───────────────────────────────────────────────────────────

function redisKey(system: string, dimension: Dimension, key: string): string {
  return `bayes:${system}:${dimension}:${key}`;
}

async function getPrior(redis: Redis, system: string, dimension: Dimension, key: string): Promise<BayesianPrior> {
  try {
    const raw = await redis.get(redisKey(system, dimension, key));
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to default */ }
  return { ...DEFAULT_PRIOR };
}

async function setPrior(redis: Redis, system: string, dimension: Dimension, key: string, prior: BayesianPrior): Promise<void> {
  try {
    await redis.set(
      redisKey(system, dimension, key),
      JSON.stringify(prior),
      'EX', REDIS_TTL,
    );
  } catch (err: any) {
    console.warn(`[BAYES] Redis write failed for ${dimension}:${key}:`, err.message);
  }
}

// ── Bayesian Update (called on every trade close) ────────────────────────────

export async function updatePosterior(redis: Redis, outcome: TradeOutcome): Promise<void> {
  const isWin = outcome.pnlPct > 0;
  const updates: [Dimension, string][] = [
    ['pattern', outcome.pattern],
    ['symbol', outcome.symbol],
    ['hour', String(outcome.hour)],
    ['combo', `${outcome.pattern}:${outcome.symbol}`],
  ];
  if (outcome.regime) updates.push(['regime', outcome.regime]);
  if (outcome.exitReason) updates.push(['exit', outcome.exitReason]);

  const promises = updates.map(async ([dimension, key]) => {
    const prior = await getPrior(redis, outcome.system, dimension, key);

    // Bayes update: Beta-Binomial conjugate
    if (isWin) {
      const wins = prior.alpha - 1.5 + 1; // remove initial pseudo-count, add this win
      prior.avgWin = prior.n > 0 && (prior.alpha - 1.5) > 0
        ? (prior.avgWin * (prior.alpha - 1.5) + outcome.pnlPct) / wins
        : outcome.pnlPct;
      prior.alpha += 1;
    } else {
      const losses = prior.beta - 1.5 + 1;
      prior.avgLoss = prior.n > 0 && (prior.beta - 1.5) > 0
        ? (prior.avgLoss * (prior.beta - 1.5) + outcome.pnlPct) / losses
        : outcome.pnlPct;
      prior.beta += 1;
    }

    prior.n += 1;
    prior.totalPnl += outcome.pnlPct;
    prior.lastUpdated = new Date().toISOString();

    await setPrior(redis, outcome.system, dimension, key, prior);
  });

  await Promise.all(promises);

  console.log(
    `[BAYES] Updated ${outcome.system} posteriors: ${outcome.pattern}/${outcome.symbol} ` +
    `${isWin ? 'WIN' : 'LOSS'} ${outcome.pnlPct >= 0 ? '+' : ''}${outcome.pnlPct.toFixed(2)}% ` +
    `(${updates.length} dimensions)`
  );
}

// ── Read Bayesian Adjustment (called during signal evaluation) ───────────────

export async function getBayesianAdjustment(
  redis: Redis,
  system: 'cryonix' | 'aktienix',
  pattern: string,
  symbol: string,
  hour?: number,
  regime?: string,
): Promise<BayesianAdjustment> {
  const dimensions: Record<string, { winProb: number; n: number }> = {};

  // Read all relevant priors in parallel
  const keys: [Dimension, string][] = [
    ['pattern', pattern],
    ['symbol', symbol],
  ];
  if (hour !== undefined) keys.push(['hour', String(hour)]);
  if (regime) keys.push(['regime', regime]);
  keys.push(['combo', `${pattern}:${symbol}`]);

  const priors = await Promise.all(
    keys.map(async ([dim, key]) => {
      const prior = await getPrior(redis, system, dim, key);
      return { dim, key, prior };
    })
  );

  let totalWeight = 0;
  let weightedWinProb = 0;
  let bestPrior: BayesianPrior = DEFAULT_PRIOR;
  let totalN = 0;

  for (const { dim, key, prior } of priors) {
    const winProb = prior.alpha / (prior.alpha + prior.beta);
    dimensions[`${dim}:${key}`] = { winProb, n: prior.n };

    if (prior.n >= MIN_OBSERVATIONS) {
      // Weight by sample size (diminishing returns via sqrt)
      const weight = Math.sqrt(prior.n);
      totalWeight += weight;
      weightedWinProb += winProb * weight;
    }

    // Track the pattern-level prior for Kelly
    if (dim === 'pattern' && prior.n > bestPrior.n) {
      bestPrior = prior;
    }
    totalN = Math.max(totalN, prior.n);
  }

  // Weighted average win probability across dimensions
  const bayesianWinProb = totalWeight > 0
    ? weightedWinProb / totalWeight
    : 0.5; // uninformative

  // Confidence modifier: how much to shift from 50% baseline
  // Capped at ±MAX_CONFIDENCE_MODIFIER
  let confidenceModifier = 0;
  if (totalN >= MIN_OBSERVATIONS) {
    confidenceModifier = (bayesianWinProb - 0.5) * 100; // e.g., 0.65 → +15
    confidenceModifier = Math.max(-MAX_CONFIDENCE_MODIFIER, Math.min(MAX_CONFIDENCE_MODIFIER, confidenceModifier));
  }

  // Bayesian Kelly: f* = (p*b - q) / b
  // where p = win prob, q = 1-p, b = avg_win / |avg_loss|
  let kellyFraction = 0;
  if (bestPrior.n >= MIN_OBSERVATIONS && bestPrior.avgLoss !== 0) {
    const p = bestPrior.alpha / (bestPrior.alpha + bestPrior.beta);
    const q = 1 - p;
    const b = Math.abs(bestPrior.avgWin) / Math.abs(bestPrior.avgLoss);
    if (b > 0) {
      kellyFraction = Math.max(0, (p * b - q) / b);
      kellyFraction = Math.min(kellyFraction, 0.25); // cap at 25% (quarter-Kelly)
    }
  }

  return {
    winProb: bayesianWinProb,
    confidenceModifier,
    kellyFraction,
    sampleSize: totalN,
    dimensions,
  };
}

// ── Softmax Signal Ranking ───────────────────────────────────────────────────

export async function rankSignalsBySoftmax(
  redis: Redis,
  system: 'cryonix' | 'aktienix',
  signals: Array<{ pattern: string; symbol: string; confidence: number; [key: string]: any }>,
  temperature = 2.0,
): Promise<typeof signals> {
  if (signals.length <= 1) return signals;

  const evScores = await Promise.all(
    signals.map(async (sig) => {
      const prior = await getPrior(redis, system, 'pattern', sig.pattern);
      if (prior.n < MIN_OBSERVATIONS) {
        // Not enough data — use original confidence as score
        return { sig, ev: sig.confidence / 100 };
      }
      const p = prior.alpha / (prior.alpha + prior.beta);
      const ev = p * Math.abs(prior.avgWin) - (1 - p) * Math.abs(prior.avgLoss);
      return { sig, ev };
    })
  );

  // Softmax
  const maxEv = Math.max(...evScores.map(s => s.ev));
  const expScores = evScores.map(s => ({
    ...s,
    exp: Math.exp((s.ev - maxEv) / temperature), // subtract max for numerical stability
  }));
  const sumExp = expScores.reduce((sum, s) => sum + s.exp, 0);

  // Sort by softmax probability (descending)
  return expScores
    .map(s => ({ ...s, prob: s.exp / sumExp }))
    .sort((a, b) => b.prob - a.prob)
    .map(s => s.sig);
}

// ── Decay (call daily via cron) ──────────────────────────────────────────────

export async function applyDecay(redis: Redis, system: string, decayFactor = DECAY_FACTOR): Promise<number> {
  let updated = 0;
  const dimensions: Dimension[] = ['pattern', 'symbol', 'hour', 'regime', 'combo', 'exit'];

  for (const dim of dimensions) {
    const keys = await redis.keys(`bayes:${system}:${dim}:*`);
    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;
        const prior: BayesianPrior = JSON.parse(raw);

        // Decay alpha and beta toward the initial prior
        prior.alpha = 1.5 + (prior.alpha - 1.5) * decayFactor;
        prior.beta = 1.5 + (prior.beta - 1.5) * decayFactor;
        prior.lastUpdated = new Date().toISOString();

        await redis.set(key, JSON.stringify(prior), 'EX', REDIS_TTL);
        updated++;
      } catch { /* skip broken keys */ }
    }
  }

  console.log(`[BAYES] Decay applied to ${updated} priors for ${system} (factor: ${decayFactor})`);
  return updated;
}

// ── Postgres Persistence ─────────────────────────────────────────────────────

export async function persistToPostgres(
  redis: Redis,
  pgQuery: (sql: string, params: any[]) => Promise<any>,
  system: string,
): Promise<number> {
  let persisted = 0;
  const dimensions: Dimension[] = ['pattern', 'symbol', 'hour', 'regime', 'combo', 'exit'];

  for (const dim of dimensions) {
    const keys = await redis.keys(`bayes:${system}:${dim}:*`);
    for (const fullKey of keys) {
      try {
        const raw = await redis.get(fullKey);
        if (!raw) continue;
        const prior: BayesianPrior = JSON.parse(raw);
        const key = fullKey.replace(`bayes:${system}:${dim}:`, '');

        await pgQuery(
          `INSERT INTO bayesian_priors (system, dimension, key, alpha, beta, n, total_pnl, avg_win, avg_loss, last_updated, snapshot_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NULL)
           ON CONFLICT (system, dimension, key, snapshot_date) WHERE snapshot_date IS NULL
           DO UPDATE SET alpha=$4, beta=$5, n=$6, total_pnl=$7, avg_win=$8, avg_loss=$9, last_updated=NOW()`,
          [system, dim, key, prior.alpha, prior.beta, prior.n, prior.totalPnl, prior.avgWin, prior.avgLoss],
        );
        persisted++;
      } catch { /* skip */ }
    }
  }

  console.log(`[BAYES] Persisted ${persisted} priors for ${system} to Postgres`);
  return persisted;
}

export async function restoreFromPostgres(
  redis: Redis,
  pgQuery: (sql: string, params: any[]) => Promise<{ rows: any[] }>,
  system: string,
): Promise<number> {
  let restored = 0;
  try {
    const result = await pgQuery(
      `SELECT dimension, key, alpha, beta, n, total_pnl, avg_win, avg_loss, last_updated
       FROM bayesian_priors WHERE system = $1 AND snapshot_date IS NULL`,
      [system],
    );

    for (const row of result.rows) {
      const prior: BayesianPrior = {
        alpha: parseFloat(row.alpha),
        beta: parseFloat(row.beta),
        n: parseInt(row.n),
        totalPnl: parseFloat(row.total_pnl),
        avgWin: parseFloat(row.avg_win),
        avgLoss: parseFloat(row.avg_loss),
        lastUpdated: row.last_updated?.toISOString?.() ?? new Date().toISOString(),
      };

      await redis.set(
        redisKey(system, row.dimension, row.key),
        JSON.stringify(prior),
        'EX', REDIS_TTL,
      );
      restored++;
    }

    console.log(`[BAYES] Restored ${restored} priors for ${system} from Postgres`);
  } catch (err: any) {
    console.warn(`[BAYES] Postgres restore failed:`, err.message);
  }
  return restored;
}
