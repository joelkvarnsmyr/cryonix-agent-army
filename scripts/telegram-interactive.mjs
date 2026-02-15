#!/usr/bin/env node
/**
 * Cryonix Interactive Telegram Bot (@cryptonixis_bot)
 * 
 * Commands: /status /positions /trades /pnl /signals /risk /evolve /help
 * Auto-reports: morning brief, trade alerts, health alerts, daily summary
 * 
 * Run: node scripts/telegram-interactive.mjs
 * Docker: runs as "telegram-bot" service
 */

import pg from 'pg';
import Redis from 'ioredis';
import 'dotenv/config';

const { Client } = pg;

// ─── Config ──────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_INTERACTIVE_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_URL = process.env.POSTGRES_URL ||
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:5432/cryonix`;
const REDIS_URL = process.env.KV_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:6379`;
const WEB_URL = process.env.NEXTJS_API_URL || 'http://localhost:3000';

const POLL_INTERVAL = 1000;       // 1s polling for commands
const HEALTH_INTERVAL = 300000;   // 5min health check
const TRADE_POLL = 15000;         // 15s trade alert check

// ─── Telegram helpers ────────────────────────────────────
async function sendMessage(text, chatId = CHAT_ID) {
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return res.json();
  } catch (e) {
    console.error('Telegram send error:', e.message);
    return null;
  }
}

async function getUpdates(offset) {
  try {
    const url = `${API}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["message"]`;
    const res = await fetch(url);
    const data = await res.json();
    return data.ok ? data.result : [];
  } catch {
    return [];
  }
}

// ─── Database helpers ────────────────────────────────────
let db = null;
let redis = null;

async function connectDB() {
  if (!db) {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
  }
  return db;
}

async function connectRedis() {
  if (!redis) {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    await redis.connect();
  }
  return redis;
}

async function query(sql, params = []) {
  const client = await connectDB();
  return client.query(sql, params);
}

// ─── Command Handlers ────────────────────────────────────

async function cmdStatus() {
  try {
    const res = await fetch(`${WEB_URL}/api/health`);
    const h = await res.json();

    const services = h.services?.map(s => {
      const icon = s.status === 'healthy' ? '🟢' : s.status === 'degraded' ? '🟡' : '🔴';
      return `${icon} ${s.name}: ${s.status} (${s.latency || '?'}ms)`;
    }).join('\n') || 'No service data';

    return `🏥 <b>System Status</b>\n\n` +
      `Overall: <b>${h.status || '?'}</b>\n` +
      `Latency: ${h.totalLatency || '?'}ms\n\n` +
      services;
  } catch (e) {
    return `🔴 <b>System Status</b>\nCould not reach API: ${e.message}`;
  }
}

async function cmdPositions() {
  try {
    const r = await query(`
      SELECT symbol, quantity, entry_price, current_price, pnl, status,
             stop_loss, take_profit, opened_at
      FROM positions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 10
    `);

    if (r.rows.length === 0) return '📭 No open positions';

    const lines = r.rows.map(p => {
      const pnl = parseFloat(p.pnl || 0);
      const icon = pnl >= 0 ? '🟢' : '🔴';
      return `${icon} <b>${p.symbol}</b>\n` +
        `   Entry: $${parseFloat(p.entry_price).toFixed(4)} | Now: $${parseFloat(p.current_price || p.entry_price).toFixed(4)}\n` +
        `   P&L: $${pnl.toFixed(2)} | Qty: ${parseFloat(p.quantity).toFixed(6)}\n` +
        `   SL: $${parseFloat(p.stop_loss || 0).toFixed(4)} | TP: $${parseFloat(p.take_profit || 0).toFixed(4)}`;
    });

    return `📊 <b>Open Positions (${r.rows.length})</b>\n\n${lines.join('\n\n')}`;
  } catch (e) {
    // Try Redis fallback
    try {
      const rd = await connectRedis();
      const data = await rd.get('positions:open');
      if (!data) return '📭 No open positions';
      const positions = JSON.parse(data);
      const count = Object.keys(positions).length;
      if (count === 0) return '📭 No open positions';

      const lines = Object.entries(positions).map(([sym, p]) => {
        const pnl = p.pnl || 0;
        const icon = pnl >= 0 ? '🟢' : '🔴';
        return `${icon} <b>${sym}</b>: $${p.entryPrice?.toFixed(4) || '?'} → P&L: $${pnl.toFixed(2)}`;
      });
      return `📊 <b>Open Positions (${count})</b>\n\n${lines.join('\n')}`;
    } catch {
      return `❌ Could not fetch positions: ${e.message}`;
    }
  }
}

