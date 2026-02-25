# ADR-006: Baseline Freeze Mechanism
**Date:** 2026-02-20 | **Status:** Active

## Context (Why)
With three systems mutating parameters (Evolution, AI Brain, Calibration), it was impossible to measure clean trading performance. Any performance change could be attributed to market conditions OR parameter mutations — no way to isolate.

## Decision (What)
`baseline.py` freeze/unfreeze mechanism:
- `freeze`: Set `[baseline] frozen=true` in toml, take snapshot of current state
- While frozen: AI Brain + Evolution exit early, calibration keeps running (read-only), trading continues normally
- `unfreeze`: Take end snapshot, compare baseline vs post-baseline window

## Consequences (How)
- Snapshots stored in `baselines/{id}/` (gitignored)
- Isolates mutation impact from market conditions
- Manual trigger only (not automated)
- Recommended: 48h freeze periods for statistically meaningful comparison
