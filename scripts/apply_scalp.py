#!/usr/bin/env python3
"""Apply scalp mode changes to route.ts and config.ts"""

import re
import sys

def patch_config_ts():
    """Add SCALP_POOL_PCT and MAX_SCALP_POSITIONS to loadConfig()"""
    path = "apps/web/src/lib/config.ts"
    with open(path, "r") as f:
        content = f.read()

    # Add SCALP_POOL_PCT and MAX_SCALP_POSITIONS to RiskConfig and loadConfig
    if "SCALP_POOL_PCT" in content:
        print("[config.ts] Already has SCALP_POOL_PCT, skipping")
        return

    # Add to loadConfig return
    content = content.replace(
        "GRID_POOL_PCT: toml.capital.grid_pool_pct,\n    RESERVE_PCT: toml.capital.reserve_pct,",
        "GRID_POOL_PCT: toml.capital.grid_pool_pct,\n    RESERVE_PCT: toml.capital.reserve_pct,\n    SCALP_POOL_PCT: toml.capital.scalp_pool_pct ?? 0,",
    )
    content = content.replace(
        "MAX_GRID_POSITIONS: toml.limits.max_grid_positions,",
        "MAX_GRID_POSITIONS: toml.limits.max_grid_positions,\n    MAX_SCALP_POSITIONS: toml.limits.max_scalp_positions ?? 2,",
    )

    with open(path, "w") as f:
        f.write(content)
    print("[config.ts] Added SCALP_POOL_PCT and MAX_SCALP_POSITIONS")


