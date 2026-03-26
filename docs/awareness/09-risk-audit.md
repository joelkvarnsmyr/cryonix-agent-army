# 🔴 Cryonix System Risk Audit

> **Audit Date:** 2026-03-20
> **Scope:** Full system — configuration, API routes, trading logic, deployment, evolution engine, infrastructure
> **Methodology:** Static code review + configuration analysis

---

## Severity Scale

| Level | Meaning |
|-------|---------|
| 🔴 CRITICAL | Immediate risk of fund loss or unauthorized access |
| 🟠 HIGH | Significant security gap, exploitation possible |
| 🟡 MEDIUM | Defense gap, not immediately exploitable |
| 🟢 LOW | Best-practice deviation, minor concern |

---

## 🔴 CRITICAL FINDINGS

### 1. API Routes Have ZERO Authentication

**Location:** `apps/web/src/app/api/auto-trade/route.ts` (and all `/api/*` routes)
**Risk:** Anyone with network access can trigger trades, view positions, modify configuration

All API routes in the Next.js app are completely unauthenticated. There is no `middleware.ts`, no API key validation, no JWT checks, and no bearer token verification. The `auto-trade/route.ts` only checks `CRYONIX_ENV === 'production'` (environment guard), but this protects against accidental dev trading — NOT against unauthorized access.

**Attack vector:**
```
curl http://<your-vm-ip>/api/auto-trade  → triggers trade cycle
curl http://<your-vm-ip>/api/health      → exposes trading state, positions, P&L
curl http://<your-vm-ip>/api/positions   → exposes all open positions
curl http://<your-vm-ip>/api/signals     → view/inject signals
```

**Impact:** Full control over trading operations for anyone on the network.

**Fix (Priority 1):**
- Add API key middleware (`x-api-key` header check) for all `/api/*` routes
- Or restrict Caddy to only allow Tailscale IPs
- Add `basicauth` to Caddyfile as immediate stopgap

---

### 2. Real API Keys in `.env.prod` (Committed or Accessible)

**Location:** `.env.prod` (root directory)
**Risk:** Binance API keys, xAI Grok key, and Helius key in plaintext

While `.gitignore` has `.env*` patterns and git history shows only `.env.example` was committed (✅), the `.env.prod` file exists locally with real credentials:
- `BINANCE_API_KEY` + `BINANCE_API_SECRET` — **exchange trading keys**
- `XAI_API_KEY` — xAI/Grok API key
- Postgres password: literal `password`

**Concern:** If this file was ever committed, all keys are in git history permanently. Even if not committed, it exists unencrypted on disk alongside the codebase.

**Fix (Priority 1):**
- Rotate ALL keys in `.env.prod` immediately (Binance, xAI, Helius)
- Use a secrets manager (Docker secrets, Azure Key Vault, or at minimum `sops`)
- Verify `.env.prod` was never committed: `git log --all -p -- .env.prod`
- Set `.env.prod` file permissions to `600` (owner read/write only)

---

### 3. Docker Socket Mounted in aktienix-brain

**Location:** `docker-compose.prod.yml` line 301
```yaml
- /var/run/docker.sock:/var/run/docker.sock
```
**Risk:** Container escape — full host control

The `aktienix-brain` container has the Docker socket mounted, giving it **root-level access to the entire host**. If the Claude Code CLI (which runs inside this container) is compromised or produces malicious output, it can:
- Start/stop any container
- Read environment variables from all containers
- Mount host filesystems
- Execute arbitrary commands on the host

**Fix (Priority 1):**
- Remove Docker socket mount; use Docker CLI over SSH or a restricted Docker API proxy
- Or create a dedicated `docker restart aktienix` script on the host called via SSH

---

### 4. Helius API Key in `.env`

**Location:** `.env` (root, line 3)
```
HELIUS_API_KEY=af922ecb-a08b-40da-80aa-e88c9236cdd4
```

This file IS in `.gitignore`, but it shows a real API key value. This key provides access to Solana RPC and wallet monitoring through Helius.

**Fix:** Rotate this key, ensure it was never committed.

---

## 🟠 HIGH FINDINGS

### 5. Redis Has No Authentication

**Location:** `docker-compose.prod.yml` line 28
```yaml
command: redis-server --appendonly yes
```

Redis runs with zero authentication. No `requirepass`, no ACL. While it's bound to Docker internal network + `127.0.0.1:6379`, any process on the host can read/write:
- `positions:open` — manipulate open positions
- `trades:pending` — inject fake signals
- `daily:state` — reset circuit breakers
- `instance:trading_lock` — disable trading lock

