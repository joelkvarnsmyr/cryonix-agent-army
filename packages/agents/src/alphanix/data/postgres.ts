import { Client } from 'pg';

export class AlphanixDB {
  private client: Client | null = null;

  async connect(): Promise<void> {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      console.warn('[AlphanixDB] No POSTGRES_URL — persistence disabled');
      return;
    }
    this.client = new Client({ connectionString: url });
    await this.client.connect();
    await this.ensureTables();
  }

  private async ensureTables(): Promise<void> {
    if (!this.client) return;

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS alphanix_trades (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        pod_id VARCHAR(50) NOT NULL,
        symbol VARCHAR(30) NOT NULL,
        adapter VARCHAR(20) NOT NULL,
        side VARCHAR(4) NOT NULL,
        qty DECIMAL(20, 8) NOT NULL,
        fill_price DECIMAL(20, 8),
        notional DECIMAL(20, 4),
        slippage DECIMAL(10, 6),
        fees DECIMAL(10, 6),
        confidence INTEGER,
        reasoning TEXT,
        signals TEXT[],
        models TEXT[],
        order_id VARCHAR(100),
        proposal_id VARCHAR(50),
        UNIQUE(order_id)
      )
    `);

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS alphanix_signals (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        pod_id VARCHAR(50) NOT NULL,
        symbol VARCHAR(30) NOT NULL,
        adapter VARCHAR(20),
        side VARCHAR(4),
        confidence INTEGER,
        signals TEXT[],
        models TEXT[],
        reasoning TEXT,
        risk_action VARCHAR(10),
        risk_reason TEXT,
        proposal_id VARCHAR(50)
      )
    `);

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS alphanix_pod_performance (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        pod_id VARCHAR(50) NOT NULL,
        daily_pnl DECIMAL(20, 4),
        total_trades INTEGER,
        winning_trades INTEGER,
        losing_trades INTEGER,
        sharpe DECIMAL(10, 4),
        max_drawdown_pct DECIMAL(10, 4),
        capital_allocated DECIMAL(20, 4)
      )
    `);

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS alphanix_swarm_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        swarm_id VARCHAR(50) NOT NULL,
        type VARCHAR(20) NOT NULL,
        requester_pod VARCHAR(50),
        requester_role VARCHAR(20),
        worker_count INTEGER,
        duration_ms INTEGER,
        status VARCHAR(20),
        errors TEXT[],
        result_summary TEXT
      )
    `);

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS alphanix_config_changes (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        source VARCHAR(20) NOT NULL,
        pod_id VARCHAR(50),
        parameters JSONB,
        reasoning TEXT
      )
    `);

    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_alphanix_trades_pod_ts ON alphanix_trades(pod_id, timestamp DESC)
    `);
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_alphanix_signals_pod_ts ON alphanix_signals(pod_id, timestamp DESC)
    `);

    console.info('[AlphanixDB] Tables ensured');
  }

  async logTrade(params: {
    podId: string; symbol: string; adapter: string; side: string;
    qty: number; fillPrice: number; notional: number; slippage: number; fees: number;
    confidence: number; reasoning: string; signals: string[]; models: string[];
    orderId: string; proposalId: string;
  }): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.query(
        `INSERT INTO alphanix_trades (pod_id, symbol, adapter, side, qty, fill_price, notional, slippage, fees, confidence, reasoning, signals, models, order_id, proposal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (order_id) DO NOTHING`,
        [params.podId, params.symbol, params.adapter, params.side, params.qty,
         params.fillPrice, params.notional, params.slippage, params.fees,
         params.confidence, params.reasoning, params.signals, params.models,
         params.orderId, params.proposalId]
      );
    } catch (err: any) {
      console.warn('[AlphanixDB] logTrade failed:', err.message);
    }
  }

  async logSignal(params: {
    podId: string; symbol: string; adapter: string; side: string;
    confidence: number; signals: string[]; models: string[]; reasoning: string;
    riskAction: string; riskReason?: string; proposalId: string;
  }): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.query(
        `INSERT INTO alphanix_signals (pod_id, symbol, adapter, side, confidence, signals, models, reasoning, risk_action, risk_reason, proposal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [params.podId, params.symbol, params.adapter, params.side,
         params.confidence, params.signals, params.models, params.reasoning,
         params.riskAction, params.riskReason || null, params.proposalId]
      );
    } catch (err: any) {
      console.warn('[AlphanixDB] logSignal failed:', err.message);
    }
  }

  async logSwarm(params: {
    swarmId: string; type: string; requesterPod: string; requesterRole: string;
    workerCount: number; durationMs: number; status: string;
    errors: string[]; resultSummary: string;
  }): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.query(
        `INSERT INTO alphanix_swarm_logs (swarm_id, type, requester_pod, requester_role, worker_count, duration_ms, status, errors, result_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [params.swarmId, params.type, params.requesterPod, params.requesterRole,
         params.workerCount, params.durationMs, params.status, params.errors, params.resultSummary]
      );
    } catch (err: any) {
      console.warn('[AlphanixDB] logSwarm failed:', err.message);
    }
  }

  async getRecentTrades(podId: string, limit: number = 50): Promise<any[]> {
    if (!this.client) return [];
    const res = await this.client.query(
      'SELECT * FROM alphanix_trades WHERE pod_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [podId, limit]
    );
    return res.rows;
  }

  async close(): Promise<void> {
    try { await this.client?.end(); } catch { /* swallow */ }
  }
}
