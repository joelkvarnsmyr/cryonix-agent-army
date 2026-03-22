# Solanix + Polynix Config Tuning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two data-validated issues: Solanix over-filtering (0 trades in 14h) and Polynix micro-market bleeding (20% WR, -$34).

**Architecture:** Config-only changes to both agents. No code changes needed.

**Tech Stack:** TOML config files, Docker rebuild.

---

### Task 1: Solanix — Ease confidence threshold

**Evidence:** 167 scans in 14h, only 5 produced a signal. All rejected at confidence gate (0.52-0.55 after macro VIX=41 penalty of -8%). The new signal weights (h1-dominant, anti-FOMO) are working correctly — the threshold is just too tight during high-VIX periods.

**Files:**
- Modify: `solanix.toml`

- [ ] **Step 1: Lower min_confidence**

```toml
[risk]
min_confidence = 0.48                  # Was 0.55 (too tight with VIX macro penalty)
```

Rationale: 0.48 lets signals through after macro penalty (~-8% in high VIX). The anti-FOMO filter and dip-reversal bonus in the signal generator still protect entry quality.

- [ ] **Step 2: Commit**

```bash
git add solanix.toml
git commit -m "fix(solanix): ease min_confidence 0.55→0.48 for high-VIX periods"
```

---

### Task 2: Polynix — Disable micro-markets

**Evidence:**
- Micro (5-min bets): 255 trades, 20% WR, **-$33.92 P&L**
- Standard bets: 64 trades, 73.4% WR, **+$161.79 P&L**
- Micro-markets destroy portfolio performance — coin-flip-minus-fees on 5-min windows.

**Files:**
- Modify: `polynix.toml`

- [ ] **Step 1: Disable micro-markets**

```toml
[micro_markets]
enabled = false                        # DISABLED: 20% WR, -$34 over 255 trades
```

- [ ] **Step 2: Commit**

```bash
git add polynix.toml
git commit -m "fix(polynix): disable micro-markets — 20% WR, -$34 over 255 trades"
```

---

### Task 3: Deploy both

- [ ] **Step 1: Deploy to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build solanix polynix"
```

- [ ] **Step 2: Verify Solanix signals pass**

```bash
docker logs solanix --tail 10
```
Expected: signals with confidence 0.48-0.55 now pass threshold.

- [ ] **Step 3: Verify Polynix micro-markets disabled**

```bash
docker logs polynix --tail 10
```
Expected: no "Micro-scan" log lines.