async function cmdTrades() {
  try {
    const r = await query(`
      SELECT symbol, side, quantity, entry_price, exit_price, pnl, pattern, 
             confidence, status, timestamp
      FROM trades ORDER BY timestamp DESC LIMIT 10
    `);

    if (r.rows.length === 0) return '📭 No recent trades';

    const lines = r.rows.map(t => {
      const pnl = parseFloat(t.pnl || 0);
      const icon = t.side === 'BUY' ? '🟩' : '🟥';
      const pnlStr = t.status === 'CLOSED' ? ` | P&L: $${pnl.toFixed(2)}` : '';
      const time = new Date(t.timestamp).toLocaleString('sv-SE', { timeZone: 'UTC' });
      return `${icon} <b>${t.side} ${t.symbol}</b> @ $${parseFloat(t.entry_price).toFixed(4)}${pnlStr}\n` +
        `   Pattern: ${t.pattern || '?'} | Conf: ${((t.confidence || 0) * 100).toFixed(0)}% | ${t.status}\n` +
        `   ${time}`;
    });

    return `📈 <b>Recent Trades</b>\n\n${lines.join('\n\n')}`;
  } catch (e) {
    return `❌ Could not fetch trades: ${e.message}`;
  }
}

async function cmdPnl() {
  try {
    const daily = await query(`
      SELECT 
        COUNT(*) as trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(pnl) as total_pnl,
        AVG(pnl) as avg_pnl,
        MAX(pnl) as best,
        MIN(pnl) as worst
      FROM trades 
      WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '24 hours'
    `);

    const weekly = await query(`
      SELECT 
        COUNT(*) as trades,
        SUM(pnl) as total_pnl
      FROM trades 
      WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '7 days'
    `);

    const d = daily.rows[0];
    const w = weekly.rows[0];
    const trades = parseInt(d.trades || 0);
    const winRate = trades > 0 ? ((parseInt(d.wins || 0) / trades) * 100).toFixed(0) : '0';
    const totalPnl = parseFloat(d.total_pnl || 0);
    const icon = totalPnl >= 0 ? '📈' : '📉';

    return `${icon} <b>P&L Summary</b>\n\n` +
      `<b>24h:</b>\n` +
      `  P&L: <b>$${totalPnl.toFixed(2)}</b>\n` +
      `  Trades: ${trades} | Win Rate: ${winRate}%\n` +
      `  Best: $${parseFloat(d.best || 0).toFixed(2)} | Worst: $${parseFloat(d.worst || 0).toFixed(2)}\n` +
      `  Avg: $${parseFloat(d.avg_pnl || 0).toFixed(2)}\n\n` +
      `<b>7d:</b>\n` +
      `  P&L: <b>$${parseFloat(w.total_pnl || 0).toFixed(2)}</b>\n` +
      `  Trades: ${parseInt(w.trades || 0)}`;
  } catch (e) {
    return `❌ Could not fetch P&L: ${e.message}`;
  }
}

async function cmdSignals() {
  try {
    const rd = await connectRedis();
    const pending = await rd.llen('trades:pending');
    const approved = await rd.llen('trades:approved');
    const rejected = await rd.llen('trades:rejected');

    const recent = await query(`
      SELECT symbol, action, confidence, pattern, entry_price, timestamp
      FROM signals WHERE executed = false ORDER BY timestamp DESC LIMIT 5
    `);

    let signalLines = '';
    if (recent.rows.length > 0) {
      signalLines = '\n\n<b>Latest unexecuted:</b>\n' + recent.rows.map(s => {
        const time = new Date(s.timestamp).toLocaleString('sv-SE', { timeZone: 'UTC' });
        return `🔔 ${s.action} ${s.symbol} @ $${parseFloat(s.entry_price || 0).toFixed(4)}\n` +
          `   ${s.pattern} | ${((s.confidence || 0) * 100).toFixed(0)}% | ${time}`;
      }).join('\n');
    }

    return `📡 <b>Signal Queue</b>\n\n` +
      `⏳ Pending: <b>${pending}</b>\n` +
      `✅ Approved: ${approved}\n` +
      `❌ Rejected: ${rejected}` +
      signalLines;
  } catch (e) {
    return `❌ Could not fetch signals: ${e.message}`;
  }
}

