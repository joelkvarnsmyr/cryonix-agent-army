#!/usr/bin/env python3
"""
Ψ Phase Convergence v2 — Real Data Backtest
=============================================
Upgrades from v1:
  A. BTC/ETH pairs trading (OU spread signal)
  B. Improved signal generators with longer lookbacks
  C. Adaptive β via rolling optimization
  D. Volume-weighted signals from ratio analysis
  E. Proper train/test split with walk-forward
"""

import numpy as np
import json, sys
from dataclasses import dataclass
from collections import defaultdict

# ============================================================
# PSI v2 ENGINE
# ============================================================

@dataclass
class PsiV2Config:
    n_signals: int = 6
    kelly_fraction: float = 0.25
    beta_scale: float = 3.0
    beta_adaptive: bool = True         # NEW: adaptive β
    beta_window: int = 50              # Rolling window for β optimization
    coherence_threshold: float = 0.25
    bayesian_lr: float = 0.05
    lookback_entropy: int = 20
    lookback_hurst: int = 80
    pairs_hedge_window: int = 60       # NEW: hedge ratio window
    min_position: float = 0.005        # NEW: minimum position to bother

class PsiV2Engine:
    """
    Ψ v2: Phase Convergence with Pairs Trading + Adaptive β
    
    Ψ(t) = tanh(β(t) · C(t) · Σᵢ wᵢ(t)·σᵢ(t)) × Kelly(t) × C(t)²
    
    NEW in v2:
    - β(t) adapts based on rolling performance
    - 6th signal: pairs spread (BTC/ETH ratio)
    - Improved Hurst with variance-ratio method
    - Better OU with half-life estimation
    """
    
    def __init__(self, config: PsiV2Config = None):
        self.cfg = config or PsiV2Config()
        self.weights = np.ones(self.cfg.n_signals) / self.cfg.n_signals
        self.signal_profits = np.zeros(self.cfg.n_signals)
        self.signal_trades = np.zeros(self.cfg.n_signals) + 1
        self.beta_history = []
        self.pnl_history = []
        self.current_beta = self.cfg.beta_scale
    
    def kuramoto_coherence(self, signals):
        phases = np.pi * (signals + 1)
        return np.abs(np.sum(np.exp(1j * phases))) / len(signals)
    
    def shannon_entropy(self, returns):
        if len(returns) < 5:
            return 1.0
        n_bins = max(5, int(np.sqrt(len(returns))))
        counts, _ = np.histogram(returns, bins=n_bins)
        probs = counts / counts.sum()
        probs = probs[probs > 0]
        H = -np.sum(probs * np.log2(probs))
        return H / np.log2(n_bins) if np.log2(n_bins) > 0 else 1.0
    
    def adaptive_beta(self, returns):
        """v2: β adapts based on recent entropy + rolling performance"""
        H = self.shannon_entropy(returns)
        H = max(H, 0.05)
        base_beta = self.cfg.beta_scale / H
        
        if self.cfg.beta_adaptive and len(self.pnl_history) > 20:
            recent_pnl = np.array(self.pnl_history[-20:])
            if recent_pnl.std() > 0:
                # If recent trades profitable → increase β (sharper decisions)
                # If losing → decrease β (more cautious)
                win_ratio = (recent_pnl > 0).mean()
                beta_modifier = 0.5 + win_ratio  # range [0.5, 1.5]
                base_beta *= beta_modifier
        
        self.current_beta = np.clip(base_beta, 0.5, 15.0)
        return self.current_beta
    
    def compute_psi(self, signals, recent_returns):
        C = self.kuramoto_coherence(signals)
        beta = self.adaptive_beta(recent_returns)
        
        weighted_sum = np.sum(self.weights * signals)
        S = np.tanh(beta * C * weighted_sum)
        f = self.cfg.kelly_fraction * (C ** 2)
        psi = S * f
        
        # Minimum position filter
        if abs(psi) < self.cfg.min_position:
            psi = 0.0
        
        return {
            'psi': psi, 'signal': S, 'coherence': C,
            'beta': beta, 'position_size': f,
            'weighted_sum': weighted_sum,
            'weights': self.weights.copy(),
            'entropy': self.shannon_entropy(recent_returns)
        }
    
    def update_weights(self, signals, realized_return):
        direction = np.sign(realized_return)
        agreement = signals * direction
        
        for i in range(self.cfg.n_signals):
            if abs(signals[i]) > 0.1:
                self.signal_trades[i] += 1
                if agreement[i] > 0:
                    self.signal_profits[i] += abs(realized_return)
        
        performance = self.signal_profits / self.signal_trades
        performance = performance - performance.min() + 0.01
        new_weights = performance / performance.sum()
        self.weights = (1 - self.cfg.bayesian_lr) * self.weights + \
                       self.cfg.bayesian_lr * new_weights
        self.weights /= self.weights.sum()
        
        # Track PnL for adaptive β
        self.pnl_history.append(realized_return)


