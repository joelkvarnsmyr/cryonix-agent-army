#!/usr/bin/env python3
"""
Ψ Phase Convergence — REAL DATA BACKTEST
==========================================
BTC-USD daily prices, March 2024 — March 2026
"""

import numpy as np
import json, sys

# Import engine from our validation module
sys.path.insert(0, '/home/claude')
from psi_validation import (PsiEngine, PsiConfig, SignalGenerators, 
                             Backtester, MarketSimulator)

# ============================================================
# LOAD REAL DATA
# ============================================================

btc_data = json.loads(open('/home/claude/btc_raw.json').read())

dates = sorted(btc_data.keys())
prices = np.array([btc_data[d] for d in dates])

print(f"BTC-USD: {len(prices)} daily bars")
print(f"Period: {dates[0]} → {dates[-1]}")
print(f"Start: ${prices[0]:,.0f}  End: ${prices[-1]:,.0f}")
print(f"Buy&Hold return: {(prices[-1]/prices[0]-1)*100:.1f}%")
print()

# ============================================================
# SPLIT INTO TRAIN / TEST
# ============================================================

split_idx = int(len(prices) * 0.6)
split_date = dates[split_idx]

train_prices = prices[:split_idx]
test_prices = prices[split_idx:]
train_dates = dates[:split_idx]
test_dates = dates[split_idx:]

print(f"TRAIN: {train_dates[0]} → {train_dates[-1]} ({len(train_prices)} bars)")
print(f"TEST:  {test_dates[0]} → {test_dates[-1]} ({len(test_prices)} bars)")
print()

# ============================================================
# FULL PERIOD BACKTEST
# ============================================================

print("=" * 60)
print("FULL PERIOD BACKTEST (in-sample)")
print("=" * 60)

bt_full = Backtester(prices, warmup=150)

results = {}
results['psi'] = bt_full.run_psi_strategy()
results['naive'] = bt_full.run_naive_average()
results['bh'] = bt_full.run_buy_hold()

signal_names = ['Hurst only', 'OU-spread only', 'Regime only', 
                'Entropy only', 'Bayesian only']
for i, name in enumerate(signal_names):
    results[name] = bt_full.run_single_signal(i, name)

print(f"\n{'Strategy':<20} {'Return':>10} {'Sharpe':>8} {'Sortino':>8} {'MaxDD':>8} {'WinRate':>8} {'Calmar':>8}")
print("-" * 82)
for key in ['psi', 'naive', 'bh'] + signal_names:
    r = results[key]
    print(f"{r['name']:<20} {r['total_return']:>9.1f}% {r['sharpe']:>8.3f} {r['sortino']:>8.3f} {r['max_drawdown']:>7.1f}% {r.get('win_rate',0):>7.1f}% {r['calmar']:>8.3f}")

if results['psi'].get('final_weights'):
    print(f"\nFinal Bayesian weights: {results['psi']['final_weights']}")
if results['psi'].get('psi_stats'):
    print(f"Ψ stats: {results['psi']['psi_stats']}")
if results['psi'].get('avg_coherence'):
    print(f"Avg coherence: {results['psi']['avg_coherence']}")
    print(f"Avg entropy: {results['psi'].get('avg_entropy', 'N/A')}")

# ============================================================
# OUT-OF-SAMPLE TEST
# ============================================================

print("\n" + "=" * 60)
print("OUT-OF-SAMPLE TEST")
print("=" * 60)
print(f"Training on: {train_dates[0]} → {train_dates[-1]}")
print(f"Testing on:  {test_dates[0]} → {test_dates[-1]}")

# Train: let the engine warm up and learn weights
train_engine = PsiEngine()
sg = SignalGenerators()
warmup = 150

for t in range(warmup, len(train_prices) - 1):
    price_window = train_prices[:t+1]
    returns = np.diff(np.log(train_prices[max(0,t-20):t+1]))
    if len(returns) < 5:
        continue
    signals = sg.all_signals(price_window)
    train_engine.compute_psi(signals, returns)
    next_ret = np.log(train_prices[t+1] / train_prices[t])
    train_engine.update_weights(signals, next_ret)

