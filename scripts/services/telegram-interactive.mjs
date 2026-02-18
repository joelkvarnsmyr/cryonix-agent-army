#!/usr/bin/env node
/**
 * Cryonix Interactive Telegram Bot (@cryptonixis_bot)
 * 
 * Commands: /status /positions /trades /pnl /signals /risk /evolve /journal /help
 * Auto-reports: morning brief, trade alerts, health alerts, daily summary
 * 
 * Run: node scripts/telegram-interactive.mjs
 * Docker: runs as "telegram-bot" service
 */

import pg from 'pg';
import Redis from 'ioredis';
import 'dotenv/config';
import { getToml } from '../lib/load-toml.mjs';

const { Client } = pg;

// ─── Config ──────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_INTERACTIVE_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_URL = process.env.POSTGRES_URL ||
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:5432/cryonix`;
const REDIS_URL = process.env.KV_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:6379`;
const WEB_URL = process.env.NEXTJS_API_URL || 'http://localhost:3000';

const POLL_INTERVAL = getToml('timing', 'telegram_poll_ms', 1000);
const HEALTH_INTERVAL = getToml('timing', 'health_check_interval_ms', 300000);
const TRADE_POLL = getToml('timing', 'trade_alert_poll_ms', 15000);

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
    const rd = await connectRedis();
    const data = await rd.get('positions:open');
    const positions = data ? JSON.parse(data) : [];
    const maxPos = getToml('limits', 'max_open_positions', 3);

    if (!Array.isArray(positions) || positions.length === 0) return '📭 No open positions';

    const lines = positions.map(p => {
      const entry = parseFloat(p.entryPrice || 0);
      const current = parseFloat(p.currentPrice || p.entryPrice || 0);
      const pnlPct = p.pnlPct || 0;
      const priceFmt = entry < 1 ? 6 : entry < 100 ? 4 : 2;
      const icon = pnlPct > 0.5 ? '🟢' : pnlPct < -0.5 ? '🔴' : '⚪';
      const sl = p.stopLoss ? `$${parseFloat(p.stopLoss).toFixed(priceFmt)}` : '-';
      const tp = p.takeProfit ? `$${parseFloat(p.takeProfit).toFixed(priceFmt)}` : '-';
      return `${icon} <b>${p.symbol}</b>\n` +
        `   Entry: $${entry.toFixed(priceFmt)} → Now: $${current.toFixed(priceFmt)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n` +
        `   Qty: ${parseFloat(p.quantity).toFixed(4)} · SL: ${sl} · TP: ${tp}`;
    });

    return `📊 <b>Open Positions (${positions.length}/${maxPos})</b>\n\n${lines.join('\n\n')}`;
  } catch (e) {
    return `❌ Could not fetch positions: ${e.message}`;
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
    const rd = await connectRedis();

    // Positions from Redis (source of truth)
    const posRaw = await rd.get('positions:open');
    const positions = posRaw ? JSON.parse(posRaw) : [];
    const openCount = Array.isArray(positions) ? positions.length : 0;
    const unrealized = positions.reduce((sum, p) => {
      const entry = parseFloat(p.entryPrice || 0);
      const current = parseFloat(p.currentPrice || entry);
      const qty = parseFloat(p.quantity || 0);
      return sum + (current - entry) * qty;
    }, 0);

    // Daily realized from Postgres
    const dailyLoss = await query(`
      SELECT SUM(pnl) as daily_pnl
      FROM trades
      WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '24 hours'
    `);
    const dailyPnl = parseFloat(dailyLoss.rows[0]?.daily_pnl || 0);

    // Capital
    const riskRaw = await rd.get('risk:portfolio_state');
    const riskState = riskRaw ? JSON.parse(riskRaw) : null;
    const capital = parseFloat(riskState?.total_capital || 0);

    const maxDailyLossPct = getToml('risk', 'max_daily_loss_pct', 0.05);
    const maxOpenPos = getToml('limits', 'max_open_positions', 3);
    const dailyLimit = capital > 0 ? (capital * maxDailyLossPct).toFixed(2) : '?';
    const riskLevel = dailyPnl < -10 ? '🔴 HIGH' : dailyPnl < -5 ? '🟡 MODERATE' : '🟢 LOW';

    return `⚠️ <b>Risk Dashboard</b>\n\n` +
      `Risk Level: <b>${riskLevel}</b>\n` +
      `Open Positions: ${openCount}/${maxOpenPos}\n` +
      `Unrealized P&L: $${unrealized.toFixed(2)}\n` +
      `Daily Realized: $${dailyPnl.toFixed(2)}\n\n` +
      `💰 Capital: $${capital.toFixed(2)}\n` +
      `Max Daily Loss: ${(maxDailyLossPct * 100).toFixed(0)}% (-$${dailyLimit})`;
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
    `/cost — AI API costs\n` +
    `/journal — Trade journal &amp; config analysis\n` +
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

    // 4. Open positions (from Redis — source of truth for active positions)
    let openPosCount = 0;
    let pendingQueue = 0, approvedQueue = 0;
    try {
      const rd = await connectRedis();
      const posRaw = await rd.get('positions:open');
      const positions = posRaw ? JSON.parse(posRaw) : [];
      openPosCount = Array.isArray(positions) ? positions.length : 0;
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
    if (totalTrades === 0 && buySignals > 50) issues.push('⚠️ No trades executed despite signals');
    if (pendingQueue === 0 && approvedQueue === 0 && buySignals > 50 && totalTrades === 0)
      issues.push('⚠️ Pipeline stalled: signals not reaching queue');
    if (openPosCount === 0 && totalTrades === 0) issues.push('⚠️ No open positions and no trades');

    const patternLines = patterns.rows.map(p =>
      `  ${p.pattern}: ${p.cnt}`
    ).join('\n');

    const issueBlock = issues.length > 0
      ? `\n<b>⚠️ Issues Detected:</b>\n${issues.join('\n')}`
      : '\n✅ No issues detected';

    const maxPos = getToml('limits', 'max_open_positions', 3);
    const maxTradesPerDay = getToml('limits', 'max_trades_per_day', 15);

    return `━━━ 🔍 <b>SYSTEM AUDIT</b> ━━━━━━━━━\n` +
      `${new Date().toISOString().split('T')[0]} 14:00 UTC\n\n` +
      `🏥 ${healthStr}\n\n` +
      `📡 <b>Signals 24h</b>\n` +
      `  BUY: ${buySignals} (${buyPct}%) · SELL: ${sellSignals} · Total: ${totalSignals}\n\n` +
      `🧩 <b>Top Patterns</b>\n${patternLines}\n\n` +
      `📊 <b>Execution</b>\n` +
      `  Trades: ${totalTrades}/${maxTradesPerDay} · P&L: $${parseFloat(ex.total_pnl || 0).toFixed(2)}\n` +
      `  Positions: ${openPosCount}/${maxPos}\n` +
      `  Queue: ${pendingQueue} pending · ${approvedQueue} approved\n\n` +
      `🔔 <b>Last BUY:</b> ${lastBuyStr}` +
      issueBlock;
  } catch (e) {
    return `━━━ 🔍 <b>SYSTEM AUDIT</b> ━━━━━━━━━\n\nError: ${e.message}`;
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
      const d24 = r.change_24h != null ? ` · 24h: ${r.change_24h > 0 ? '+' : ''}${r.change_24h}%` : '';
      return `${arrow} <code>${sym.padEnd(6)}</code> ${r.change_1h > 0 ? '+' : ''}${r.change_1h}% (4h: ${r.change_4h > 0 ? '+' : ''}${r.change_4h}%${d24})`;
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

    // Dynamic config
    const maxOpenPos = getToml('limits', 'max_open_positions', 3);
    const maxDailyLossPct = getToml('risk', 'max_daily_loss_pct', 0.05);

    // Portfolio summary
    let portfolioBlock = '';
    if (riskState) {
      const capital = parseFloat(riskState.total_capital || 0);
      const dailyPnl = parseFloat(riskState.daily_pnl || 0);
      const drawdownPct = capital > 0 ? ((dailyPnl / capital) * 100).toFixed(2) : '0';
      const posValue = positions.reduce((sum, p) => sum + (p.entryPrice || 0) * (p.quantity || 0), 0);
      const cashPct = capital > 0 ? (((capital - posValue) / capital) * 100).toFixed(0) : '?';
      portfolioBlock = `\n💰 $${capital.toFixed(2)} · Cash: ${cashPct}% · P&L: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)} (${drawdownPct}%)`;
    }

    // Position P&L summary
    let posBlock = '';
    if (positions.length > 0) {
      const posLines = positions.map(p => {
        const sym = p.symbol.split('/')[0];
        const pnlPct = p.pnlPct || 0;
        const icon = pnlPct > 0.5 ? '🟢' : pnlPct < -0.5 ? '🔴' : '⚪';
        return `${icon}${sym} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
      });
      posBlock = `\n📌 ${posLines.join(' · ')} (${positions.length}/${maxOpenPos})`;
    }

    // Market regime
    const regime = await rd.get('market:regime') || 'unknown';
    const regimeIcon = { trending: '📈', volatile: '⚡', ranging: '📊' }[regime] || '❓';

    // Signal funnel line
    const funnelBlock = `\n📊 Funnel 24h: ${signals24h} → ${trades24h} trades (${conversionPct}%)`;

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

    const time = new Date().toUTCString().slice(17, 22);
    return `━━━ <b>CRYONIX</b> ━━━━━━━━━━━━━━\n` +
      `${time} UTC · ${regimeIcon} ${regime.charAt(0).toUpperCase() + regime.slice(1)}\n\n` +
      `📡 Signals 15m: ${buys15m} BUY · Queue: ${pending}` +
      portfolioBlock + posBlock + funnelBlock +
      `\nTrades 1h: ${trades1h} ($${pnl1h.toFixed(2)})` +
      topMover + alertBlock;
  } catch (e) {
    return null; // Silently fail — don't spam errors
  }
}

// ─── /cost — AI API cost tracker ─────────────────────────
const MODEL_PRICING = {
  // Per 1M tokens: [input, output]
  'grok-4-1-fast-reasoning': [0.20, 0.50],
  'grok-4-1-fast-non-reasoning': [0.20, 0.50],
  'grok-4-fast-reasoning': [1.00, 4.00],
  'grok-4-fast-non-reasoning': [1.00, 4.00],
  'grok-4-0709': [3.00, 15.00],
  'grok-3': [3.00, 15.00],
  'grok-3-mini': [0.03, 0.10],
};

async function cmdCost() {
  try {
    // Per-model usage: today, 7d, all-time
    const res = await query(`
      SELECT
        usage->>'model' as model,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as calls_24h,
        SUM((usage->>'prompt_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as prompt_24h,
        SUM((usage->>'completion_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as comp_24h,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as calls_7d,
        SUM((usage->>'prompt_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as prompt_7d,
        SUM((usage->>'completion_tokens')::int) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as comp_7d,
        COUNT(*) as calls_all,
        SUM((usage->>'prompt_tokens')::int) as prompt_all,
        SUM((usage->>'completion_tokens')::int) as comp_all,
        MIN(timestamp) as first_call
      FROM validation_history
      WHERE usage IS NOT NULL AND usage->>'model' IS NOT NULL
      GROUP BY usage->>'model'
      ORDER BY calls_all DESC
    `);

    if (!res.rows.length) return '💰 <b>AI Cost Tracker</b>\n\nNo API calls recorded yet.';

    function calcCost(model, promptTok, compTok) {
      const pricing = MODEL_PRICING[model] || MODEL_PRICING['grok-3-mini'];
      const inCost = (parseInt(promptTok) || 0) / 1_000_000 * pricing[0];
      const outCost = (parseInt(compTok) || 0) / 1_000_000 * pricing[1];
      return inCost + outCost;
    }

    let totalCost24h = 0, totalCost7d = 0, totalCostAll = 0;
    let totalCalls24h = 0, totalCalls7d = 0, totalCallsAll = 0;

    const modelLines = res.rows.map(r => {
      const cost24h = calcCost(r.model, r.prompt_24h, r.comp_24h);
      const cost7d = calcCost(r.model, r.prompt_7d, r.comp_7d);
      const costAll = calcCost(r.model, r.prompt_all, r.comp_all);
      totalCost24h += cost24h;
      totalCost7d += cost7d;
      totalCostAll += costAll;
      totalCalls24h += parseInt(r.calls_24h) || 0;
      totalCalls7d += parseInt(r.calls_7d) || 0;
      totalCallsAll += parseInt(r.calls_all) || 0;

      const pricing = MODEL_PRICING[r.model];
      const priceLabel = pricing ? `$${pricing[0]}/$${pricing[1]}` : '?';
      return `<b>${r.model}</b> (${priceLabel}/1M)\n` +
        `  24h: ${r.calls_24h || 0} calls · $${cost24h.toFixed(4)}\n` +
        `  7d:  ${r.calls_7d || 0} calls · $${cost7d.toFixed(4)}\n` +
        `  All: ${r.calls_all} calls · $${costAll.toFixed(4)}`;
    });

    // Estimate monthly cost based on 7d average
    const daysTracked = Math.max(1, (Date.now() - new Date(res.rows[0].first_call).getTime()) / (1000 * 60 * 60 * 24));
    const dailyAvg = totalCostAll / daysTracked;
    const monthlyEst = dailyAvg * 30;

    return `💰 <b>AI Cost Tracker</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      modelLines.join('\n\n') + '\n\n' +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>Totals:</b>\n` +
      `  24h: ${totalCalls24h} calls · <b>$${totalCost24h.toFixed(4)}</b>\n` +
      `  7d:  ${totalCalls7d} calls · <b>$${totalCost7d.toFixed(4)}</b>\n` +
      `  All: ${totalCallsAll} calls · <b>$${totalCostAll.toFixed(4)}</b>\n\n` +
      `📊 Daily avg: $${dailyAvg.toFixed(4)} · Est. monthly: <b>$${monthlyEst.toFixed(2)}</b>`;
  } catch (e) {
    return `❌ Cost query failed: ${e.message}`;
  }
}

async function cmdJournal() {
  try {
    // Try position_history first (richer data)
    const r = await query(`
      SELECT symbol, pattern, pnl, close_reason,
             EXTRACT(EPOCH FROM (closed_at - opened_at))/3600 as holding_h,
             closed_at, metadata->>'configVersion' as config_version
      FROM position_history
      WHERE closed_at > NOW() - INTERVAL '7 days'
      ORDER BY closed_at DESC
      LIMIT 15
    `);

    if (r.rows.length === 0) {
      // Fallback to trades table
      const tr = await query(`
        SELECT symbol, pattern, pnl, status, reasoning, timestamp, config_version
        FROM trades WHERE timestamp > NOW() - INTERVAL '7 days' AND status = 'CLOSED'
        ORDER BY timestamp DESC LIMIT 15
      `);
      if (tr.rows.length === 0) return '📭 No trades in the last 7 days';
      const wins = tr.rows.filter(t => parseFloat(t.pnl || 0) > 0);
      const totalPnl = tr.rows.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
      const lines = tr.rows.map(t => {
        const pnl = parseFloat(t.pnl || 0);
        const icon = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
        return `${icon} <b>${t.symbol}</b> ${t.pattern || '-'}\n   P&amp;L: $${pnl.toFixed(2)} | ${t.config_version || '-'}`;
      });
      return `📊 <b>Trade Journal (7d)</b>\n${tr.rows.length} trades | WR ${(wins.length/tr.rows.length*100).toFixed(0)}% | P&amp;L: $${totalPnl.toFixed(2)}\n\n${lines.join('\n\n')}`;
    }

    const wins = r.rows.filter(t => parseFloat(t.pnl || 0) > 0);
    const totalPnl = r.rows.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);

    // Config version breakdown
    const byConfig = {};
    r.rows.forEach(t => {
      const v = t.config_version || 'pre-tracking';
      if (!byConfig[v]) byConfig[v] = { trades: 0, pnl: 0 };
      byConfig[v].trades++;
      byConfig[v].pnl += parseFloat(t.pnl || 0);
    });
    const configLines = Object.entries(byConfig)
      .map(([v, d]) => `  ${v}: ${d.trades} trades, $${d.pnl.toFixed(2)}`)
      .join('\n');

    const lines = r.rows.slice(0, 10).map(t => {
      const pnl = parseFloat(t.pnl || 0);
      const icon = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
      const h = parseFloat(t.holding_h || 0).toFixed(1);
      return `${icon} <b>${t.symbol}</b> ${t.pattern || '-'}\n   P&amp;L: $${pnl.toFixed(2)} | ${t.close_reason || '-'} | ${h}h | ${t.config_version || '-'}`;
    });

    return `📊 <b>Trade Journal (7d)</b>\n${r.rows.length} trades | WR ${(wins.length/r.rows.length*100).toFixed(0)}% | P&amp;L: $${totalPnl.toFixed(2)}\n\n<b>Config Versions:</b>\n${configLines}\n\n${lines.join('\n\n')}`;
  } catch (e) {
    return `❌ Could not fetch journal: ${e.message}`;
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
  '/cost': cmdCost,
  '/journal': cmdJournal,
  '/help': cmdHelp,
  '/start': cmdHelp,
};

async function handleCommand(text, chatId) {
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  if (!cmd.startsWith('/')) return;
  const handler = COMMANDS[cmd];
  if (!handler) {
    await sendMessage(`Unknown command: <code>${cmd}</code>\nType /help for available commands.`, chatId);
    return;
  }

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
      SELECT id, symbol, side, entry_price, exit_price, pnl, pattern,
             confidence, stop_loss, take_profit, status, timestamp
      FROM trades ORDER BY id DESC LIMIT 1
    `);
    if (r.rows.length === 0) return;

    const latest = r.rows[0];
    if (lastTradeId === null) { lastTradeId = latest.id; return; }
    if (latest.id <= lastTradeId) return;

    lastTradeId = latest.id;
    const icon = latest.side === 'BUY' ? '🟩' : '🟥';
    const price = parseFloat(latest.entry_price);
    const priceFmt = price < 1 ? 6 : price < 100 ? 4 : 2;
    const conf = latest.confidence ? `${(parseFloat(latest.confidence) * 100).toFixed(0)}%` : '?';
    const time = new Date(latest.timestamp).toUTCString().slice(17, 22);

    let slTpStr = '';
    if (latest.stop_loss || latest.take_profit) {
      const sl = latest.stop_loss ? `SL: $${parseFloat(latest.stop_loss).toFixed(priceFmt)}` : '';
      const tp = latest.take_profit ? `TP: $${parseFloat(latest.take_profit).toFixed(priceFmt)}` : '';
      slTpStr = `\n📐 ${[sl, tp].filter(Boolean).join(' · ')}`;
    }

    const pnlStr = latest.pnl ? `\n💵 P&L: $${parseFloat(latest.pnl).toFixed(2)}` : '';

    await sendMessage(
      `━━━ ${icon} <b>TRADE</b> ━━━━━━━━━━━━━━\n` +
      `${latest.side} <b>${latest.symbol}</b> @ $${price.toFixed(priceFmt)}\n` +
      `📊 ${latest.pattern || '?'} · ${conf} confidence` +
      slTpStr + pnlStr +
      `\n⏱ ${time} UTC · ${latest.status}`
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
        .map(s => `🔴 ${s.name}: ${s.status} (${s.latency || '?'}ms)`).join('\n') || '';
      await sendMessage(
        `━━━ 🚨 <b>ALERT</b> ━━━━━━━━━━━━━━\n` +
        `Status: <b>${status.toUpperCase()}</b>\n\n${down}`
      );
    } else if (status === 'healthy' && lastHealthStatus !== 'healthy' && lastHealthStatus !== null) {
      await sendMessage(
        `━━━ ✅ <b>RECOVERED</b> ━━━━━━━━━━━━\n` +
        `All systems healthy · Latency: ${h.totalLatency || '?'}ms`
      );
    }
    lastHealthStatus = status;
  } catch { /* silent */ }
}

async function sendMorningBrief() {
  try {
    const rd = await connectRedis();
    const maxPos = getToml('limits', 'max_open_positions', 3);
    const maxDailyLossPct = getToml('risk', 'max_daily_loss_pct', 0.05);

    // Health
    let healthLine = '';
    try {
      const hRes = await fetch(`${WEB_URL}/api/health`);
      const h = await hRes.json();
      const icons = h.services?.map(s => s.status === 'healthy' ? '🟢' : '🔴').join('') || '';
      healthLine = `${icons} ${h.status || '?'} · ${h.totalLatency || '?'}ms`;
    } catch { healthLine = '❓ Could not reach API'; }

    // Portfolio
    const riskRaw = await rd.get('risk:portfolio_state');
    const riskState = riskRaw ? JSON.parse(riskRaw) : null;
    const capital = parseFloat(riskState?.total_capital || 0);
    const dailyLimit = (capital * maxDailyLossPct).toFixed(2);

    // Yesterday's P&L
    const yesterday = await query(`
      SELECT COUNT(*) as trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(pnl) as total_pnl
      FROM trades WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '24 hours'
    `);
    const d = yesterday.rows[0];
    const yTrades = parseInt(d.trades || 0);
    const yPnl = parseFloat(d.total_pnl || 0);
    const yWinRate = yTrades > 0 ? ((parseInt(d.wins || 0) / yTrades) * 100).toFixed(0) : '-';
    const yIcon = yPnl >= 0 ? '📈' : '📉';

    // Open positions
    const posRaw = await rd.get('positions:open');
    const positions = posRaw ? JSON.parse(posRaw) : [];
    let posBlock = `📌 <b>Positions ${positions.length}/${maxPos}</b>`;
    if (positions.length > 0) {
      const lines = positions.map(p => {
        const sym = p.symbol.split('/')[0];
        const pnlPct = p.pnlPct || 0;
        const icon = pnlPct > 0.5 ? '🟢' : pnlPct < -0.5 ? '🔴' : '⚪';
        return `  ${icon} ${sym} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
      });
      posBlock += '\n' + lines.join('\n');
    } else {
      posBlock += ' — no open positions';
    }

    // Regime
    const regime = await rd.get('market:regime') || 'unknown';
    const regimeIcon = { trending: '📈', volatile: '⚡', ranging: '📊' }[regime] || '❓';

    const date = new Date().toISOString().split('T')[0];
    await sendMessage(
      `━━━ ☀️ <b>MORNING BRIEF</b> ━━━━━━━━\n` +
      `${date} · ${regimeIcon} ${regime.charAt(0).toUpperCase() + regime.slice(1)}\n\n` +
      `🏥 ${healthLine}\n` +
      `💰 Capital: <b>$${capital.toFixed(2)}</b> · Loss limit: -$${dailyLimit}\n\n` +
      `${yIcon} <b>Last 24h</b>\n` +
      `  P&L: $${yPnl.toFixed(2)} · ${yTrades} trades · ${yWinRate}% WR\n\n` +
      posBlock
    );
  } catch (e) {
    await sendMessage(`━━━ ☀️ <b>MORNING BRIEF</b> ━━━━━━━━\n\nError: ${e.message}`);
  }
}

async function sendDailySummary() {
  try {
    const rd = await connectRedis();
    const maxPos = getToml('limits', 'max_open_positions', 3);
    const maxDailyLossPct = getToml('risk', 'max_daily_loss_pct', 0.05);
    const maxTradesPerDay = getToml('limits', 'max_trades_per_day', 15);

    // P&L (24h + 7d)
    const daily = await query(`
      SELECT COUNT(*) as trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(pnl) as total_pnl, AVG(pnl) as avg_pnl,
        MAX(pnl) as best, MIN(pnl) as worst
      FROM trades WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '24 hours'
    `);
    const weekly = await query(`
      SELECT COUNT(*) as trades, SUM(pnl) as total_pnl
      FROM trades WHERE status = 'CLOSED' AND timestamp > NOW() - INTERVAL '7 days'
    `);
    const d = daily.rows[0];
    const w = weekly.rows[0];
    const dTrades = parseInt(d.trades || 0);
    const dPnl = parseFloat(d.total_pnl || 0);
    const dWR = dTrades > 0 ? ((parseInt(d.wins || 0) / dTrades) * 100).toFixed(0) : '-';
    const wPnl = parseFloat(w.total_pnl || 0);
    const wTrades = parseInt(w.trades || 0);
    const pnlIcon = dPnl >= 0 ? '📈' : '📉';

    // Capital
    const riskRaw = await rd.get('risk:portfolio_state');
    const riskState = riskRaw ? JSON.parse(riskRaw) : null;
    const capital = parseFloat(riskState?.total_capital || 0);
    const dailyLimit = (capital * maxDailyLossPct).toFixed(2);

    // Open positions
    const posRaw = await rd.get('positions:open');
    const positions = posRaw ? JSON.parse(posRaw) : [];

    // Risk level
    const riskLevel = dPnl < -10 ? '🔴 HIGH' : dPnl < -5 ? '🟡 MODERATE' : '🟢 LOW';

    // Recent trades (last 5 today)
    const recent = await query(`
      SELECT symbol, side, pnl, pattern, status
      FROM trades WHERE timestamp > NOW() - INTERVAL '24 hours'
      ORDER BY timestamp DESC LIMIT 5
    `);
    let tradesBlock = '';
    if (recent.rows.length > 0) {
      const lines = recent.rows.map(t => {
        const pnl = parseFloat(t.pnl || 0);
        const sym = t.symbol.split('/')[0];
        const pnlStr = t.status === 'CLOSED' ? `$${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` : t.status;
        const icon = t.side === 'BUY' ? '🟩' : '🟥';
        return `  ${icon} ${sym} · ${t.pattern || '?'} · ${pnlStr}`;
      });
      tradesBlock = `\n\n📋 <b>Trades today</b>\n${lines.join('\n')}`;
    }

    // Regime
    const regime = await rd.get('market:regime') || 'unknown';
    const regimeIcon = { trending: '📈', volatile: '⚡', ranging: '📊' }[regime] || '❓';

    const date = new Date().toISOString().split('T')[0];
    await sendMessage(
      `━━━ 🌙 <b>DAILY SUMMARY</b> ━━━━━━━━\n` +
      `${date} · ${regimeIcon} ${regime.charAt(0).toUpperCase() + regime.slice(1)}\n\n` +
      `${pnlIcon} <b>Performance</b>\n` +
      `  24h: <b>$${dPnl >= 0 ? '+' : ''}${dPnl.toFixed(2)}</b> · ${dTrades}/${maxTradesPerDay} trades · ${dWR}% WR\n` +
      `  Best: $${parseFloat(d.best || 0).toFixed(2)} · Worst: $${parseFloat(d.worst || 0).toFixed(2)}\n` +
      `  7d: $${wPnl >= 0 ? '+' : ''}${wPnl.toFixed(2)} · ${wTrades} trades\n\n` +
      `💰 <b>Capital</b>: $${capital.toFixed(2)}\n` +
      `  Positions: ${positions.length}/${maxPos} · Risk: ${riskLevel}\n` +
      `  Daily loss limit: -$${dailyLimit}` +
      tradesBlock
    );
  } catch (e) {
    await sendMessage(`━━━ 🌙 <b>DAILY SUMMARY</b> ━━━━━━━━\n\nError: ${e.message}`);
  }
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

  // Pipeline health report
  const PIPELINE_INTERVAL = getToml('timing', 'pipeline_report_interval_ms', 900000);
  setInterval(async () => {
    try {
      const report = await pipelineHealthReport();
      if (report) await sendMessage(report);
    } catch {}
  }, PIPELINE_INTERVAL);

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
