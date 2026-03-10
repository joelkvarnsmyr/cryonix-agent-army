"""Tests for watchlist_agent pure functions."""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import MagicMock, patch
import watchlist_agent as wa


# ── score_candidate ──────────────────────────────────────────────────────────

def test_score_candidate_high_rank_high_volume():
    cmc = {'rank': 10, 'volume_24h': 100_000_000, 'fdv_mc_ratio': 1.5, 'percent_change_7d': 10.0}
    score = wa.score_candidate(cmc, rank_limit=150)
    assert score > 70, f"Expected >70, got {score}"

def test_score_candidate_low_rank_penalized():
    cmc = {'rank': 149, 'volume_24h': 6_000_000, 'fdv_mc_ratio': 3.5, 'percent_change_7d': 0.0}
    score = wa.score_candidate(cmc, rank_limit=150)
    assert score < 30, f"Expected <30, got {score}"

def test_score_candidate_high_fdv_mc_zero_dilution_points():
    cmc = {'rank': 50, 'volume_24h': 20_000_000, 'fdv_mc_ratio': 5.0, 'percent_change_7d': 5.0}
    score_high_fdv = wa.score_candidate(cmc, rank_limit=150)
    cmc2 = {**cmc, 'fdv_mc_ratio': 1.0}
    score_low_fdv = wa.score_candidate(cmc2, rank_limit=150)
    assert score_low_fdv > score_high_fdv


# ── apply_guardrails ─────────────────────────────────────────────────────────

def make_stats(symbol, trades=10, win_rate=0.35, pnl=-3.0, days=20):
    return {
        'symbol': symbol,
        'trades': trades,
        'win_rate': win_rate,
        'total_pnl_usd': pnl,
        'removal_eligible': trades >= 5 and days >= 14,
    }

def test_guardrails_removes_ineligible_removals():
    stats = {'ADA/USDC': make_stats('ADA/USDC', days=5)}
    result = wa.apply_guardrails(
        add=[], remove=['ADA/USDC'],
        current=['BTC/USDC', 'ETH/USDC', 'ADA/USDC'],
        symbol_stats=stats,
        max_changes=5, hard_cap=50, min_symbols=10,
        valid_symbols={'BTC/USDC', 'ETH/USDC', 'ADA/USDC'},
    )
    assert 'ADA/USDC' not in result['remove']
    assert 'ADA/USDC' in result['skipped_removals']

def test_guardrails_respects_max_changes():
    stats = {f'SYM{i}/USDC': make_stats(f'SYM{i}/USDC') for i in range(10)}
    current = [f'SYM{i}/USDC' for i in range(10)]
    valid = set(current) | {'NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC'}
    result = wa.apply_guardrails(
        add=['NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC'],
        remove=['SYM0/USDC', 'SYM1/USDC', 'SYM2/USDC', 'SYM3/USDC'],
        current=current, symbol_stats=stats,
        max_changes=3, hard_cap=50, min_symbols=5,
        valid_symbols=valid,
    )
    assert len(result['add']) + len(result['remove']) <= 3

def test_guardrails_enforces_hard_cap():
    current = [f'SYM{i}/USDC' for i in range(48)]
    stats = {}
    valid = set(current) | {'NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC', 'NEW5/USDC'}
    result = wa.apply_guardrails(
        add=['NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC', 'NEW5/USDC'],
        remove=[], current=current, symbol_stats=stats,
        max_changes=5, hard_cap=50, min_symbols=10,
        valid_symbols=valid,
    )
    assert len(current) + len(result['add']) <= 50

def test_guardrails_rejects_unknown_symbols():
    current = ['BTC/USDC', 'ETH/USDC']
    result = wa.apply_guardrails(
        add=['FAKE/USDC'],
        remove=[], current=current, symbol_stats={},
        max_changes=5, hard_cap=50, min_symbols=1,
        valid_symbols={'BTC/USDC', 'ETH/USDC'},
    )
    assert 'FAKE/USDC' not in result['add']


# ── format_telegram_message ───────────────────────────────────────────────────