print(f"\nWeights learned in training: {dict(zip(['Hurst','OU','Regime','Entropy','Bayesian'], [f'{w:.4f}' for w in train_engine.weights]))}")

# Test: use learned weights on unseen data
test_engine = PsiEngine()
test_engine.weights = train_engine.weights.copy()  # Transfer learned weights

psi_equity = [1.0]
naive_equity = [1.0]
bh_equity = [1.0]

# We need history for signals, so prepend some training data
history_buffer = 200
full_test = np.concatenate([train_prices[-history_buffer:], test_prices])
test_start = history_buffer

psi_positions = []
psi_coherences = []
psi_values_list = []
trade_details = []

for t in range(test_start, len(full_test) - 1):
    price_window = full_test[:t+1]
    recent_returns = np.diff(np.log(full_test[max(0,t-20):t+1]))
    
    if len(recent_returns) < 5:
        psi_equity.append(psi_equity[-1])
        naive_equity.append(naive_equity[-1])
        bh_equity.append(bh_equity[-1])
        continue
    
    signals = sg.all_signals(price_window)
    
    # Ψ strategy
    result = test_engine.compute_psi(signals, recent_returns)
    psi_pos = result['psi']
    psi_positions.append(psi_pos)
    psi_coherences.append(result['coherence'])
    psi_values_list.append(result['psi'])
    
    # Naive strategy
    naive_pos = np.mean(signals) * 0.25
    
    # Next return
    next_ret = np.log(full_test[t+1] / full_test[t])
    
    psi_equity.append(psi_equity[-1] * (1 + psi_pos * next_ret))
    naive_equity.append(naive_equity[-1] * (1 + naive_pos * next_ret))
    bh_equity.append(bh_equity[-1] * (1 + next_ret))
    
    # Continue learning
    test_engine.update_weights(signals, next_ret)
    
    # Track trade details for analysis
    actual_date_idx = t - test_start
    if actual_date_idx >= 0 and actual_date_idx < len(test_dates):
        trade_details.append({
            'date': test_dates[actual_date_idx],
            'price': full_test[t],
            'psi': psi_pos,
            'coherence': result['coherence'],
            'signal': result['signal'],
            'entropy': result['entropy'],
            'signals': signals.tolist(),
        })

# Compute OOS statistics
def compute_stats(equity, name):
    eq = np.array(equity)
    returns = np.diff(eq) / eq[:-1]
    returns = returns[np.isfinite(returns)]
    total_ret = (eq[-1] / eq[0] - 1) * 100
    sharpe = (returns.mean() / returns.std() * np.sqrt(365)) if returns.std() > 0 else 0
    peak = np.maximum.accumulate(eq)
    dd = ((eq - peak) / peak).min() * 100
    downside = returns[returns < 0]
    sortino = (returns.mean() / downside.std() * np.sqrt(365)) if len(downside) > 0 and downside.std() > 0 else 0
    calmar = total_ret / abs(dd) if dd != 0 else 0
    return {
        'name': name, 'return': round(total_ret, 2), 'sharpe': round(sharpe, 3),
        'sortino': round(sortino, 3), 'max_dd': round(dd, 2),
        'calmar': round(calmar, 3), 'final_equity': round(eq[-1], 4)
    }

oos_psi = compute_stats(psi_equity, 'Ψ')
oos_naive = compute_stats(naive_equity, 'Naive')
oos_bh = compute_stats(bh_equity, 'Buy&Hold')

print(f"\n{'Strategy':<15} {'Return':>10} {'Sharpe':>8} {'Sortino':>8} {'MaxDD':>8} {'Calmar':>8}")
print("-" * 62)
for r in [oos_psi, oos_naive, oos_bh]:
    print(f"{r['name']:<15} {r['return']:>9.1f}% {r['sharpe']:>8.3f} {r['sortino']:>8.3f} {r['max_dd']:>7.1f}% {r['calmar']:>8.3f}")

print(f"\nFinal OOS weights: {dict(zip(['Hurst','OU','Regime','Entropy','Bayesian'], [f'{w:.4f}' for w in test_engine.weights]))}")