async function cmdRisk() {
  try {
    const positions = await query(`
      SELECT COUNT(*) as count, 
             SUM(ABS(pnl)) as exposure,
             SUM(pnl) as unrealized_pnl
      FROM positions WHERE status = 'OPEN'
    `);

    const dailyLoss = await query(`
      SELECT SUM(pnl) as daily_pnl
      FROM trades 
      WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '24 hours'
    `);

    const p = positions.rows[0];
    const dailyPnl = parseFloat(dailyLoss.rows[0]?.daily_pnl || 0);
    const openCount = parseInt(p.count || 0);
    const unrealized = parseFloat(p.unrealized_pnl || 0);

    const riskLevel = dailyPnl < -10 ? '🔴 HIGH' : dailyPnl < -5 ? '🟡 MODERATE' : '🟢 LOW';

    return `⚠️ <b>Risk Dashboard</b>\n\n` +
      `Risk Level: <b>${riskLevel}</b>\n` +
      `Open Positions: ${openCount}\n` +
      `Unrealized P&L: $${unrealized.toFixed(2)}\n` +
      `Daily Realized: $${dailyPnl.toFixed(2)}\n\n` +
      `Max Daily Loss Limit: $50`;
  } catch (e) {
    return `❌ Could not fetch risk data: ${e.message}`;
  }
}

async function cmdEvolve() {
  try {
    const r = await query(`
      SELECT run_id, started_at, ended_at, duration_seconds, status, 
             performance_data, changes_made
      FROM evolution_runs ORDER BY started_at DESC LIMIT 3
    `);

    if (r.rows.length === 0) return '🧬 No evolution runs recorded yet';

    const lines = r.rows.map(e => {
      const dur = e.duration_seconds ? `${parseFloat(e.duration_seconds).toFixed(0)}s` : '?';
      const icon = e.status === 'SUCCESS' ? '✅' : '❌';
      const time = new Date(e.started_at).toLocaleString('sv-SE', { timeZone: 'UTC' });
      return `${icon} <b>${e.status}</b> (${dur})\n` +
        `   Run: <code>${e.run_id}</code>\n` +
        `   Time: ${time}`;
    });

    return `🧬 <b>Recent Evolution Runs</b>\n\n${lines.join('\n\n')}`;
  } catch (e) {
    return `🧬 <b>Evolution Status</b>\nNo data available: ${e.message}`;
  }
}

function cmdHelp() {
  return `🤖 <b>Cryonix Trading Bot</b>\n\n` +
    `<b>Commands:</b>\n` +
    `/status — System health\n` +
    `/positions — Open positions\n` +
    `/trades — Recent trades\n` +
    `/pnl — P&L summary (24h + 7d)\n` +
    `/signals — Signal queue\n` +
    `/risk — Risk exposure\n` +
    `/gainers — Top movers & volume surges\n` +
    `/audit — Full system audit\n` +
    `/evolve — Evolution history\n` +
    `/help — This menu\n\n` +
    `<b>Auto Reports:</b>\n` +
    `📡 Every 15min — Pipeline health\n` +
    `📅 08:00 UTC — Morning brief\n` +
    `📅 14:00 UTC — System audit\n` +
    `📅 22:00 UTC — Daily summary\n` +
    `⚡ Real-time — Trade & health alerts`;
}