def test_format_telegram_applied():
    msg = wa.format_telegram_message(
        status='applied',
        added=['PEPE/USDC'],
        removed=['ADA/USDC'],
        skipped=[],
        symbols_after=['BTC/USDC', 'PEPE/USDC'],
        fear_greed=52,
        regime='trending',
        reasoning='ADA underperformed.',
    )
    assert 'PEPE/USDC' in msg
    assert 'ADA/USDC' in msg

def test_format_telegram_skipped():
    msg = wa.format_telegram_message(
        status='skipped',
        added=[], removed=[], skipped=[],
        symbols_after=[],
        fear_greed=10, regime='bearish', reasoning='',
    )
    assert 'skippad' in msg.lower() or 'skip' in msg.lower()

def test_format_telegram_failed_includes_step_and_error():
    msg = wa.format_telegram_message(
        status='failed',
        added=[], removed=[], skipped=[],
        symbols_after=[],
        fear_greed=50, regime='neutral', reasoning='Connection timeout',
        error_step='Grok-anrop (3 försök)',
    )
    assert 'Grok-anrop' in msg
    assert 'Connection timeout' in msg
    assert 'oförändrad' in msg.lower()

def test_format_telegram_no_changes_includes_next_run():
    msg = wa.format_telegram_message(
        status='no_changes',
        added=[], removed=[], skipped=[],
        symbols_after=['BTC/USDC', 'ETH/USDC'],
        fear_greed=50, regime='neutral', reasoning='',
    )
    assert '3-4 dagar' in msg
    assert '2 symboler' in msg

def test_format_telegram_applied_includes_symbol_stats():
    stats = {'ADA/USDC': make_stats('ADA/USDC', trades=7, win_rate=0.28, pnl=-2.50)}
    msg = wa.format_telegram_message(
        status='applied',
        added=['PEPE/USDC'], removed=['ADA/USDC'], skipped=[],
        symbols_after=['BTC/USDC', 'PEPE/USDC'],
        fear_greed=52, regime='trending', reasoning='ADA weak.',
        symbol_stats=stats,
    )
    assert '-2.50' in msg or '-$2.50' in msg
    assert '28%' in msg or '28.0%' in msg


# ── collect_symbol_stats ─────────────────────────────────────────────────────

def test_collect_symbol_stats_marks_ineligible_new_symbol():
    mock_pg = MagicMock()
    mock_cur = MagicMock()
    mock_pg.cursor.return_value = mock_cur
    mock_cur.description = [('symbol',), ('trades',), ('win_rate',),
                             ('total_pnl_usd',), ('avg_pnl_pct',), ('first_trade_at',)]
    mock_cur.fetchall.return_value = []

    wl_cfg = {
        'min_trades_before_removal': 5,
        'min_days_on_watchlist': 14,
        'candidate_pool_cmc_rank_limit': 150,
        'candidate_min_volume_usd': 5_000_000,
    }
    stats = wa.collect_symbol_stats(mock_pg, ['BTC/USDC', 'ETH/USDC'], wl_cfg)
    assert stats['BTC/USDC']['removal_eligible'] is False
    assert stats['ETH/USDC']['removal_eligible'] is False


# ── discover_candidates ───────────────────────────────────────────────────────

def test_discover_candidates_filters_current_symbols():
    mock_r = MagicMock()
    mock_r.keys.return_value = ['cmc:mcap:BTC', 'cmc:mcap:PEPE']
    mock_r.get.side_effect = lambda key: json.dumps({
        'rank': 1 if 'BTC' in key else 30,
        'volume_24h': 50_000_000,
        'fdv_mc_ratio': 1.0,
        'percent_change_7d': 5.0,
        'market_cap': 1_000_000_000,
    })
    wl_cfg = {
        'candidate_pool_cmc_rank_limit': 150,
        'candidate_min_volume_usd': 5_000_000,
    }
    candidates = wa.discover_candidates(mock_r, ['BTC/USDC'], wl_cfg)
    symbols = [c['symbol'] for c in candidates]
    assert 'BTC/USDC' not in symbols
    assert 'PEPE/USDC' in symbols