def patch_route_ts():
    """Add scalp mode to route.ts"""
    path = "apps/web/src/app/api/auto-trade/route.ts"
    with open(path, "r") as f:
        content = f.read()

    if "isScalpPosition" in content:
        print("[route.ts] Already has isScalpPosition, skipping")
        return

    # ── 1. Add isScalpPosition to OpenPosition interface ──
    content = content.replace(
        "isGridPosition?: boolean; // Track whether position came from grid strategy",
        "isGridPosition?: boolean; // Track whether position came from grid strategy\n  isScalpPosition?: boolean; // Track whether position is a scalp trade",
    )
    print("[route.ts] 1/7 Added isScalpPosition to OpenPosition")

    # ── 2. Add scalpBudget/scalpUsed/scalpRemaining to CapitalBudget ──
    content = content.replace(
        "gridBudget: number;        // Max $ for grid trades",
        "gridBudget: number;        // Max $ for grid trades\n  scalpBudget: number;       // Max $ for scalp trades",
    )
    content = content.replace(
        "gridUsed: number;          // Currently allocated to grid positions",
        "gridUsed: number;          // Currently allocated to grid positions\n  scalpUsed: number;         // Currently allocated to scalp positions",
    )
    content = content.replace(
        "gridRemaining: number;",
        "gridRemaining: number;\n  scalpRemaining: number;",
    )
    print("[route.ts] 2/7 Added scalp fields to CapitalBudget")

    # ── 3. Compute scalpBudget in getCapitalBudget() ──
    content = content.replace(
        "let reservePct = CONFIG.RESERVE_PCT;",
        "let reservePct = CONFIG.RESERVE_PCT;\n  let scalpPct = CONFIG.SCALP_POOL_PCT ?? 0;",
    )
    content = content.replace(
        "const gridBudget = capital * gridPct;\n  const reserve = capital * reservePct;",
        "const gridBudget = capital * gridPct;\n  const scalpBudget = capital * scalpPct;\n  const reserve = capital * reservePct;",
    )

    # Add scalpUsed calculation after gridUsed
    content = content.replace(
        """let signalUsed = 0;
  let gridUsed = 0;
  for (const pos of positions) {
    const posValue = pos.entryPrice * pos.quantity;
    if (pos.isGridPosition || pos.pattern === 'GRID_BUY') {
      gridUsed += posValue;
    } else {
      signalUsed += posValue;
    }
  }""",
        """let signalUsed = 0;
  let gridUsed = 0;
  let scalpUsed = 0;
  for (const pos of positions) {
    const posValue = pos.entryPrice * pos.quantity;
    if (pos.isGridPosition || pos.pattern === 'GRID_BUY') {
      gridUsed += posValue;
    } else if (pos.isScalpPosition) {
      scalpUsed += posValue;
    } else {
      signalUsed += posValue;
    }
  }""",
    )

    # Add scalp fields to return object
    content = content.replace(
        """signalRemaining: Math.max(0, signalBudget - signalUsed),
    gridRemaining: Math.max(0, gridBudget - gridUsed),
    regime,
  };""",
        """signalRemaining: Math.max(0, signalBudget - signalUsed),
    gridRemaining: Math.max(0, gridBudget - gridUsed),
    scalpBudget,
    scalpUsed,
    scalpRemaining: Math.max(0, scalpBudget - scalpUsed),
    regime,
  };""",
    )
    print("[route.ts] 3/7 Added scalp budget computation")

    # ── 4. Add scalp exit logic in monitorPositions ──
    # We need to use scalp-specific TP/SL/trailing for scalp positions
    # Find the trailing activation section and add scalp handling
    old_trailing = """if (profitPct >= (TOML?.exits.trailing_activation_pct ?? 1.5)) {
          const newTrailingStop = currentPrice * (1 - CONFIG.TRAILING_STOP_PCT / 100);"""
    new_trailing = """const trailingActivation = pos.isScalpPosition
            ? (TOML?.scalp?.trailing_activation_pct ?? 0.8)
            : (TOML?.exits.trailing_activation_pct ?? 1.5);
          const trailingPct = pos.isScalpPosition
            ? (TOML?.scalp?.trailing_pct ?? 0.5)
            : CONFIG.TRAILING_STOP_PCT;
          if (profitPct >= trailingActivation) {
          const newTrailingStop = currentPrice * (1 - trailingPct / 100);"""
    content = content.replace(old_trailing, new_trailing)

    # Add scalp stagnation timeout (minutes instead of hours)
    old_stagnation = """const stagnationTimeout = TOML?.exits?.stagnation_timeout_hours ?? 8;
        const stagnationMinPnl = TOML?.exits?.stagnation_min_pnl_pct ?? 1.0;
        if (ageHours > stagnationTimeout && Math.abs(pnlPct) < stagnationMinPnl) {"""
    new_stagnation = """const stagnationTimeout = pos.isScalpPosition
          ? (TOML?.scalp?.max_hold_minutes ?? 45) / 60  // scalp: minutes → hours
          : (TOML?.exits?.stagnation_timeout_hours ?? 8);
        const stagnationMinPnl = pos.isScalpPosition ? 0.3 : (TOML?.exits?.stagnation_min_pnl_pct ?? 1.0);
        if (ageHours > stagnationTimeout && Math.abs(pnlPct) < stagnationMinPnl) {"""
    content = content.replace(old_stagnation, new_stagnation)
    print("[route.ts] 4/7 Added scalp-specific exit params")

    # ── 5. Add scalp checks to passesRiskChecks ──
    old_risk_signal = """  } else {
    // Signal strategy checks
    const signalPositions = openPositions.filter(p => !p.isGridPosition && p.pattern !== 'GRID_BUY');
    if (signalPositions.length >= CONFIG.MAX_SIGNAL_POSITIONS) {
      return { pass: false, reason: `Max signal positions (${CONFIG.MAX_SIGNAL_POSITIONS})` };
    }
    if (budget.signalRemaining < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Signal budget exhausted ($${budget.signalRemaining.toFixed(2)} remaining of $${budget.signalBudget.toFixed(2)})` };
    }
  }"""
    new_risk_signal = """  } else if (isScalp) {
    // Scalp strategy checks
    const scalpPositions = openPositions.filter(p => p.isScalpPosition);
    if (scalpPositions.length >= (CONFIG.MAX_SCALP_POSITIONS ?? 2)) {
      return { pass: false, reason: `Max scalp positions (${CONFIG.MAX_SCALP_POSITIONS ?? 2})` };
    }
    if (budget.scalpRemaining < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Scalp budget exhausted ($${budget.scalpRemaining.toFixed(2)} remaining of $${budget.scalpBudget.toFixed(2)})` };
    }
  } else {
    // Signal strategy checks
    const signalPositions = openPositions.filter(p => !p.isGridPosition && p.pattern !== 'GRID_BUY' && !p.isScalpPosition);
    if (signalPositions.length >= CONFIG.MAX_SIGNAL_POSITIONS) {
      return { pass: false, reason: `Max signal positions (${CONFIG.MAX_SIGNAL_POSITIONS})` };
    }
    if (budget.signalRemaining < CONFIG.MIN_ORDER_VALUE) {
      return { pass: false, reason: `Signal budget exhausted ($${budget.signalRemaining.toFixed(2)} remaining of $${budget.signalBudget.toFixed(2)})` };
    }
  }"""
    content = content.replace(old_risk_signal, new_risk_signal)

    # Need to add isScalp detection before the isGrid check
    old_isgrid = "  const isGrid = signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy;"
    # Find this in passesRiskChecks context (there may be more than one)
    # The one in passesRiskChecks is after "Capital allocator: enforce per-strategy budgets"
    old_allocator = """// Capital allocator: enforce per-strategy budgets
  const isGrid = signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy;"""
    new_allocator = """// Capital allocator: enforce per-strategy budgets
  const isGrid = signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy;
  const isScalp = !isGrid && isScalpEligible(signal);"""
    content = content.replace(old_allocator, new_allocator)
    print("[route.ts] 5/7 Added scalp risk checks")

    # ── 6. Add scalp budget to calculatePositionSize ──
    old_sizing = "const availableBudget = isGrid ? budget.gridRemaining : budget.signalRemaining;"
    new_sizing = """const isScalp = !isGrid && isScalpEligible(signal);
  const availableBudget = isGrid ? budget.gridRemaining : isScalp ? budget.scalpRemaining : budget.signalRemaining;"""
    content = content.replace(old_sizing, new_sizing)
    print("[route.ts] 6/7 Added scalp budget to position sizing")

    # ── 7. Add isScalpEligible() helper + scalp TP/SL overrides on entry ──
    # Add the helper function right after the OpenPosition interface closing brace
    scalp_helper = """

// ============================================================================
// SCALP MODE — Detect scalp-eligible signals and set tight exit params
// ============================================================================
function isScalpEligible(signal: Signal): boolean {
  if (!TOML?.scalp?.enabled) return false;
  if ((signal as any).is_scalp) return true; // Explicitly tagged by signal hunter
  const scalpPatterns = TOML.scalp.scalp_patterns ?? ['VOLUME_SPIKE_UP', 'MACD_BULLISH_CROSS', 'EMA_CROSS_UP', 'MOMENTUM_GAINER'];
  const hasScalpPattern = signal.patterns?.some(p => scalpPatterns.includes(p));
  const hasVolume = (signal.indicators?.volume_ratio ?? 0) >= (TOML.scalp.min_volume_ratio ?? 1.5);
  const hasConfidence = signal.confidence >= (TOML.scalp.min_confidence ?? 0.70);
  return !!(hasScalpPattern && hasVolume && hasConfidence);
}

function getScalpExits(entryPrice: number): { stopLoss: number; takeProfit: number; trailingStop: number } {
  const slPct = TOML?.scalp?.sl_pct ?? 0.8;
  const tpPct = TOML?.scalp?.tp_pct ?? 1.5;
  return {
    stopLoss: entryPrice * (1 - slPct / 100),
    takeProfit: entryPrice * (1 + tpPct / 100),
    trailingStop: entryPrice * (1 - slPct / 100), // Start at SL, tightens when activated
  };
}
"""
    # Insert after the OpenPosition interface block
    content = content.replace(
        "// ============================================================================\n// POSITION MONITORING",
        scalp_helper + "// ============================================================================\n// POSITION MONITORING",
    )
    print("[route.ts] 7/7 Added isScalpEligible() and getScalpExits()")

    # ── 8. Tag scalp positions on entry and override exits ──
    # Find where positions are added with isGridPosition
    # We need to set isScalpPosition and override SL/TP for scalp entries
    # Find addPosition call pattern
    old_addpos = "isGridPosition: signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy,"
    if old_addpos in content:
        new_addpos = """isGridPosition: signal.patterns?.includes('GRID_BUY') || (signal as any).is_grid_buy,
        isScalpPosition: isScalpEligible(signal),"""
        content = content.replace(old_addpos, new_addpos)
        print("[route.ts] 8+ Tagged scalp positions on entry")
    else:
        print("[route.ts] WARNING: Could not find addPosition grid pattern — manual check needed")

    with open(path, "w") as f:
        f.write(content)
    print("[route.ts] All patches applied!")


if __name__ == "__main__":
    patch_config_ts()
    patch_route_ts()
    print("\nDone! Run: pnpm build && pnpm type-check")
