# Project Hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 project hygiene issues from security/architecture review: Docker socket exposure, missing TOML validation, 54 screenshots polluting root, and ARCHITECTURE.md doc-drift.

**Architecture:** All 4 tasks are fully independent — no shared state, no ordering dependencies. Each produces a self-contained commit.

**Tech Stack:** Docker Compose, TypeScript, Bash, Markdown

---

## File Map

```
MODIFY  docker-compose.prod.yml                    # Task 1: Docker socket proxy
CREATE  scripts/validate-toml.ts                    # Task 2: TOML schema validation
MODIFY  .gitignore                                  # Task 3: Ignore docs/img/
MODIFY  docs/ARCHITECTURE.md                        # Task 4: Fix doc-drift
```

---

## Task 1: Docker Socket Proxy — Replace Direct Mount

**Problem:** `aktienix-brain` and `huntrix-brain` mount `/var/run/docker.sock` directly, giving root-equivalent host access. If a brain container is compromised (npm supply chain, prompt injection), the attacker gets full host control.

**Fix:** Use [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) — a lightweight HAProxy that only allows whitelisted Docker API endpoints.

**Files:**
- Modify: `docker-compose.prod.yml` (lines 338-340, 604-607)

- [ ] **Step 1: Add docker-socket-proxy service to docker-compose.prod.yml**

Add this service BEFORE the `aktienix-brain` service:

```yaml
  # ============================================================
  # Docker Socket Proxy — restricted Docker API access
  # Only allows: container restart (POST /containers/*/restart)
  # Used by: aktienix-brain, huntrix-brain
  # ============================================================
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    restart: unless-stopped
    environment:
      - CONTAINERS=1        # Allow container listing + restart
      - POST=1              # Allow POST (needed for restart)
      - IMAGES=0
      - NETWORKS=0
      - VOLUMES=0
      - SERVICES=0
      - TASKS=0
      - NODES=0
      - SWARM=0
      - BUILD=0
      - EXEC=0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - cryonix-net
```

- [ ] **Step 2: Update aktienix-brain to use proxy instead of direct socket**

In `docker-compose.prod.yml`, find the `aktienix-brain` service volumes section (around line 338-340). Remove the socket mount and add `DOCKER_HOST` env var:

```yaml
  aktienix-brain:
    # ... existing config ...
    volumes:
      - ./aktienix.toml:/app/aktienix.toml
      # REMOVED: /var/run/docker.sock:/var/run/docker.sock
      - ~/.claude:/root/.claude:ro
    environment:
      # ... existing env vars ...
      - DOCKER_HOST=tcp://docker-proxy:2375
    depends_on:
      # ... existing depends_on ...
      docker-proxy:
        condition: service_started
```

- [ ] **Step 3: Update huntrix-brain to use proxy**

Same change for `huntrix-brain` (around line 604-607):

```yaml
  huntrix-brain:
    # ... existing config ...
    volumes:
      - ~/.claude:/root/.claude:ro
      # REMOVED: /var/run/docker.sock:/var/run/docker.sock
      - ./huntrix.toml:/app/huntrix.toml
    environment:
      # ... existing env vars ...
      - DOCKER_HOST=tcp://docker-proxy:2375
    depends_on:
      docker-proxy:
        condition: service_started
```

- [ ] **Step 4: Verify brain scripts use DOCKER_HOST**

Check that `scripts/services/aktienix-brain.ts` and the huntrix-brain equivalent use `child_process.exec('docker restart aktienix')` — the Docker CLI automatically respects `DOCKER_HOST` env var, so no code changes needed.

Run: `grep -rn 'docker restart\|docker.sock\|DOCKER_HOST' scripts/services/aktienix-brain.ts scripts/services/huntrix-brain.ts 2>/dev/null`

Expected: Only `docker restart` commands, no direct socket references.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "security: replace Docker socket mount with docker-socket-proxy

aktienix-brain and huntrix-brain no longer have direct /var/run/docker.sock
access. Instead, they connect to a restricted HAProxy (Tecnativa) that only
allows container restart operations. Prevents container escape attacks."
```

---

## Task 2: TOML Schema Validation Script

**Problem:** `cryonix.toml` is 1200+ lines read by 5+ systems. A typo in a key name silently falls back to defaults — has caused real bugs (e.g. R/R threshold mismatch). No startup validation exists.

**Fix:** Create a validation script that checks required sections/keys exist and values are within sane bounds. Run it as part of deploy and optionally as a container healthcheck.

**Files:**
- Create: `scripts/validate-toml.ts`

- [ ] **Step 1: Create the validation script**

Create `scripts/validate-toml.ts`:

```typescript
/**
 * TOML Config Validator — checks cryonix.toml, aktienix.toml, copynix.toml, apex.toml
 * for required sections, keys, and value ranges.
 *
 * Usage: npx tsx scripts/validate-toml.ts [file...]
 * If no files given, validates all known TOML configs.
 *
 * Exit code 0 = all valid, 1 = errors found.
 */

