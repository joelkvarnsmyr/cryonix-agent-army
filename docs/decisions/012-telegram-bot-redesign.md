# ADR-012: Telegram Bot Redesign — Fewer, Richer Messages
**Date:** 2026-02-25 | **Status:** Active

## Context (Why)
The Telegram bot sent ~100+ messages/day: pipeline health every 15min, system audit at 14:00, plus trade alerts. Most were noise with no actionable information. User was ignoring all messages.

## Decision (What)
Switch from scheduled spam to **event-driven** alerts:
- **Remove**: 15min pipeline health, 14:00 audit
- **Improve trade alerts**: Include WHY (patterns + AI reasoning + R:R ratio + capital context)
- **Add close alerts**: P&L, hold time, close reason, weekly running stats
- **Keep**: 08:00 morning brief, 22:00 daily summary

## Consequences (How)
- ~6-10 messages/day instead of 100+
- Every message is actionable or informative
- Trade alerts include AI validation reasoning (joined from `validation_history`)
- User can see complete trade lifecycle: open -> monitor -> close