# ============================================================
# v2 SIGNAL GENERATORS
# ============================================================

class V2Signals:
    """Improved signal generators for Ψ v2"""
    
    @staticmethod
    def hurst_variance_ratio(prices, window=80):
        """Improved Hurst via variance ratio test"""
        if len(prices) < window:
            return 0.0
        
        log_p = np.log(prices[-window:])
        returns = np.diff(log_p)
        n = len(returns)
        if n < 20:
            return 0.0
        
        # Variance ratio for multiple lags
        lags = [2, 4, 8, 16]
        vr_values = []
        for q in lags:
            if q >= n // 2:
                continue
            # Variance of q-period returns
            q_returns = log_p[q:] - log_p[:-q]
            var_q = np.var(q_returns)
            var_1 = np.var(returns)
            if var_1 > 1e-15:
                vr = var_q / (q * var_1)
                vr_values.append(vr)
        
        if not vr_values:
            return 0.0
        
        avg_vr = np.mean(vr_values)
        # VR > 1 = trending, VR < 1 = mean reverting
        # Convert to Hurst-like: H = log(VR) / log(2) + 0.5
        H = np.clip(np.log(avg_vr + 1e-10) / np.log(2) * 0.5 + 0.5, 0.01, 0.99)
        
        recent = returns[-5:].mean() if len(returns) >= 5 else 0
        
        if H > 0.58:
            return np.clip(np.sign(recent) * (H - 0.5) * 5, -1, 1)
        elif H < 0.42:
            return np.clip(-np.sign(recent) * (0.5 - H) * 5, -1, 1)
        return 0.0
    
    @staticmethod
    def ou_with_halflife(prices, window=60):
        """OU with half-life estimation for better mean reversion timing"""
        if len(prices) < window:
            return 0.0
        
        log_p = np.log(prices[-window:])
        
        # Estimate OU parameters via OLS on: Δy = α + β·y(t-1) + ε
        y = log_p[1:]
        y_lag = log_p[:-1]
        delta_y = y - y_lag
        
        n = len(delta_y)
        if n < 10:
            return 0.0
        
        # OLS
        x = np.column_stack([np.ones(n), y_lag])
        try:
            beta_hat = np.linalg.lstsq(x, delta_y, rcond=None)[0]
        except:
            return 0.0
        
        theta = -beta_hat[1]  # mean reversion speed
        
        if theta <= 0:
            return 0.0  # not mean reverting
        
        mu = -beta_hat[0] / beta_hat[1] if abs(beta_hat[1]) > 1e-10 else log_p.mean()
        half_life = np.log(2) / theta
        
        # Only trade if half-life is reasonable (2-30 days)
        if half_life < 2 or half_life > 50:
            return 0.0
        
        residuals = delta_y - x @ beta_hat
        sigma = residuals.std()
        
        if sigma < 1e-10:
            return 0.0
        
        z = (log_p[-1] - mu) / sigma
        
        # Stronger signal when half-life is short (fast reversion)
        speed_multiplier = min(2.0, 10.0 / half_life)
        return np.clip(-z * speed_multiplier * 0.3, -1, 1)
    
    @staticmethod
    def regime_volatility(prices, window=60):
        """Improved regime detection with volatility clustering"""
        if len(prices) < window:
            return 0.0
        
        returns = np.diff(np.log(prices[-window:]))
        n = len(returns)
        
        # Split into thirds for better regime detection
        third = n // 3
        vol_early = returns[:third].std()
        vol_mid = returns[third:2*third].std()
        vol_recent = returns[2*third:].std()
        
        trend_short = returns[-10:].mean() if n >= 10 else 0
        trend_long = returns[-30:].mean() if n >= 30 else returns.mean()
        
        # Trend alignment + declining volatility = strong signal
        if vol_recent < vol_mid < vol_early and trend_short > 0:
            return min(1.0, abs(trend_short) * 50 + 0.3)
        elif vol_recent < vol_mid < vol_early and trend_short < 0:
            return max(-1.0, -abs(trend_short) * 50 - 0.3)
        
        # Rising volatility = reduce confidence
        if vol_recent > vol_early * 1.5:
            return 0.0
        
        # Default: weak momentum signal
        return np.clip(trend_short * 20, -0.5, 0.5)
    
    @staticmethod
    def entropy_filter(prices, window=25):
        """Entropy as confidence filter on trend"""
        if len(prices) < window + 1:
            return 0.0
        
        returns = np.diff(np.log(prices[-window-1:]))
        
        n_bins = 7
        counts, _ = np.histogram(returns, bins=n_bins)
        probs = counts / counts.sum()
        probs = probs[probs > 0]
        H = -np.sum(probs * np.log2(probs)) / np.log2(n_bins)
        
        trend = returns[-7:].mean()
        
        # Low entropy → high confidence → strong signal
        # High entropy → low confidence → zero signal
        confidence = np.clip(1.0 - H * 1.3, 0, 1)
        return np.clip(np.sign(trend) * confidence * (abs(trend) * 50 + 0.2), -1, 1)
    
    @staticmethod
    def bayesian_momentum(prices, window=40):
        """Bayesian momentum with adaptive prior"""
        if len(prices) < window:
            return 0.0
        
        returns = np.diff(np.log(prices[-window:]))
        
        # Adaptive prior: use long-term drift
        prior_mean = returns[:len(returns)//2].mean() if len(returns) > 10 else 0
        prior_var = max(returns[:len(returns)//2].var(), 1e-8) if len(returns) > 10 else 0.01
        
        recent = returns[-10:]
        data_mean = recent.mean()
        data_var = max(recent.var() / len(recent), 1e-15)
        
        post_var = 1 / (1/prior_var + 1/data_var)
        post_mean = post_var * (prior_mean/prior_var + data_mean/data_var)
        
        confidence = min(1.0, np.sqrt(prior_var / max(post_var, 1e-15)) * 0.5)
        return np.clip(post_mean / max(abs(post_mean), 1e-8) * confidence, -1, 1)
    
    @staticmethod
    def pairs_spread(btc_prices, eth_prices, window=60):
        """NEW: BTC/ETH ratio spread mean reversion"""
        if len(btc_prices) < window or len(eth_prices) < window:
            return 0.0
        
        # Log ratio
        ratio = np.log(btc_prices[-window:] / eth_prices[-window:])
        
        mean_ratio = ratio.mean()
        std_ratio = ratio.std()
        
        if std_ratio < 1e-10:
            return 0.0
        
        z = (ratio[-1] - mean_ratio) / std_ratio
        
        # If ratio too high → BTC overpriced relative to ETH → short BTC
        # If ratio too low → BTC underpriced → long BTC
        return np.clip(-z * 0.4, -1, 1)
    
    @staticmethod
    def all_signals(btc_prices, eth_prices=None):
        """Generate all 6 signals"""
        sigs = [
            V2Signals.hurst_variance_ratio(btc_prices),
            V2Signals.ou_with_halflife(btc_prices),
            V2Signals.regime_volatility(btc_prices),
            V2Signals.entropy_filter(btc_prices),
            V2Signals.bayesian_momentum(btc_prices),
            V2Signals.pairs_spread(btc_prices, eth_prices) if eth_prices is not None else 0.0,
        ]
        return np.array(sigs)


# ============================================================
# LOAD DATA
# ============================================================

print("Loading BTC and ETH data...")

with open('/home/claude/btc_raw.json') as f:
    btc_data = json.load(f)
with open('/home/claude/eth_raw.json') as f:
    eth_data = json.load(f)

# Align dates
common_dates = sorted(set(btc_data.keys()) & set(eth_data.keys()))
btc_prices = np.array([btc_data[d] for d in common_dates])
eth_prices = np.array([eth_data[d] for d in common_dates])
dates = common_dates

print(f"Aligned: {len(dates)} daily bars")
print(f"Period: {dates[0]} → {dates[-1]}")
print(f"BTC: ${btc_prices[0]:,.0f} → ${btc_prices[-1]:,.0f} ({(btc_prices[-1]/btc_prices[0]-1)*100:.1f}%)")
print(f"ETH: ${eth_prices[0]:,.0f} → ${eth_prices[-1]:,.0f} ({(eth_prices[-1]/eth_prices[0]-1)*100:.1f}%)")
print(f"BTC/ETH ratio: {btc_prices[0]/eth_prices[0]:.1f} → {btc_prices[-1]/eth_prices[-1]:.1f}")

# ============================================================
# WALK-FORWARD BACKTEST
# ============================================================

print("\n" + "=" * 60)
print("Ψ v2 WALK-FORWARD BACKTEST")
print("=" * 60)

warmup = 120  # Need more warmup for better signals

# Train period: first 60%
split = int(len(dates) * 0.6)
print(f"Train: {dates[0]} → {dates[split-1]} ({split} bars)")
print(f"Test:  {dates[split]} → {dates[-1]} ({len(dates)-split} bars)")

# Phase 1: Train — learn weights
train_engine = PsiV2Engine()
sg = V2Signals()

for t in range(warmup, split - 1):
    btc_window = btc_prices[:t+1]
    eth_window = eth_prices[:t+1]
    returns = np.diff(np.log(btc_prices[max(0,t-20):t+1]))
    
    if len(returns) < 5:
        continue
    
    signals = sg.all_signals(btc_window, eth_window)
    train_engine.compute_psi(signals, returns)
    next_ret = np.log(btc_prices[t+1] / btc_prices[t])
    train_engine.update_weights(signals, next_ret)

print(f"\nTrained weights: {dict(zip(['Hurst','OU','Regime','Entropy','Bayesian','Pairs'], [f'{w:.3f}' for w in train_engine.weights]))}")

# Phase 2: Test — OOS with continued learning
test_engine = PsiV2Engine()
test_engine.weights = train_engine.weights.copy()

psi_equity = [1.0]
naive_equity = [1.0]
bh_equity = [1.0]
psi_positions = []
coherences = []
psi_values = []
betas = []
trade_log = []

btc_returns = np.diff(np.log(btc_prices))

for t in range(split, len(dates) - 1):
    btc_window = btc_prices[:t+1]
    eth_window = eth_prices[:t+1]
    recent_rets = btc_returns[max(0,t-21):t]
    
    if len(recent_rets) < 5:
        psi_equity.append(psi_equity[-1])
        naive_equity.append(naive_equity[-1])
        bh_equity.append(bh_equity[-1])
        continue
    
    signals = sg.all_signals(btc_window, eth_window)
    result = test_engine.compute_psi(signals, recent_rets)
    
    psi_pos = result['psi']
    naive_pos = np.mean(signals) * 0.25
    
    psi_positions.append(psi_pos)
    coherences.append(result['coherence'])
    psi_values.append(result['psi'])
    betas.append(result['beta'])
    
    next_ret = btc_returns[t]
    
    psi_equity.append(psi_equity[-1] * (1 + psi_pos * next_ret))
    naive_equity.append(naive_equity[-1] * (1 + naive_pos * next_ret))
    bh_equity.append(bh_equity[-1] * (1 + next_ret))
    
    test_engine.update_weights(signals, next_ret)
    
    trade_log.append({
        'date': dates[t],
        'btc': btc_prices[t],
        'psi': psi_pos,
        'C': result['coherence'],
        'beta': result['beta'],
        'S': result['signal'],
        'H': result['entropy'],
        'signals': signals.tolist(),
    })


# ============================================================
# COMPUTE & PRINT RESULTS
# ============================================================

def stats(equity, name):
    eq = np.array(equity)
    rets = np.diff(eq) / eq[:-1]
    rets = rets[np.isfinite(rets)]
    total = (eq[-1]/eq[0] - 1) * 100
    sharpe = (rets.mean() / rets.std() * np.sqrt(365)) if rets.std() > 0 else 0
    peak = np.maximum.accumulate(eq)
    dd = ((eq - peak) / peak).min() * 100
    downside = rets[rets < 0]
    sortino = (rets.mean() / downside.std() * np.sqrt(365)) if len(downside) > 0 and downside.std() > 0 else 0
    calmar = total / abs(dd) if dd != 0 else 0
    return {'name': name, 'return': round(total,2), 'sharpe': round(sharpe,3),
            'sortino': round(sortino,3), 'max_dd': round(dd,2), 'calmar': round(calmar,3)}

r_psi = stats(psi_equity, 'Ψ v2')
r_naive = stats(naive_equity, 'Naive avg')
r_bh = stats(bh_equity, 'Buy&Hold')

print(f"\n{'Strategy':<15} {'Return':>10} {'Sharpe':>8} {'Sortino':>8} {'MaxDD':>8} {'Calmar':>8}")
print("-" * 62)
for r in [r_psi, r_naive, r_bh]:
    print(f"{r['name']:<15} {r['return']:>9.1f}% {r['sharpe']:>8.3f} {r['sortino']:>8.3f} {r['max_dd']:>7.1f}% {r['calmar']:>8.3f}")

# Final weights
print(f"\nFinal weights: {dict(zip(['Hurst','OU','Regime','Entropy','Bayesian','Pairs'], [f'{w:.3f}' for w in test_engine.weights]))}")

# Coherence analysis
coh = np.array(coherences)
print(f"\nCoherence: mean={coh.mean():.3f}, std={coh.std():.3f}, max={coh.max():.3f}")
print(f"% time C > 0.3: {(coh > 0.3).mean()*100:.1f}%")
print(f"% time C > 0.5: {(coh > 0.5).mean()*100:.1f}%")
print(f"% time C > 0.7: {(coh > 0.7).mean()*100:.1f}%")

# Beta analysis
b = np.array(betas)
print(f"\nβ: mean={b.mean():.2f}, std={b.std():.2f}, min={b.min():.2f}, max={b.max():.2f}")

# Position analysis
pos = np.array(psi_positions)
print(f"\nPositions: mean={pos.mean():.5f}, std={pos.std():.5f}")
print(f"Active (|pos| > 0.5%): {(np.abs(pos) > 0.005).mean()*100:.1f}% of time")

# Performance by coherence level
oos_rets = btc_returns[split:split+len(pos)]
for thresh in [0.3, 0.4, 0.5, 0.6]:
    mask = coh[:len(oos_rets)] > thresh
    if mask.sum() > 5:
        pnls = pos[:len(oos_rets)][mask] * oos_rets[mask]
        wr = (pnls > 0).mean() * 100
        avg = pnls.mean() * 10000
        print(f"  C > {thresh}: {mask.sum()} bars, win rate {wr:.1f}%, avg PnL {avg:.1f} bps")

# Monthly breakdown
print(f"\n{'Month':<10} {'Ψ v2':>10} {'B&H':>10} {'Avg C':>8} {'Avg β':>8}")
print("-" * 50)
monthly = defaultdict(lambda: {'psi': 0, 'bh': 0, 'c': [], 'b': [], 'n': 0})
for i, td in enumerate(trade_log):
    if i >= len(oos_rets):
        break
    m = td['date'][:7]
    monthly[m]['psi'] += psi_positions[i] * oos_rets[i]
    monthly[m]['bh'] += oos_rets[i]
    monthly[m]['c'].append(td['C'])
    monthly[m]['b'].append(td['beta'])
    monthly[m]['n'] += 1

for m in sorted(monthly.keys()):
    d = monthly[m]
    ac = np.mean(d['c']) if d['c'] else 0
    ab = np.mean(d['b']) if d['b'] else 0
    print(f"{m:<10} {d['psi']*100:>9.2f}% {d['bh']*100:>9.2f}% {ac:>8.3f} {ab:>8.2f}")

# ============================================================
# v1 vs v2 COMPARISON
# ============================================================

print("\n" + "=" * 60)
print("v1 vs v2 COMPARISON")
print("=" * 60)

# Run v1 on same test period
sys.path.insert(0, '/home/claude')
from psi_validation import PsiEngine, PsiConfig, SignalGenerators

v1_engine = PsiEngine()
v1_sg = SignalGenerators()

# Train v1
for t in range(120, split - 1):
    price_window = btc_prices[:t+1]
    rets = np.diff(np.log(btc_prices[max(0,t-20):t+1]))
    if len(rets) < 5:
        continue
    sigs = v1_sg.all_signals(price_window)
    v1_engine.compute_psi(sigs, rets)
    v1_engine.update_weights(sigs, np.log(btc_prices[t+1]/btc_prices[t]))

# Test v1
v1_equity = [1.0]
for t in range(split, len(dates) - 1):
    price_window = btc_prices[:t+1]
    rets = np.diff(np.log(btc_prices[max(0,t-20):t+1]))
    if len(rets) < 5:
        v1_equity.append(v1_equity[-1])
        continue
    sigs = v1_sg.all_signals(price_window)
    result = v1_engine.compute_psi(sigs, rets)
    next_ret = btc_returns[t]
    v1_equity.append(v1_equity[-1] * (1 + result['psi'] * next_ret))
    v1_engine.update_weights(sigs, next_ret)

r_v1 = stats(v1_equity, 'Ψ v1')
r_v2 = r_psi

print(f"\n{'Metric':<20} {'v1':>12} {'v2':>12} {'Δ':>12}")
print("-" * 58)
for metric in ['return', 'sharpe', 'sortino', 'max_dd', 'calmar']:
    v1_val = r_v1[metric]
    v2_val = r_v2[metric]
    delta = v2_val - v1_val
    unit = '%' if metric in ['return', 'max_dd'] else ''
    print(f"{metric:<20} {v1_val:>11.3f}{unit} {v2_val:>11.3f}{unit} {delta:>+11.3f}")

print("\nDONE.")