# ============================================================
# COHERENCE ANALYSIS
# ============================================================

print("\n" + "=" * 60)
print("COHERENCE ANALYSIS (Out-of-Sample)")
print("=" * 60)

coh = np.array(psi_coherences)
psi_vals = np.array(psi_values_list)

print(f"Mean coherence:  {coh.mean():.4f}")
print(f"Std coherence:   {coh.std():.4f}")
print(f"Max coherence:   {coh.max():.4f}")
print(f"Min coherence:   {coh.min():.4f}")
print(f"% time C > 0.5:  {(coh > 0.5).mean()*100:.1f}%")
print(f"% time C > 0.7:  {(coh > 0.7).mean()*100:.1f}%")
print(f"% time |Ψ| > 0.01: {(np.abs(psi_vals) > 0.01).mean()*100:.1f}%")

# Performance split by coherence level
if len(psi_positions) > 0:
    pos = np.array(psi_positions[:len(psi_equity)-1])
    rets_oos = np.diff(np.log(full_test[test_start:]))[:len(pos)]
    coh_trim = coh[:len(pos)]
    
    for threshold in [0.3, 0.5, 0.7]:
        mask = coh_trim > threshold
        if mask.sum() > 10:
            pnls = pos[mask] * rets_oos[mask]
            win_rate = (pnls > 0).mean() * 100
            avg_pnl = pnls.mean() * 10000  # in bps
            print(f"\n  C > {threshold}: {mask.sum()} bars ({mask.mean()*100:.0f}%), win rate {win_rate:.1f}%, avg PnL {avg_pnl:.1f} bps")

# ============================================================
# MONTHLY BREAKDOWN
# ============================================================

print("\n" + "=" * 60)
print("MONTHLY PERFORMANCE (Out-of-Sample)")
print("=" * 60)

if trade_details:
    from collections import defaultdict
    monthly = defaultdict(lambda: {'psi_pnl': 0.0, 'bh_pnl': 0.0, 'count': 0, 'avg_coh': []})
    
    for i, td in enumerate(trade_details):
        if i >= len(psi_positions):
            break
        month = td['date'][:7]
        ret_idx = i
        if ret_idx < len(rets_oos):
            monthly[month]['psi_pnl'] += psi_positions[i] * rets_oos[i]
            monthly[month]['bh_pnl'] += rets_oos[i]
            monthly[month]['count'] += 1
            monthly[month]['avg_coh'].append(psi_coherences[i] if i < len(psi_coherences) else 0)
    
    print(f"\n{'Month':<10} {'Ψ PnL':>10} {'B&H PnL':>10} {'Avg C':>8} {'Bars':>6}")
    print("-" * 50)
    for month in sorted(monthly.keys()):
        m = monthly[month]
        avg_c = np.mean(m['avg_coh']) if m['avg_coh'] else 0
        print(f"{month:<10} {m['psi_pnl']*100:>9.2f}% {m['bh_pnl']*100:>9.2f}% {avg_c:>8.3f} {m['count']:>6}")

# ============================================================
# SAVE EQUITY CURVES FOR VISUALIZATION
# ============================================================

output = {
    'test_dates': test_dates[:len(psi_equity)],
    'psi_equity': [round(x, 6) for x in psi_equity],
    'naive_equity': [round(x, 6) for x in naive_equity],
    'bh_equity': [round(x, 6) for x in bh_equity],
    'coherences': [round(x, 4) for x in psi_coherences[:200]],  # sample
    'oos_results': {
        'psi': oos_psi,
        'naive': oos_naive,
        'bh': oos_bh,
    },
    'full_results': {
        'psi': {k: v for k, v in results['psi'].items() if k != 'equity_curve'},
        'naive': {k: v for k, v in results['naive'].items() if k != 'equity_curve'},
        'bh': {k: v for k, v in results['bh'].items() if k != 'equity_curve'},
    }
}

with open('/home/claude/btc_backtest_results.json', 'w') as f:
    json.dump(output, f, indent=2, default=lambda x: float(x) if hasattr(x, '__float__') else str(x))

print("\n\nResults saved to btc_backtest_results.json")
print("DONE.")