async function cmdAudit() {
  try {
    // 1. Signal distribution (24h)
    const sigDist = await query(`
      SELECT action, COUNT(*) as cnt 
      FROM signals WHERE timestamp > NOW() - INTERVAL '24 hours' 
      GROUP BY action
    `);
    const buySignals = parseInt(sigDist.rows.find(r => r.action === 'BUY')?.cnt || 0);
    const sellSignals = parseInt(sigDist.rows.find(r => r.action === 'SELL')?.cnt || 0);
    const totalSignals = buySignals + sellSignals;
    const buyPct = totalSignals > 0 ? ((buySignals / totalSignals) * 100).toFixed(1) : '0';

    // 2. Pattern breakdown (24h)
    const patterns = await query(`
      SELECT pattern, COUNT(*) as cnt 
      FROM signals WHERE timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY pattern ORDER BY cnt DESC LIMIT 5
    `);

    // 3. Execution stats
    const execStats = await query(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed,
        SUM(pnl) as total_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
      FROM trades WHERE timestamp > NOW() - INTERVAL '24 hours'
    `);
    const ex = execStats.rows[0];
    const totalTrades = parseInt(ex.total_trades || 0);

    // 4. Open positions
    const openPos = await query(`SELECT COUNT(*) as cnt FROM positions WHERE status = 'OPEN'`);

    // 5. Redis queue state
    let pendingQueue = 0, approvedQueue = 0;
    try {
      const rd = await connectRedis();
      pendingQueue = await rd.llen('trades:pending');
      approvedQueue = await rd.llen('trades:approved');
    } catch {}

    // 6. Last BUY signal
    const lastBuy = await query(`
      SELECT symbol, confidence, pattern, timestamp 
      FROM signals WHERE action = 'BUY' ORDER BY timestamp DESC LIMIT 1
    `);
    const lastBuyStr = lastBuy.rows[0]
      ? `${lastBuy.rows[0].symbol} (${(lastBuy.rows[0].confidence * 100).toFixed(0)}% ${lastBuy.rows[0].pattern}) ${timeSince(lastBuy.rows[0].timestamp)}`
      : 'None';

    // 7. Health
    let healthStr = '?';
    try {
      const hRes = await fetch(`${WEB_URL}/api/health`);
      const h = await hRes.json();
      healthStr = h.services?.map(s => {
        const icon = s.status === 'healthy' ? '🟢' : s.status === 'degraded' ? '🟡' : '🔴';
        return `${icon} ${s.name}`;
      }).join(' | ') || '?';
    } catch {}

    // 8. Detect issues
    const issues = [];
    if (buySignals === 0) issues.push('⚠️ No BUY signals in 24h');
    else if (buyPct < 5) issues.push(`⚠️ Only ${buyPct}% BUY signals (market overbought?)`);
    if (totalTrades === 0) issues.push('⚠️ No trades executed in 24h');
    if (pendingQueue === 0 && buySignals > 0) issues.push('⚠️ BUY signals not reaching Redis queue');
    if (parseInt(openPos.rows[0].cnt) === 0 && totalTrades === 0) issues.push('⚠️ No open positions and no trades');

    const patternLines = patterns.rows.map(p =>
      `  ${p.pattern}: ${p.cnt}`
    ).join('\n');

    const issueBlock = issues.length > 0
      ? `\n<b>⚠️ Issues Detected:</b>\n${issues.join('\n')}`
      : '\n✅ No issues detected';

    return `🔍 <b>System Audit</b>\n\n` +
      `<b>Services:</b> ${healthStr}\n\n` +
      `<b>Signals (24h):</b>\n` +
      `  BUY: ${buySignals} (${buyPct}%) | SELL: ${sellSignals}\n` +
      `  Total: ${totalSignals}\n\n` +
      `<b>Top Patterns:</b>\n${patternLines}\n\n` +
      `<b>Execution:</b>\n` +
      `  Trades: ${totalTrades} | P&L: $${parseFloat(ex.total_pnl || 0).toFixed(2)}\n` +
      `  Open positions: ${openPos.rows[0].cnt}\n` +
      `  Queue: ${pendingQueue} pending, ${approvedQueue} approved\n\n` +
      `<b>Last BUY:</b> ${lastBuyStr}` +
      issueBlock;
  } catch (e) {
    return `🔍 <b>System Audit</b>\nError: ${e.message}`;
  }
}

function timeSince(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─── Gainer Scanner command ──────────────────────────────
async function cmdGainers() {
  try {
    const rd = await connectRedis();
    const raw = await rd.get('scanner:top_movers');
    if (!raw) return '📊 <b>Top Movers</b>\n\nNo scanner data yet. Engine gainer scanner runs every 15min.';

    const data = JSON.parse(raw);
    const age = Math.floor((Date.now() / 1000 - data.timestamp) / 60);

    const fmtRow = (r) => {
      const sym = r.symbol.split('/')[0];
      const arrow = r.change_1h > 0 ? '🟢' : r.change_1h < -2 ? '🔴' : '⚪';
      return `${arrow} <code>${sym.padEnd(6)}</code> ${r.change_1h > 0 ? '+' : ''}${r.change_1h}% (4h: ${r.change_4h > 0 ? '+' : ''}${r.change_4h}%)`;
    };

    const gainers = (data.gainers || []).slice(0, 5).map(fmtRow).join('\n');
    const losers = (data.losers || []).slice(0, 5).map(fmtRow).join('\n');

    let volBlock = '';
    if (data.volume_surges?.length > 0) {
      const vols = data.volume_surges.slice(0, 5).map(r => {
        const sym = r.symbol.split('/')[0];
        return `⚡ <code>${sym.padEnd(6)}</code> ${r.vol_ratio}x vol | ${r.change_1h > 0 ? '+' : ''}${r.change_1h}%`;
      }).join('\n');
      volBlock = `\n<b>Volume Surges:</b>\n${vols}\n`;
    }

    return `📊 <b>Top Movers</b> (${age}min ago)\n\n` +
      `<b>🚀 Gainers (1h):</b>\n${gainers || 'None'}\n\n` +
      `<b>📉 Losers (1h):</b>\n${losers || 'None'}\n` +
      volBlock +
      `\n<i>Scanned: ${data.total_scanned} pairs</i>`;
  } catch (e) {
    return `📊 <b>Top Movers</b>\nError: ${e.message}`;
  }
}

// ─── Pipeline Health Report (15min) ──────────────────────
async function pipelineHealthReport() {
  try {
    const rd = await connectRedis();

    // Queue sizes
    const pending = await rd.llen('trades:pending');
    const approved = await rd.llen('trades:approved');

    // Open positions from Redis (now includes live pnlPct from monitoring)
    const posRaw = await rd.get('positions:open');
    const positions = posRaw ? JSON.parse(posRaw) : [];

    // Portfolio state from Redis
    const riskRaw = await rd.get('risk:portfolio_state');
    const riskState = riskRaw ? JSON.parse(riskRaw) : null;

    // Daily state from Redis
    const dailyRaw = await rd.get('daily:state');
    const dailyState = dailyRaw ? JSON.parse(dailyRaw) : null;

    // Signal funnel: signals generated (24h) vs trades executed (24h)
    const funnelResult = await query(`
      SELECT
        (SELECT COUNT(*) FROM signals WHERE timestamp > NOW() - INTERVAL '24 hours' AND action = 'BUY') as signals_24h,
        (SELECT COUNT(*) FROM trades WHERE timestamp > NOW() - INTERVAL '24 hours') as trades_24h
    `);
    const signals24h = parseInt(funnelResult.rows[0]?.signals_24h || 0);
    const trades24h = parseInt(funnelResult.rows[0]?.trades_24h || 0);
    const conversionPct = signals24h > 0 ? ((trades24h / signals24h) * 100).toFixed(1) : '0';

    // Recent signals (last 15min)
    const recentSigs = await query(`
      SELECT action, COUNT(*) as cnt
      FROM signals WHERE timestamp > NOW() - INTERVAL '15 minutes'
      GROUP BY action
    `);
    const buys15m = parseInt(recentSigs.rows.find(r => r.action === 'BUY')?.cnt || 0);
    const sells15m = parseInt(recentSigs.rows.find(r => r.action === 'SELL')?.cnt || 0);

    // Recent trades (last 1h)
    const recentTrades = await query(`
      SELECT COUNT(*) as cnt, SUM(pnl) as pnl
      FROM trades WHERE timestamp > NOW() - INTERVAL '1 hour'
    `);
    const trades1h = parseInt(recentTrades.rows[0]?.cnt || 0);
    const pnl1h = parseFloat(recentTrades.rows[0]?.pnl || 0);

    // Gainer scanner data
    let topMover = '';
    const scannerRaw = await rd.get('scanner:top_movers');
    if (scannerRaw) {
      const scanner = JSON.parse(scannerRaw);
      const top = scanner.gainers?.[0];
      if (top) topMover = `\n🔥 Top: ${top.symbol.split('/')[0]} ${top.change_1h > 0 ? '+' : ''}${top.change_1h}%`;
    }

    // Portfolio summary
    let portfolioBlock = '';
    if (riskState) {
      const capital = parseFloat(riskState.total_capital || 0);
      const dailyPnl = parseFloat(riskState.daily_pnl || 0);
      const dailyLimit = capital * 0.05;
      const drawdownPct = capital > 0 ? ((dailyPnl / capital) * 100).toFixed(2) : '0';
      const posValue = positions.reduce((sum, p) => sum + (p.entryPrice || 0) * (p.quantity || 0), 0);
      const cashPct = capital > 0 ? (((capital - posValue) / capital) * 100).toFixed(0) : '?';
      portfolioBlock = `\n💰 Capital: $${capital.toFixed(2)} | Cash: ${cashPct}% | Day P&L: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)} (${drawdownPct}%)`;
    }

    // Position P&L summary (now uses live pnlPct from monitoring cycle)
    let posBlock = '';
    if (positions.length > 0) {
      const posLines = positions.map(p => {
        const sym = p.symbol.split('/')[0];
        const pnlPct = p.pnlPct || 0;
        const icon = pnlPct > 0.5 ? '🟢' : pnlPct < -0.5 ? '🔴' : '⚪';
        return `${icon}${sym} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
      });
      posBlock = `\n📌 ${posLines.join(' | ')}`;
    }

    // Signal funnel line
    const funnelBlock = `\n📊 Funnel 24h: ${signals24h} signals → ${trades24h} trades (${conversionPct}%)`;

    // Scanner alerts
    let alertBlock = '';
    const alertsRaw = await rd.get('scanner:alerts');
    if (alertsRaw) {
      const alerts = JSON.parse(alertsRaw);
      if (alerts.length > 0) {
        alertBlock = '\n🚨 ' + alerts.map(a =>
          `${a.symbol.split('/')[0]} ${a.change_1h > 0 ? '+' : ''}${a.change_1h}%`
        ).join(', ');
      }
    }

    return `📡 <b>Pipeline</b> (${new Date().toUTCString().slice(17, 22)} UTC)\n` +
      `Signals 15m: ${buys15m} BUY | Queue: ${pending} pending` +
      portfolioBlock + posBlock + funnelBlock +
      `\nTrades 1h: ${trades1h} ($${pnl1h.toFixed(2)})` +
      topMover + alertBlock;
  } catch (e) {
    return null; // Silently fail — don't spam errors
  }
}