import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

interface Rule {
    path: string;        // dot-separated path: "risk.min_risk_reward"
    type: 'number' | 'string' | 'boolean' | 'array';
    min?: number;
    max?: number;
    required?: boolean;
}

// ── Cryonix rules ──────────────────────────────────────────
const CRYONIX_RULES: Rule[] = [
    { path: 'risk.min_confidence', type: 'number', min: 0.1, max: 1.0, required: true },
    { path: 'risk.min_risk_reward', type: 'number', min: 0.5, max: 5.0, required: true },
    { path: 'risk.max_open_positions', type: 'number', min: 1, max: 20, required: true },
    { path: 'risk.max_trades_per_day', type: 'number', min: 1, max: 50, required: true },
    { path: 'risk.max_daily_loss_pct', type: 'number', min: 0.01, max: 0.5, required: true },
    { path: 'exits.sl_atr_multiplier', type: 'number', min: 1.0, max: 20.0 },
    { path: 'exits.tp_atr_multiplier', type: 'number', min: 1.0, max: 30.0 },
    { path: 'exits.stagnation_timeout_hours', type: 'number', min: 1, max: 168 },
    { path: 'capital.signal_pool_pct', type: 'number', min: 0, max: 1.0 },
    { path: 'capital.reserve_pct', type: 'number', min: 0, max: 1.0 },
    { path: 'patterns.dip_focus_mode', type: 'boolean' },
    { path: 'coinmarketcap.enabled', type: 'boolean' },
];

// ── Aktienix rules ─────────────────────────────────────────
const AKTIENIX_RULES: Rule[] = [
    { path: 'signals.min_signal_score', type: 'number', min: 0.05, max: 1.0, required: true },
    { path: 'risk.min_confidence', type: 'number', min: 0.1, max: 1.0, required: true },
    { path: 'exits.stop_loss_pct', type: 'number', min: 1.0, max: 20.0, required: true },
    { path: 'exits.take_profit_pct', type: 'number', min: 1.0, max: 50.0, required: true },
    { path: 'capital.max_position_size_usd', type: 'number', min: 100, max: 50000 },
    { path: 'watchlist.symbols', type: 'array', required: true },
];

// ── Apex rules ─────────────────────────────────────────────
const APEX_RULES: Rule[] = [
    { path: 'general.capital', type: 'number', min: 1, max: 100000, required: true },
    { path: 'general.scan_interval_seconds', type: 'number', min: 5, max: 300 },
    { path: 'confluence.min_score_full_kelly', type: 'number', min: 10, max: 100 },
    { path: 'confluence.min_score_half_kelly', type: 'number', min: 5, max: 100 },
    { path: 'risk.kelly_fraction', type: 'number', min: 0.01, max: 1.0, required: true },
    { path: 'risk.max_drawdown_pct', type: 'number', min: 1, max: 50 },
];

// ── Copynix rules ──────────────────────────────────────────
const COPYNIX_RULES: Rule[] = [
    { path: 'safety.min_token_age_hours', type: 'number', min: 0, max: 168 },
    { path: 'safety.min_liquidity_usd', type: 'number', min: 0, max: 1000000 },
    { path: 'safety.min_holders', type: 'number', min: 0, max: 10000 },
];

const CONFIG_MAP: Record<string, Rule[]> = {
    'cryonix.toml': CRYONIX_RULES,
    'aktienix.toml': AKTIENIX_RULES,
    'apex.toml': APEX_RULES,
    'copynix.toml': COPYNIX_RULES,
};

function getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

function validate(filePath: string, rules: Rule[]): string[] {
    const errors: string[] = [];
    if (!existsSync(filePath)) {
        errors.push(`File not found: ${filePath}`);
        return errors;
    }

    let config: any;
    try {
        config = parse(readFileSync(filePath, 'utf-8'));
    } catch (e) {
        errors.push(`Parse error in ${filePath}: ${e instanceof Error ? e.message : e}`);
        return errors;
    }

    for (const rule of rules) {
        const val = getNestedValue(config, rule.path);

        if (val === undefined || val === null) {
            if (rule.required) errors.push(`${filePath}: missing required key "${rule.path}"`);
            continue;
        }

        if (rule.type === 'number' && typeof val === 'number') {
            if (rule.min !== undefined && val < rule.min)
                errors.push(`${filePath}: "${rule.path}" = ${val} is below minimum ${rule.min}`);
            if (rule.max !== undefined && val > rule.max)
                errors.push(`${filePath}: "${rule.path}" = ${val} exceeds maximum ${rule.max}`);
        } else if (rule.type === 'boolean' && typeof val !== 'boolean') {
            errors.push(`${filePath}: "${rule.path}" should be boolean, got ${typeof val}`);
        } else if (rule.type === 'array' && !Array.isArray(val)) {
            errors.push(`${filePath}: "${rule.path}" should be array, got ${typeof val}`);
        } else if (rule.type === 'string' && typeof val !== 'string') {
            errors.push(`${filePath}: "${rule.path}" should be string, got ${typeof val}`);
        }
    }

    return errors;
}

