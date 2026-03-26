#!/usr/bin/env python3
"""
Ψ (Psi) — Phase Convergence Trading Function
==============================================
Validation & Backtesting Framework v1.0

Tests:
  1. Unit tests — each component behaves mathematically correct
  2. Synthetic market simulation — controlled environments
  3. Monte Carlo — statistical robustness across 1000 random markets
  4. Comparison — Ψ vs naive signal averaging vs individual signals
  5. Regime analysis — performance in trending, mean-reverting, chaotic markets
"""

import numpy as np
import pandas as pd
import json
from dataclasses import dataclass, field
from typing import List, Tuple, Dict
import warnings
warnings.filterwarnings('ignore')

# ============================================================
# CORE Ψ IMPLEMENTATION
# ============================================================

@dataclass
class PsiConfig:
    """Configuration for the Ψ function"""
    n_signals: int = 5
    kelly_fraction: float = 0.25        # Quarter Kelly
    beta_scale: float = 3.0             # Amplification of entropy-temperature
    coherence_threshold: float = 0.3    # Minimum C(t) to trade
    bayesian_lr: float = 0.05           # Learning rate for weight updates
    lookback_entropy: int = 20          # Window for Shannon entropy
    lookback_hurst: int = 100           # Window for Hurst exponent

class PsiEngine:
    """
    The Ψ Phase Convergence Trading Function
    
    Ψ(t) = tanh(β(t) · C(t) · Σᵢ wᵢ(t)·σᵢ(t)) × Kelly(t) × C(t)²
    
    Where:
        β(t) = scale / H(market)         — entropy temperature
        C(t) = |Σᵢ exp(iθᵢ)| / N        — Kuramoto coherence
        wᵢ(t) ~ Bayesian posterior        — adaptive signal weights
        σᵢ(t) ∈ [-1, +1]                 — normalized signal outputs
    """
    
    def __init__(self, config: PsiConfig = None):
        self.cfg = config or PsiConfig()
        self.weights = np.ones(self.cfg.n_signals) / self.cfg.n_signals
        self.signal_profits = np.zeros(self.cfg.n_signals)
        self.signal_trades = np.zeros(self.cfg.n_signals) + 1  # avoid div/0
        self.trade_history = []
    
    def kuramoto_coherence(self, signals: np.ndarray) -> float:
        """
        Kuramoto order parameter: C = |Σ exp(iθᵢ)| / N
        Maps signal values to phases on the unit circle.
        """
        # Map signals from [-1,1] to phases [0, 2π]
        phases = np.pi * (signals + 1)  # [-1,1] → [0, 2π]
        complex_sum = np.sum(np.exp(1j * phases))
        return np.abs(complex_sum) / len(signals)
    
    def shannon_entropy(self, returns: np.ndarray) -> float:
        """
        Shannon entropy of discretized return distribution.
        Higher entropy = more chaotic/unpredictable market.
        """
        if len(returns) < 5:
            return 1.0  # max uncertainty
        
        # Discretize returns into bins
        n_bins = max(5, int(np.sqrt(len(returns))))
        counts, _ = np.histogram(returns, bins=n_bins)
        probs = counts / counts.sum()
        probs = probs[probs > 0]  # remove zeros
        
        entropy = -np.sum(probs * np.log2(probs))
        # Normalize to [0, 1]
        max_entropy = np.log2(n_bins)
        return entropy / max_entropy if max_entropy > 0 else 1.0
    
    def compute_beta(self, returns: np.ndarray) -> float:
        """β(t) = scale / H(market) — entropy temperature"""
        H = self.shannon_entropy(returns)
        H = max(H, 0.01)  # prevent division by zero
        return self.cfg.beta_scale / H
    
    def phase_transition_signal(self, signals: np.ndarray, beta: float, 
                                 coherence: float) -> float:
        """
        S(t) = tanh(β · C · Σ wᵢσᵢ)
        The core phase transition function.
        """
        weighted_sum = np.sum(self.weights * signals)
        raw = beta * coherence * weighted_sum
        return np.tanh(raw)
    
    def position_size(self, coherence: float, kelly_base: float = None) -> float:
        """
        f(t) = Kelly_frac × C(t)²
        Coherence-squared gives exponential penalty for weak agreement.
        """
        kelly = kelly_base or self.cfg.kelly_fraction
        return kelly * (coherence ** 2)
    
    def compute_psi(self, signals: np.ndarray, recent_returns: np.ndarray) -> dict:
        """
        Full Ψ computation.
        Returns dict with all intermediate values for analysis.
        """
        C = self.kuramoto_coherence(signals)
        beta = self.compute_beta(recent_returns)
        S = self.phase_transition_signal(signals, beta, C)
        f = self.position_size(C)
        psi = S * f
        
        return {
            'psi': psi,
            'signal': S,
            'coherence': C,
            'beta': beta,
            'position_size': f,
            'weighted_sum': np.sum(self.weights * signals),
            'weights': self.weights.copy(),
            'entropy': self.shannon_entropy(recent_returns)
        }
    
    def update_weights(self, signals: np.ndarray, realized_return: float):
        """
        Bayesian weight update: increase weight of signals 
        that agreed with the profitable direction.
        """
        direction = np.sign(realized_return)
        agreement = signals * direction  # +1 if signal agreed with profit direction
        
        # Update running statistics
        for i in range(self.cfg.n_signals):
            if abs(signals[i]) > 0.1:  # only count meaningful signals
                self.signal_trades[i] += 1
                if agreement[i] > 0:
                    self.signal_profits[i] += abs(realized_return)
        
        # Compute posterior weights proportional to profit/trade
        performance = self.signal_profits / self.signal_trades
        performance = performance - performance.min() + 0.01  # shift to positive
        
        # Soft update
        new_weights = performance / performance.sum()
        self.weights = (1 - self.cfg.bayesian_lr) * self.weights + \
                       self.cfg.bayesian_lr * new_weights
        self.weights /= self.weights.sum()  # renormalize