**Fix:**
- Add `--requirepass <strong-password>` to Redis command
- Update all `KV_URL` references to include password: `redis://:password@redis:6379`

---

### 6. Postgres Default Password

**Location:** `docker-compose.prod.yml` line 11
```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-password}
```

The fallback password is literally `password`. If `POSTGRES_PASSWORD` is not set in `.env`, Postgres runs with this default. The database contains ALL trade history, positions, evolution logs, and calibration data.

**Fix:**
- Generate a strong random password and set it in `.env`
- Remove the `:-password` fallback entirely (fail-closed)

---

### 7. Caddy Serves HTTP Only — No TLS, No Auth

**Location:** `Caddyfile`
```
:80 {
    reverse_proxy web:3000
}
```

Dashboard and ALL API endpoints are served over plain HTTP with zero authentication. Combined with Finding #1, anyone who can reach port 80 has full unauthenticated access to the entire trading system.

**Fix:**
- Add `basicauth` directive to Caddyfile
- If using Tailscale, restrict to Tailscale IPs
- Enable TLS if exposed to internet (Caddy auto-TLS with a domain)

---

### 8. Health Endpoint Exposes Sensitive Trading State

**Location:** `apps/web/src/app/api/health/route.ts`

The `/api/health` endpoint returns (publicly, no auth):
- `configHash` — config version fingerprint
- `open_positions` count
- `daily_trades` count
- `daily_pnl` — actual P&L in dollars
- `capital` — total account capital
- `regime` — current market regime classification
- Service status and latency for Redis, Postgres, Engine, Binance

**Fix:**
- Split into `/api/health` (basic ok/error, no sensitive data) and `/api/health/detail` (authenticated, full diagnostics)
- Or add auth to the entire route

---

### 9. Evolution Engine Has Shell Access via Claude Code CLI

**Location:** `scripts/evolution/copilot-evolution.mjs`

The evolution engine runs Claude Code CLI with `allowedTools` including `Bash(...)` commands. While scoped to verification scripts, Claude Code has `Edit` and `Read` access to ALL files in the project root. The 100-line diff guard and verification suite are good safeguards, but:

- Claude Code could edit `.env` or other non-critical files that aren't in `CRITICAL_FILES`
- The `--max-budget-usd 5` limits cost but not scope
- Shell escaping could potentially be bypassed

**Mitigations already in place (good!):**
- ✅ Backup before mutation
- ✅ 100-line diff guard
- ✅ Scoped `git add` (only critical files)
- ✅ Verification suite (tests, type-check)
- ✅ Backtest gate
- ✅ Protected risk controls documented in rules

**Fix:**
- Add explicit `--disallowedTools 'Bash(*)'` except the two verification scripts
- Log full Claude output to persistent storage (already done)

---

### 10. Solana Private Key in Docker Environment

**Location:** `docker-compose.prod.yml` line 489
```yaml
- SOLANA_PRIVATE_KEY=${SOLANA_PRIVATE_KEY:-}
```

The Solanix container receives a Solana private key as an environment variable. While it defaults to empty and is only used for live mode, environment variables are:
- Visible in `docker inspect`
- Logged in some crash dumps
- Readable by any process in the container

**Fix:**
- Use Docker secrets instead of environment variables for private keys
- Or mount a keyfile with restricted permissions

---

## 🟡 MEDIUM FINDINGS

### 11. No Rate Limiting on API Routes

No rate limiting is applied to ANY API endpoint. An attacker could:
- Flood `/api/auto-trade` with requests
- Overwhelm Binance API quota via rapid calls
- Cause Grok API token exhaustion (`max_tokens = 800` per call)

**Fix:** Add rate limiting middleware (e.g., `@upstash/ratelimit` or simple Redis-based limiter).

---

### 12. Instance Lock is Self-Healing (Could Allow Parallel Trading)

**Location:** `auto-trade/route.ts` lines 40-58

The instance lock has a self-healing mechanism: if lock TTL <= 0, any instance can force-acquire it. While this prevents stale locks from blocking trading, it also means two instances could briefly trade simultaneously if timing aligns (TTL expired between check and acquire).

**Fix:** Use Redis `SET ... NX ... PX` with a UUID owner check (Redlock pattern) for truly atomic locks.

---

### 13. Position Lock Fallback Bypasses Lock

**Location:** `auto-trade/route.ts` lines 724-751

If position lock acquisition fails 3 times, the code proceeds WITHOUT the lock:
```typescript
console.warn('[POSITIONS] Lock acquisition failed, proceeding without lock');
```

This could cause race conditions where two concurrent requests read the same position state and both add/remove positions, leading to phantom positions or double-sells.

