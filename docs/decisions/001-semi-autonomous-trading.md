# ADR-001: Semi-Autonomous Trading
**Date:** 2026-02-13 | **Status:** Active

## Context (Why)
Manual crypto trading is time-consuming and emotional. Fully autonomous trading without guardrails is risky for a new system with unproven strategies. Need a middle ground.

## Decision (What)
Semi-autonomous approach:
- System autonomously generates signals, validates them, and executes trades
- Human sets strategy parameters and risk limits via `cryonix.toml`
- Confidence threshold (currently 70%) controls signal quality gate
- Multiple validation layers: RiskGate -> EV Model -> X Sentiment -> GROK AI -> Spread Check
- All trades logged with full audit trail (config version, AI reasoning, patterns)

## Consequences (How)
- System trades 24/7 without human intervention
- Human controls WHAT to trade (symbol whitelist, pattern focus) and HOW MUCH (position sizing, max positions)
- System decides WHEN to trade (signal timing, confidence threshold)
- Full accountability: every trade traceable to specific config version and AI reasoning
- Evolution system and AI Brain can tune parameters autonomously within safety bounds