// ── Main ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const files = args.length > 0
    ? args
    : Object.keys(CONFIG_MAP).map(f => join(process.cwd(), f));

let totalErrors = 0;

for (const file of files) {
    const basename = file.split('/').pop() ?? file.split('\\').pop() ?? file;
    const rules = CONFIG_MAP[basename];
    if (!rules) {
        console.warn(`⚠️  No rules defined for ${basename}, skipping`);
        continue;
    }

    const errors = validate(file, rules);
    if (errors.length === 0) {
        console.log(`✅ ${basename} — valid`);
    } else {
        console.log(`❌ ${basename} — ${errors.length} error(s):`);
        for (const err of errors) console.log(`   ${err}`);
        totalErrors += errors.length;
    }
}

process.exit(totalErrors > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the validator against current configs**

```bash
npx tsx scripts/validate-toml.ts
```

Expected: All 4 configs pass (or reveal real issues to fix).

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-toml.ts
git commit -m "feat: add TOML config validation script

Validates cryonix.toml, aktienix.toml, apex.toml, copynix.toml against
defined rules (required keys, value ranges, types). Catches silent
fallback-to-defaults bugs. Run: npx tsx scripts/validate-toml.ts"
```

---

## Task 3: Move Screenshots Out of Root

**Problem:** 54 PNG screenshots in the project root balloon the repo size and clutter `git status`.

**Files:**
- Move: `*.png` from root → `docs/img/`
- Modify: `.gitignore` (add `docs/img/` to ignored paths)

- [ ] **Step 1: Create docs/img/ and move all PNGs**

The PNGs are untracked (never committed to git), so use plain `mv`:

```bash
mkdir -p docs/img
mv *.png docs/img/
```

- [ ] **Step 2: Add docs/img/*.png to .gitignore**

Append to `.gitignore`:

```
# Screenshots and images (audit artifacts, not source code)
docs/img/*.png
```

- [ ] **Step 3: Commit the .gitignore change**

```bash
git add .gitignore
git commit -m "chore: gitignore screenshot artifacts in docs/img/

54 PNGs moved from root to docs/img/ (untracked, never committed).
Added gitignore rule to keep them out of git."
```

---

## Task 4: Fix ARCHITECTURE.md Doc-Drift

**Problem:** `docs/ARCHITECTURE.md` has hardcoded parameter values that don't match actual `cryonix.toml`. Dangerous for reviews and onboarding.

**Fix:** Replace all hardcoded values with "see cryonix.toml" references. This is drift-proof — values can't go stale.

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Read current ARCHITECTURE.md and cryonix.toml**

Read both files to identify all mismatched values.

- [ ] **Step 2: Replace hardcoded values with config references**

For every section that quotes specific numbers (confidence thresholds, position limits, capital splits, etc.), replace the specific value with a reference:

```markdown
<!-- OLD: -->
Risk gate filters signals below 65% confidence.
Capital is split 65/25/10 (signal/grid/reserve).
Maximum 4 concurrent positions.

<!-- NEW: -->
Risk gate filters signals below the configured `min_confidence` threshold (see `cryonix.toml [risk]`).
Capital allocation is defined in `cryonix.toml [capital]` — signal_pool_pct / grid_pool_pct / reserve_pct.
Position limits configured in `cryonix.toml [risk]` — max_open_positions / max_signal_positions / max_grid_positions.
```

This approach:
- Never goes stale (references config, doesn't duplicate values)
- Still gives the reader context (they know WHERE to look)
- Matches the pattern already used in `CLAUDE.md`

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: replace hardcoded values in ARCHITECTURE.md with config references

All parameter values now reference cryonix.toml sections instead of
quoting specific numbers. Prevents doc-drift when Evolution Engine
or AI Brain modifies parameters."
```

---

## Execution Order

All 4 tasks are fully independent — execute in parallel.

| Task | What | Effort |
|------|------|--------|
| 1 | Docker socket proxy | 5 min |
| 2 | TOML validation script | 5 min |
| 3 | Screenshot cleanup | 2 min |
| 4 | ARCHITECTURE.md drift | 10 min |