**Fix:** Fail-closed instead of fail-open. If lock cannot be acquired, skip the operation and retry next cycle.

---

### 14. Auto-Deploy Pulls from `main` Without Branch Protection

**Location:** `scripts/deploy/auto-deploy.sh`

The auto-deploy script runs every minute and does `git pull --ff-only origin main`. If someone pushes malicious code to `main`, it's automatically deployed within 60 seconds. While the health check + rollback is a good safety net, it only checks if containers START — not if the code is safe.

**Fix:**
- Enable GitHub branch protection (require PR reviews)
- Add a `deploy-approved` tag/label requirement before auto-deploy pulls

---

### 15. Telegram Bot Token in `.env` Without Validation

Multiple services receive Telegram bot tokens. If compromised, an attacker could:
- Send fake trading alerts
- Impersonate the system in Telegram
- Read chat messages if the bot has that access

**Fix:** Ensure Telegram bot tokens have minimum necessary permissions. Consider using webhook mode instead of polling (reduces exposure).

---

## 🟢 LOW FINDINGS

### 16. CCXT Timeout is Short (10s)

**Location:** `auto-trade/route.ts` line 90
```typescript
timeout: 10000, // 10s timeout on all Binance API calls
```

In high-volatility markets, Binance can be slow. A 10s timeout could cause order placement failures during critical moments (e.g., stop-loss placement after entry).

**Fix:** Consider 15-20s timeout for order execution, keep 10s for market data.

---

### 17. No IP Whitelist Enforcement in Code

While `.env.example` mentions "enable IP whitelist" for Binance API keys, there's no verification in the codebase that the keys actually have IP restrictions enabled. This is a Binance-side setting.

**Fix:** Document and verify that production Binance API keys have:
- ✅ IP whitelist enabled (VM's public IP only)
- ✅ Withdrawal disabled
- ✅ Only spot/margin trading enabled (no futures if not used)

---

### 18. `copilot-evolution.mjs` Hardcoded Project Root

**Location:** `copilot-evolution.mjs` line 71
```javascript
PROJECT_ROOT: '/home/azureuser/cryonix',
```

The evolution engine assumes a fixed path. If the deployment directory changes, evolution silently operates on wrong files.

**Fix:** Use `process.cwd()` or read from environment variable.

---

## Severity Summary

| Severity | Count | Examples |
|----------|-------|---------|
| 🔴 CRITICAL | 4 | Zero API auth, API keys in plaintext, Docker socket mount, Helius key exposed |
| 🟠 HIGH | 6 | Redis no auth, Postgres default pwd, HTTP-only, health data leak, evolution shell access, Solana private key |
| 🟡 MEDIUM | 5 | No rate limiting, lock fallbacks, auto-deploy branch protection, Telegram tokens |
| 🟢 LOW | 3 | CCXT timeout, IP whitelist, hardcoded paths |
| **Total** | **18** | |

---

## Priority Remediation Roadmap

### Immediate (Do Today)
1. 🔴 Add `basicauth` to Caddyfile (5 minutes, blocks all unauthenticated access)
2. 🔴 Rotate ALL API keys in `.env.prod` (Binance, xAI, Helius)
3. 🔴 Remove Docker socket mount from aktienix-brain
4. 🟠 Add `--requirepass` to Redis

### This Week
5. 🟠 Change Postgres password to something strong, remove `:-password` fallback
6. 🟠 Split health endpoint (public basic / authenticated detailed)
7. 🟠 Add API key middleware for all `/api/*` routes
8. 🟡 Add rate limiting middleware

### This Month
9. 🟡 Enable GitHub branch protection for `main`
10. 🟡 Migrate secrets to Docker secrets or Azure Key Vault
11. 🟡 Implement Redlock for position locking
12. 🟢 Review and document Binance API key permissions

---

## What's Working Well ✅

Despite the gaps, Cryonix has several strong safety patterns:

- **Fail-closed AI validation** — If Grok is down, trades are rejected (not approved)
- **Environment guard** — Dev mode blocks real order execution
- **Instance locking** — Prevents multiple traders on same account
- **Evolution safety net** — 100-line diff guard, backup + rollback, verification suite, scoped git staging
- **Duplicate position prevention** — Redis check before opening positions
- **Circuit breakers** — Daily loss limit (5%), weekly loss limit (10%), consecutive loss pause
- **Native stop-loss** — Hardware SL order on Binance as safety net
- **Stagnation timeout** — Auto-close stale positions
- **Config versioning** — Trades tagged with config hash for traceability
- **Auto-deploy rollback** — Health check + automatic revert on failure