// ─── Command router ──────────────────────────────────────
const COMMANDS = {
  '/status': cmdStatus,
  '/positions': cmdPositions,
  '/trades': cmdTrades,
  '/pnl': cmdPnl,
  '/signals': cmdSignals,
  '/risk': cmdRisk,
  '/audit': cmdAudit,
  '/gainers': cmdGainers,
  '/evolve': cmdEvolve,
  '/help': cmdHelp,
  '/start': cmdHelp,
};

async function handleCommand(text, chatId) {
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  const handler = COMMANDS[cmd];
  if (!handler) return;

  try {
    const response = typeof handler === 'function' ? await handler() : handler;
    await sendMessage(response, chatId);
  } catch (e) {
    await sendMessage(`❌ Error: ${e.message}`, chatId);
  }
}

// ─── Scheduled Reports ───────────────────────────────────
let lastTradeId = null;
let lastHealthStatus = 'healthy';

async function checkTradeAlerts() {
  try {
    const r = await query(`
      SELECT id, symbol, side, entry_price, pnl, pattern, status, timestamp
      FROM trades ORDER BY id DESC LIMIT 1
    `);
    if (r.rows.length === 0) return;

    const latest = r.rows[0];
    if (lastTradeId === null) { lastTradeId = latest.id; return; }
    if (latest.id <= lastTradeId) return;

    lastTradeId = latest.id;
    const icon = latest.side === 'BUY' ? '🟩' : '🟥';
    const pnlStr = latest.pnl ? ` | P&L: $${parseFloat(latest.pnl).toFixed(2)}` : '';
    await sendMessage(
      `${icon} <b>Trade Executed</b>\n\n` +
      `${latest.side} <b>${latest.symbol}</b> @ $${parseFloat(latest.entry_price).toFixed(4)}${pnlStr}\n` +
      `Pattern: ${latest.pattern || '?'} | Status: ${latest.status}`
    );
  } catch { /* silent */ }
}

