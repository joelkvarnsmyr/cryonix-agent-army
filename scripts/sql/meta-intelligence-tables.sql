-- Meta-Intelligence Layer: persistent tables for historical trend analysis
-- Run: docker exec cryonix-postgres-1 psql -U postgres -d cryonix -f /app/scripts/sql/meta-intelligence-tables.sql

-- Signal rejections (kill rate persistence)
CREATE TABLE IF NOT EXISTS signal_rejections (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol VARCHAR(20) NOT NULL,
    pattern VARCHAR(50),
    confidence DECIMAL(5,4),
    entry_price DECIMAL(20,8) NOT NULL,
    rejection_reason VARCHAR(80) NOT NULL,
    price_after_4h DECIMAL(20,8),
    phantom_pnl_pct DECIMAL(10,4),
    would_have_won BOOLEAN,
    checked_at TIMESTAMPTZ,
    market_regime VARCHAR(20)
);
CREATE INDEX IF NOT EXISTS idx_sr_timestamp ON signal_rejections(timestamp);
CREATE INDEX IF NOT EXISTS idx_sr_reason ON signal_rejections(rejection_reason);

-- Alpha decay snapshots (daily time-series)
CREATE TABLE IF NOT EXISTS alpha_decay_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    pattern VARCHAR(50) NOT NULL,
    ev_current DECIMAL(10,6),
    ev_7d_ago DECIMAL(10,6),
    ev_30d_ago DECIMAL(10,6),
    slope_14d DECIMAL(10,6),
    trend VARCHAR(20),
    wr_current DECIMAL(5,1),
    wr_7d_ago DECIMAL(5,1),
    decay_ratio DECIMAL(5,3),
    data_points INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (snapshot_date, pattern)
);

-- Mutation fitness scores
CREATE TABLE IF NOT EXISTS mutation_fitness_scores (
    id SERIAL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    config_version_pre VARCHAR(16),
    config_version_post VARCHAR(16),
    regime VARCHAR(20),
    pre_trades INTEGER,
    post_trades INTEGER,
    pre_wr DECIMAL(5,1),
    post_wr DECIMAL(5,1),
    pre_sharpe DECIMAL(8,4),
    post_sharpe DECIMAL(8,4),
    pre_avg_pnl DECIMAL(20,8),
    post_avg_pnl DECIMAL(20,8),
    fitness_score DECIMAL(8,4),
    evaluation_window_hours INTEGER DEFAULT 48,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