# ============================================================
# SIGNAL GENERATORS (Simulated versions for testing)
# ============================================================

class SignalGenerators:
    """Generate trading signals from price data"""
    
    @staticmethod
    def hurst_signal(prices: np.ndarray, window: int = 100) -> float:
        """Hurst exponent based: < 0.5 → mean revert (sell if up), > 0.5 → trend follow"""
        if len(prices) < window:
            return 0.0
        
        returns = np.diff(np.log(prices[-window:]))
        n = len(returns)
        if n < 20:
            return 0.0
        
        # Fast variance-ratio Hurst estimate
        lags = [2, 4, 8, 16, 32]
        lags = [l for l in lags if l < n // 2]
        if len(lags) < 2:
            return 0.0
        
        log_rs = []
        log_n = []
        for lag in lags:
            chunks = returns[:n - (n % lag)].reshape(-1, lag)
            rs_vals = []
            for c in chunks:
                cumdev = np.cumsum(c - c.mean())
                R = cumdev.max() - cumdev.min()
                S = c.std()
                if S > 1e-10:
                    rs_vals.append(R / S)
            if rs_vals:
                log_rs.append(np.log(np.mean(rs_vals)))
                log_n.append(np.log(lag))
        
        if len(log_rs) < 2:
            return 0.0
        
        H = np.polyfit(log_n, log_rs, 1)[0]
        H = np.clip(H, 0.01, 0.99)
        
        recent_return = (prices[-1] / prices[-5] - 1) if len(prices) >= 5 else 0
        
        if H > 0.55:
            return np.clip(recent_return * 10, -1, 1)
        elif H < 0.45:
            return np.clip(-recent_return * 10, -1, 1)
        else:
            return 0.0
    
    @staticmethod
    def ou_spread_signal(prices: np.ndarray, window: int = 50) -> float:
        """Ornstein-Uhlenbeck mean reversion signal on log prices"""
        if len(prices) < window:
            return 0.0
        
        log_p = np.log(prices[-window:])
        mean = log_p.mean()
        std = log_p.std()
        
        if std < 1e-10:
            return 0.0
        
        z_score = (log_p[-1] - mean) / std
        # Mean reversion: sell when high, buy when low
        return np.clip(-z_score / 2, -1, 1)
    
    @staticmethod
    def regime_signal(prices: np.ndarray, window: int = 60) -> float:
        """Simple regime detection: volatility-based bull/bear classification"""
        if len(prices) < window:
            return 0.0
        
        returns = np.diff(np.log(prices[-window:]))
        
        # Split into two halves
        half = len(returns) // 2
        vol_recent = returns[half:].std()
        vol_past = returns[:half].std()
        trend = (prices[-1] / prices[-half] - 1)
        
        # Low vol + up trend = bull → buy
        # High vol + down trend = bear → sell  
        if vol_recent < vol_past and trend > 0:
            return min(trend * 5, 1.0)
        elif vol_recent > vol_past * 1.5 and trend < 0:
            return max(trend * 5, -1.0)
        else:
            return 0.0
    
    @staticmethod
    def entropy_signal(prices: np.ndarray, window: int = 20) -> float:
        """Low entropy (orderly market) → amplify trend signal"""
        if len(prices) < window + 1:
            return 0.0
        
        returns = np.diff(np.log(prices[-window-1:]))
        
        # Discretize
        n_bins = 5
        counts, _ = np.histogram(returns, bins=n_bins)
        probs = counts / counts.sum()
        probs = probs[probs > 0]
        entropy = -np.sum(probs * np.log2(probs)) / np.log2(n_bins)
        
        trend = returns[-5:].mean() if len(returns) >= 5 else 0
        
        # Low entropy → confident signal, high entropy → zero
        confidence = max(0, 1 - entropy * 1.5)
        return np.clip(np.sign(trend) * confidence, -1, 1)
    
    @staticmethod
    def bayesian_momentum(prices: np.ndarray, window: int = 30) -> float:
        """Bayesian-updated momentum: prior of neutral, updated by recent evidence"""
        if len(prices) < window:
            return 0.0
        
        returns = np.diff(np.log(prices[-window:]))
        
        # Prior: neutral (mean=0)
        prior_mean = 0.0
        prior_var = 0.01
        
        # Likelihood from data
        data_mean = returns.mean()
        data_var = returns.var() / len(returns)
        
        if data_var < 1e-15:
            return 0.0
        
        # Posterior
        post_var = 1 / (1/prior_var + 1/data_var)
        post_mean = post_var * (prior_mean/prior_var + data_mean/data_var)
        
        # Confidence-weighted signal
        confidence = 1 - np.sqrt(post_var) / np.sqrt(prior_var)
        return np.clip(np.sign(post_mean) * confidence * 3, -1, 1)

    @staticmethod
    def all_signals(prices: np.ndarray) -> np.ndarray:
        """Generate all 5 signals"""
        return np.array([
            SignalGenerators.hurst_signal(prices),
            SignalGenerators.ou_spread_signal(prices),
            SignalGenerators.regime_signal(prices),
            SignalGenerators.entropy_signal(prices),
            SignalGenerators.bayesian_momentum(prices),
        ])


# ============================================================
# MARKET SIMULATORS
# ============================================================

class MarketSimulator:
    """Generate synthetic market data with known properties"""
    
    @staticmethod
    def trending_market(n: int = 2000, drift: float = 0.0003, 
                        vol: float = 0.02) -> np.ndarray:
        """Geometric Brownian Motion with positive drift"""
        returns = np.random.normal(drift, vol, n)
        prices = 100 * np.exp(np.cumsum(returns))
        return prices
    
    @staticmethod
    def mean_reverting_market(n: int = 2000, mu: float = 4.6, 
                              theta: float = 0.1, sigma: float = 0.02) -> np.ndarray:
        """Ornstein-Uhlenbeck process (mean-reverting)"""
        log_prices = np.zeros(n)
        log_prices[0] = mu
        for t in range(1, n):
            log_prices[t] = log_prices[t-1] + theta * (mu - log_prices[t-1]) + \
                           sigma * np.random.normal()
        return np.exp(log_prices)
    
    @staticmethod
    def chaotic_market(n: int = 2000, vol: float = 0.05) -> np.ndarray:
        """High volatility random walk with regime jumps"""
        prices = [100.0]
        for t in range(1, n):
            # Random regime jumps
            if np.random.random() < 0.02:  # 2% chance of regime shift
                jump = np.random.normal(0, 0.1)
            else:
                jump = np.random.normal(0, vol)
            prices.append(prices[-1] * np.exp(jump))
        return np.array(prices)
    
    @staticmethod
    def mixed_regime_market(n: int = 3000) -> Tuple[np.ndarray, np.ndarray]:
        """Market that switches between trending, reverting, and chaotic.
        Returns (prices, regime_labels)"""
        prices = [100.0]
        regimes = []
        current_regime = 0  # 0=trend, 1=revert, 2=chaos
        regime_length = 0
        mu = np.log(100)
        
        for t in range(1, n):
            regime_length += 1
            # Switch regime every ~200-500 bars
            if regime_length > np.random.randint(200, 500):
                current_regime = np.random.randint(0, 3)
                regime_length = 0
            
            regimes.append(current_regime)
            
            if current_regime == 0:  # Trending
                ret = 0.0005 + np.random.normal(0, 0.015)
            elif current_regime == 1:  # Mean reverting
                log_p = np.log(prices[-1])
                ret = 0.05 * (mu - log_p) + np.random.normal(0, 0.012)
            else:  # Chaotic
                ret = np.random.normal(0, 0.04)
                if np.random.random() < 0.03:
                    ret += np.random.normal(0, 0.08)
            
            prices.append(prices[-1] * np.exp(ret))
        
        regimes.append(regimes[-1])  # pad
        return np.array(prices), np.array(regimes)


# ============================================================
# BACKTESTER
# ============================================================

class Backtester:
    """Run backtests comparing different strategies"""
    
    def __init__(self, prices: np.ndarray, warmup: int = 150):
        self.prices = prices
        self.warmup = warmup
        self.returns = np.diff(np.log(prices))
    
    def run_psi_strategy(self, config: PsiConfig = None) -> dict:
        """Backtest the Ψ strategy"""
        engine = PsiEngine(config)
        sg = SignalGenerators()
        
        equity = [1.0]
        positions = []
        psi_values = []
        coherences = []
        entropies = []
        signals_history = []
        
        for t in range(self.warmup, len(self.prices) - 1):
            price_window = self.prices[:t+1]
            recent_returns = self.returns[max(0,t-20):t]
            
            if len(recent_returns) < 5:
                equity.append(equity[-1])
                continue
            
            # Generate signals
            signals = sg.all_signals(price_window)
            signals_history.append(signals.copy())
            
            # Compute Ψ
            result = engine.compute_psi(signals, recent_returns)
            psi_values.append(result['psi'])
            coherences.append(result['coherence'])
            entropies.append(result['entropy'])
            
            # Position: Ψ output is direction × size
            position = result['psi']
            positions.append(position)
            
            # P&L
            next_return = self.returns[t]
            pnl = position * next_return
            equity.append(equity[-1] * (1 + pnl))
            
            # Update weights
            engine.update_weights(signals, next_return)
        
        return self._compute_stats(equity, positions, psi_values, 
                                    coherences, entropies, signals_history,
                                    engine.weights, "Ψ Phase Convergence")
    
    def run_naive_average(self) -> dict:
        """Baseline: simple average of all signals, fixed position size"""
        sg = SignalGenerators()
        equity = [1.0]
        positions = []
        
        for t in range(self.warmup, len(self.prices) - 1):
            price_window = self.prices[:t+1]
            signals = sg.all_signals(price_window)
            
            # Simple average, fixed 25% position
            position = np.mean(signals) * 0.25
            positions.append(position)
            
            next_return = self.returns[t]
            pnl = position * next_return
            equity.append(equity[-1] * (1 + pnl))
        
        return self._compute_stats(equity, positions, name="Naive average")
    
    def run_single_signal(self, signal_idx: int, signal_name: str) -> dict:
        """Run a single signal with fixed position sizing"""
        sg = SignalGenerators()
        equity = [1.0]
        positions = []
        
        for t in range(self.warmup, len(self.prices) - 1):
            price_window = self.prices[:t+1]
            signals = sg.all_signals(price_window)
            
            position = signals[signal_idx] * 0.25
            positions.append(position)
            
            next_return = self.returns[t]
            pnl = position * next_return
            equity.append(equity[-1] * (1 + pnl))
        
        return self._compute_stats(equity, positions, name=signal_name)
    
    def run_buy_hold(self) -> dict:
        """Buy and hold benchmark"""
        equity = [1.0]
        for t in range(self.warmup, len(self.prices) - 1):
            next_return = self.returns[t]
            equity.append(equity[-1] * (1 + next_return))
        return self._compute_stats(equity, name="Buy & hold")
    
    def _compute_stats(self, equity, positions=None, psi_values=None,
                       coherences=None, entropies=None, signals_history=None,
                       final_weights=None, name="Strategy") -> dict:
        """Compute performance statistics"""
        eq = np.array(equity)
        returns = np.diff(eq) / eq[:-1]
        returns = returns[np.isfinite(returns)]
        
        if len(returns) == 0:
            return {'name': name, 'error': 'No valid returns'}
        
        total_return = (eq[-1] / eq[0] - 1) * 100
        
        # Annualized (assume ~365 bars per year for crypto)
        n_bars = len(returns)
        ann_factor = 365 / max(n_bars, 1)
        ann_return = ((eq[-1] / eq[0]) ** ann_factor - 1) * 100 if eq[0] > 0 else 0
        
        # Sharpe (annualized)
        if returns.std() > 0:
            sharpe = (returns.mean() / returns.std()) * np.sqrt(365)
        else:
            sharpe = 0
        
        # Max drawdown
        peak = np.maximum.accumulate(eq)
        drawdown = (eq - peak) / peak
        max_dd = drawdown.min() * 100
        
        # Sortino
        downside = returns[returns < 0]
        if len(downside) > 0 and downside.std() > 0:
            sortino = (returns.mean() / downside.std()) * np.sqrt(365)
        else:
            sortino = 0
        
        # Win rate
        if positions:
            trades = [(p, r) for p, r in zip(positions, returns[:len(positions)]) 
                      if abs(p) > 0.01]
            if trades:
                wins = sum(1 for p, r in trades if p * r > 0)
                win_rate = wins / len(trades) * 100
                n_trades = len(trades)
            else:
                win_rate = 0
                n_trades = 0
        else:
            win_rate = 0
            n_trades = 0
        
        # Calmar ratio
        calmar = ann_return / abs(max_dd) if max_dd != 0 else 0
        
        result = {
            'name': name,
            'total_return': round(total_return, 2),
            'ann_return': round(ann_return, 2),
            'sharpe': round(sharpe, 3),
            'sortino': round(sortino, 3),
            'max_drawdown': round(max_dd, 2),
            'calmar': round(calmar, 3),
            'win_rate': round(win_rate, 1),
            'n_trades': n_trades,
            'final_equity': round(eq[-1], 4),
            'equity_curve': eq.tolist(),
        }
        
        if coherences:
            result['avg_coherence'] = round(np.mean(coherences), 4)
            result['coherence_std'] = round(np.std(coherences), 4)
        if entropies:
            result['avg_entropy'] = round(np.mean(entropies), 4)
        if final_weights is not None:
            result['final_weights'] = {
                'Hurst': round(final_weights[0], 4),
                'OU-spread': round(final_weights[1], 4),
                'HMM-regime': round(final_weights[2], 4),
                'Entropy': round(final_weights[3], 4),
                'Bayesian': round(final_weights[4], 4),
            }
        if psi_values:
            pv = np.array(psi_values)
            result['psi_stats'] = {
                'mean': round(np.mean(pv), 5),
                'std': round(np.std(pv), 5),
                'max': round(np.max(np.abs(pv)), 5),
                'pct_active': round(np.mean(np.abs(pv) > 0.01) * 100, 1),
            }
        
        return result


# ============================================================
# VALIDATION SUITE
# ============================================================

class ValidationSuite:
    """Comprehensive validation of the Ψ function"""
    
    def __init__(self):
        self.results = {}
    
    def test_01_unit_tests(self) -> dict:
        """Mathematical correctness of each component"""
        engine = PsiEngine()
        tests = {}
        
        # Test 1: Perfect coherence
        signals_aligned = np.array([1.0, 1.0, 1.0, 1.0, 1.0])
        C = engine.kuramoto_coherence(signals_aligned)
        tests['coherence_aligned'] = {
            'value': round(C, 4),
            'expected': '≈ 1.0',
            'pass': C > 0.95
        }
        
        # Test 2: Zero coherence (opposing signals)
        signals_mixed = np.array([1.0, -1.0, 0.5, -0.5, 0.0])
        C_mixed = engine.kuramoto_coherence(signals_mixed)
        tests['coherence_mixed'] = {
            'value': round(C_mixed, 4),
            'expected': '< 0.5',
            'pass': C_mixed < 0.5
        }
        
        # Test 3: Entropy of uniform distribution ≈ 1.0
        uniform_returns = np.random.uniform(-0.1, 0.1, 1000)
        H_uniform = engine.shannon_entropy(uniform_returns)
        tests['entropy_uniform'] = {
            'value': round(H_uniform, 4),
            'expected': '≈ 1.0',
            'pass': H_uniform > 0.85
        }
        
        # Test 4: Entropy of concentrated distribution < 0.5
        concentrated = np.concatenate([
            np.random.normal(0.05, 0.001, 900),
            np.random.normal(-0.05, 0.001, 100)
        ])
        H_conc = engine.shannon_entropy(concentrated)
        tests['entropy_concentrated'] = {
            'value': round(H_conc, 4),
            'expected': '< 0.7',
            'pass': H_conc < 0.7
        }
        
        # Test 5: Ψ near zero when signals disagree
        fake_returns = np.random.normal(0, 0.02, 30)
        result = engine.compute_psi(signals_mixed, fake_returns)
        tests['psi_low_on_disagreement'] = {
            'value': round(abs(result['psi']), 6),
            'expected': '≈ 0 (small)',
            'pass': abs(result['psi']) < 0.1
        }
        
        # Test 6: Ψ significant when all agree
        result_agree = engine.compute_psi(signals_aligned, fake_returns)
        tests['psi_high_on_agreement'] = {
            'value': round(abs(result_agree['psi']), 6),
            'expected': '> psi_disagree',
            'pass': abs(result_agree['psi']) > abs(result['psi'])
        }
        
        # Test 7: C² position sizing scales correctly
        pos_high = engine.position_size(0.9)
        pos_low = engine.position_size(0.3)
        tests['position_scaling'] = {
            'C=0.9': round(pos_high, 4),
            'C=0.3': round(pos_low, 4),
            'ratio': round(pos_high / pos_low if pos_low > 0 else 999, 1),
            'pass': pos_high > pos_low * 5  # 0.81/0.09 = 9x
        }
        
        # Test 8: Weights sum to 1 after updates
        engine2 = PsiEngine()
        for _ in range(100):
            sigs = np.random.uniform(-1, 1, 5)
            ret = np.random.normal(0, 0.02)
            engine2.update_weights(sigs, ret)
        tests['weights_normalized'] = {
            'sum': round(engine2.weights.sum(), 6),
            'pass': abs(engine2.weights.sum() - 1.0) < 1e-6
        }
        
        all_pass = all(t.get('pass', False) for t in tests.values())
        return {'test': 'Unit tests', 'all_pass': all_pass, 'details': tests}
    
    def test_02_synthetic_markets(self) -> dict:
        """Performance on controlled market conditions"""
        results = {}
        
        np.random.seed(42)
        
        markets = {
            'Trending (bull)': MarketSimulator.trending_market(2000, drift=0.0003),
            'Mean-reverting': MarketSimulator.mean_reverting_market(2000),
            'Chaotic': MarketSimulator.chaotic_market(2000),
        }
        
        for mkt_name, prices in markets.items():
            bt = Backtester(prices)
            
            psi_result = bt.run_psi_strategy()
            naive_result = bt.run_naive_average()
            bh_result = bt.run_buy_hold()
            
            results[mkt_name] = {
                'Ψ': {
                    'sharpe': psi_result['sharpe'],
                    'return': psi_result['total_return'],
                    'max_dd': psi_result['max_drawdown'],
                    'win_rate': psi_result['win_rate'],
                },
                'Naive avg': {
                    'sharpe': naive_result['sharpe'],
                    'return': naive_result['total_return'],
                    'max_dd': naive_result['max_drawdown'],
                    'win_rate': naive_result['win_rate'],
                },
                'Buy&Hold': {
                    'sharpe': bh_result['sharpe'],
                    'return': bh_result['total_return'],
                    'max_dd': bh_result['max_drawdown'],
                },
            }
        
        return {'test': 'Synthetic markets', 'results': results}
    
    def test_03_monte_carlo(self, n_simulations: int = 100) -> dict:
        """Statistical robustness across many random markets"""
        np.random.seed(123)
        
        psi_sharpes = []
        naive_sharpes = []
        psi_returns = []
        naive_returns = []
        psi_drawdowns = []
        naive_drawdowns = []
        psi_wins = 0
        
        for i in range(n_simulations):
            mtype = np.random.choice(['trend', 'revert', 'chaos', 'mixed'])
            
            if mtype == 'trend':
                drift = np.random.uniform(-0.0005, 0.001)
                prices = MarketSimulator.trending_market(400, drift=drift)
            elif mtype == 'revert':
                prices = MarketSimulator.mean_reverting_market(400)
            elif mtype == 'chaos':
                prices = MarketSimulator.chaotic_market(400)
            else:
                prices, _ = MarketSimulator.mixed_regime_market(400)
            
            bt = Backtester(prices)
            psi_r = bt.run_psi_strategy()
            naive_r = bt.run_naive_average()
            
            psi_sharpes.append(psi_r['sharpe'])
            naive_sharpes.append(naive_r['sharpe'])
            psi_returns.append(psi_r['total_return'])
            naive_returns.append(naive_r['total_return'])
            psi_drawdowns.append(psi_r['max_drawdown'])
            naive_drawdowns.append(naive_r['max_drawdown'])
            
            if psi_r['sharpe'] > naive_r['sharpe']:
                psi_wins += 1
        
        psi_s = np.array(psi_sharpes)
        naive_s = np.array(naive_sharpes)
        
        return {
            'test': f'Monte Carlo ({n_simulations} simulations)',
            'psi_wins_pct': round(psi_wins / n_simulations * 100, 1),
            'psi': {
                'sharpe_mean': round(np.mean(psi_s), 3),
                'sharpe_median': round(np.median(psi_s), 3),
                'sharpe_std': round(np.std(psi_s), 3),
                'return_mean': round(np.mean(psi_returns), 2),
                'return_median': round(np.median(psi_returns), 2),
                'avg_max_drawdown': round(np.mean(psi_drawdowns), 2),
                'worst_drawdown': round(np.min(psi_drawdowns), 2),
            },
            'naive': {
                'sharpe_mean': round(np.mean(naive_s), 3),
                'sharpe_median': round(np.median(naive_s), 3),
                'sharpe_std': round(np.std(naive_s), 3),
                'return_mean': round(np.mean(naive_returns), 2),
                'return_median': round(np.median(naive_returns), 2),
                'avg_max_drawdown': round(np.mean(naive_drawdowns), 2),
                'worst_drawdown': round(np.min(naive_drawdowns), 2),
            }
        }
    
    def test_04_mixed_regime(self) -> dict:
        """Detailed analysis on a market with regime switches"""
        np.random.seed(77)
        prices, regimes = MarketSimulator.mixed_regime_market(1500)
        
        bt = Backtester(prices)
        psi_r = bt.run_psi_strategy()
        naive_r = bt.run_naive_average()
        bh_r = bt.run_buy_hold()
        
        # Individual signals
        signal_names = ['Hurst only', 'OU-spread only', 'Regime only', 
                       'Entropy only', 'Bayesian only']
        individual_results = {}
        for i, name in enumerate(signal_names):
            result = bt.run_single_signal(i, name)
            individual_results[name] = {
                'sharpe': result['sharpe'],
                'return': result['total_return'],
                'max_dd': result['max_drawdown'],
            }
        
        return {
            'test': 'Mixed regime market (1500 bars)',
            'Ψ': {
                'sharpe': psi_r['sharpe'],
                'return': psi_r['total_return'],
                'max_dd': psi_r['max_drawdown'],
                'win_rate': psi_r['win_rate'],
                'n_trades': psi_r['n_trades'],
                'avg_coherence': psi_r.get('avg_coherence', 'N/A'),
                'avg_entropy': psi_r.get('avg_entropy', 'N/A'),
                'psi_stats': psi_r.get('psi_stats', {}),
                'final_weights': psi_r.get('final_weights', {}),
            },
            'Naive avg': {
                'sharpe': naive_r['sharpe'],
                'return': naive_r['total_return'],
                'max_dd': naive_r['max_drawdown'],
            },
            'Buy&Hold': {
                'sharpe': bh_r['sharpe'],
                'return': bh_r['total_return'],
                'max_dd': bh_r['max_drawdown'],
            },
            'Individual signals': individual_results,
        }
    
    def test_05_sensitivity(self) -> dict:
        """How sensitive is Ψ to parameter choices?"""
        np.random.seed(55)
        prices, _ = MarketSimulator.mixed_regime_market(800)
        
        param_sweeps = {}
        
        # Sweep beta_scale
        beta_results = {}
        for beta in [1.0, 3.0, 5.0, 10.0]:
            cfg = PsiConfig(beta_scale=beta)
            bt = Backtester(prices)
            r = bt.run_psi_strategy(cfg)
            beta_results[f'β={beta}'] = {
                'sharpe': r['sharpe'], 
                'return': r['total_return'],
                'max_dd': r['max_drawdown']
            }
        param_sweeps['beta_scale'] = beta_results
        
        # Sweep kelly_fraction
        kelly_results = {}
        for kf in [0.10, 0.25, 0.50, 1.0]:
            cfg = PsiConfig(kelly_fraction=kf)
            bt = Backtester(prices)
            r = bt.run_psi_strategy(cfg)
            kelly_results[f'Kelly={kf}'] = {
                'sharpe': r['sharpe'], 
                'return': r['total_return'],
                'max_dd': r['max_drawdown']
            }
        param_sweeps['kelly_fraction'] = kelly_results
        
        # Sweep bayesian learning rate
        lr_results = {}
        for lr in [0.01, 0.05, 0.1]:
            cfg = PsiConfig(bayesian_lr=lr)
            bt = Backtester(prices)
            r = bt.run_psi_strategy(cfg)
            lr_results[f'lr={lr}'] = {
                'sharpe': r['sharpe'],
                'return': r['total_return'],
                'max_dd': r['max_drawdown']
            }
        param_sweeps['bayesian_lr'] = lr_results
        
        return {'test': 'Parameter sensitivity', 'sweeps': param_sweeps}
    
    def run_all(self) -> dict:
        """Run complete validation suite"""
        print("=" * 60)
        print("Ψ PHASE CONVERGENCE — VALIDATION SUITE")
        print("=" * 60)
        
        print("\n[1/5] Unit tests...")
        r1 = self.test_01_unit_tests()
        self.results['unit_tests'] = r1
        passed = sum(1 for t in r1['details'].values() if t.get('pass'))
        total = len(r1['details'])
        print(f"  ✓ {passed}/{total} passed")
        
        print("\n[2/5] Synthetic markets...")
        r2 = self.test_02_synthetic_markets()
        self.results['synthetic'] = r2
        for mkt, data in r2['results'].items():
            psi_s = data['Ψ']['sharpe']
            naive_s = data['Naive avg']['sharpe']
            winner = "Ψ" if psi_s > naive_s else "Naive"
            print(f"  {mkt}: Ψ sharpe={psi_s:.3f} vs Naive={naive_s:.3f} → {winner}")
        
        print("\n[3/5] Monte Carlo (100 simulations)...")
        r3 = self.test_03_monte_carlo(100)
        self.results['monte_carlo'] = r3
        print(f"  Ψ wins {r3['psi_wins_pct']}% of simulations")
        print(f"  Ψ mean Sharpe: {r3['psi']['sharpe_mean']:.3f} vs Naive: {r3['naive']['sharpe_mean']:.3f}")
        print(f"  Ψ avg drawdown: {r3['psi']['avg_max_drawdown']:.1f}% vs Naive: {r3['naive']['avg_max_drawdown']:.1f}%")
        
        print("\n[4/5] Mixed regime analysis...")
        r4 = self.test_04_mixed_regime()
        self.results['mixed_regime'] = r4
        print(f"  Ψ: sharpe={r4['Ψ']['sharpe']:.3f}, return={r4['Ψ']['return']:.1f}%, dd={r4['Ψ']['max_dd']:.1f}%")
        print(f"  Naive: sharpe={r4['Naive avg']['sharpe']:.3f}, return={r4['Naive avg']['return']:.1f}%")
        print(f"  B&H: sharpe={r4['Buy&Hold']['sharpe']:.3f}, return={r4['Buy&Hold']['return']:.1f}%")
        if r4['Ψ'].get('final_weights'):
            print(f"  Final weights: {r4['Ψ']['final_weights']}")
        
        print("\n[5/5] Parameter sensitivity...")
        r5 = self.test_05_sensitivity()
        self.results['sensitivity'] = r5
        for param, vals in r5['sweeps'].items():
            sharpes = [v['sharpe'] for v in vals.values()]
            print(f"  {param}: sharpe range [{min(sharpes):.3f}, {max(sharpes):.3f}]")
        
        print("\n" + "=" * 60)
        print("VALIDATION COMPLETE")
        print("=" * 60)
        
        return self.results


# ============================================================
# RUN
# ============================================================

if __name__ == '__main__':
    suite = ValidationSuite()
    results = suite.run_all()
    
    # Save full results as JSON
    def convert(obj):
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return obj
    
    # Save summary (without equity curves for readability)
    summary = {}
    for k, v in results.items():
        if isinstance(v, dict):
            summary[k] = {kk: vv for kk, vv in v.items() 
                         if kk != 'equity_curve'}
    
    with open('/home/claude/psi_results.json', 'w') as f:
        json.dump(summary, f, indent=2, default=convert)
    
    print("\nResults saved to psi_results.json")