async function checkHealthAlerts() {
  try {
    const res = await fetch(`${WEB_URL}/api/health`);
    const h = await res.json();
    const status = h.status || 'unknown';

    if (status !== 'healthy' && lastHealthStatus === 'healthy') {
      const down = h.services?.filter(s => s.status !== 'healthy')
        .map(s => `🔴 ${s.name}: ${s.status}`).join('\n') || '';
      await sendMessage(`🚨 <b>System Alert</b>\n\nStatus: <b>${status}</b>\n\n${down}`);
    }
    lastHealthStatus = status;
  } catch { /* silent */ }
}

async function sendMorningBrief() {
  const status = await cmdStatus();
  const pnl = await cmdPnl();
  const positions = await cmdPositions();

  await sendMessage(
    `☀️ <b>Morning Brief</b> (${new Date().toISOString().split('T')[0]})\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━`
  );
  await sendMessage(status);
  await sendMessage(pnl);
  await sendMessage(positions);
}

async function sendDailySummary() {
  const pnl = await cmdPnl();
  const risk = await cmdRisk();
  const trades = await cmdTrades();

  await sendMessage(
    `🌙 <b>Daily Summary</b> (${new Date().toISOString().split('T')[0]})\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━`
  );
  await sendMessage(pnl);
  await sendMessage(risk);
  await sendMessage(trades);
}

// ─── Scheduled report timers ─────────────────────────────
function startScheduledReports() {
  // Check every minute if it's time for a scheduled report
  let lastMorning = null;
  let lastEvening = null;
  let lastAudit = null;

  setInterval(() => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const today = now.toISOString().split('T')[0];

    // Morning brief at 08:00 UTC
    if (utcHour === 8 && utcMinute === 0 && lastMorning !== today) {
      lastMorning = today;
      sendMorningBrief().catch(console.error);
    }

    // System audit at 14:00 UTC
    if (utcHour === 14 && utcMinute === 0 && lastAudit !== today) {
      lastAudit = today;
      cmdAudit().then(r => sendMessage(r)).catch(console.error);
    }

    // Daily summary at 22:00 UTC
    if (utcHour === 22 && utcMinute === 0 && lastEvening !== today) {
      lastEvening = today;
      sendDailySummary().catch(console.error);
    }
  }, 60000);

  // Trade alerts every 15s
  setInterval(() => checkTradeAlerts().catch(() => {}), TRADE_POLL);

  // Health alerts every 5min
  setInterval(() => checkHealthAlerts().catch(() => {}), HEALTH_INTERVAL);

  // Pipeline health report every 15min
  setInterval(async () => {
    try {
      const report = await pipelineHealthReport();
      if (report) await sendMessage(report);
    } catch {}
  }, 900000);

  console.log('📅 Scheduled reports: 08:00 (morning), 22:00 (daily), 15min pipeline, trade alerts, health checks');
}

// ─── Main polling loop ───────────────────────────────────
async function main() {
  console.log('🤖 Starting Cryonix Interactive Telegram Bot...');

  if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_INTERACTIVE_BOT_TOKEN not set');
    process.exit(1);
  }
  if (!CHAT_ID) {
    console.error('❌ TELEGRAM_CHAT_ID not set');
    process.exit(1);
  }

  // Connect to services
  try {
    await connectDB();
    console.log('✅ Postgres connected');
  } catch (e) {
    console.warn('⚠️  Postgres not available:', e.message);
  }

  try {
    await connectRedis();
    console.log('✅ Redis connected');
  } catch (e) {
    console.warn('⚠️  Redis not available:', e.message);
  }

  // Start scheduled reports
  startScheduledReports();

  // Send startup message
  await sendMessage('🤖 <b>Cryonix Bot Online</b>\n\nType /help for commands.');
  console.log('✅ Bot running — polling for commands...');

  // Polling loop
  let offset = 0;
  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (msg?.text?.startsWith('/')) {
          console.log(`[CMD] ${msg.from?.first_name}: ${msg.text}`);
          await handleCommand(msg.text, msg.chat.id);
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Graceful shutdown ───────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await sendMessage('🛑 Bot going offline');
  if (db) await db.end();
  if (redis) await redis.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await sendMessage('🛑 Bot going offline (SIGTERM)');
  if (db) await db.end();
  if (redis) await redis.quit();
  process.exit(0);
});

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
