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
import { formatBuySignal, formatCloseSignal } from '../lib/signal-formatter.mjs';

let renderBuyCard, renderCloseCard;
try {
  const renderer = await import('../lib/signal-card-renderer.mjs');
  renderBuyCard = renderer.renderBuyCard;
  renderCloseCard = renderer.renderCloseCard;
  console.log('✅ Signal card renderer loaded (image mode)');
} catch (e) {
  console.log('⚠️ Signal card renderer not available, using text mode:', e.message);
}

const { Client } = pg;

// ─── Config ──────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_INTERACTIVE_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SIGNAL_CHANNEL_ID = process.env.TELEGRAM_SIGNAL_CHANNEL_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_SIGNAL_WEBHOOK_URL;
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

async function sendPhoto(pngBuffer, caption, chatId = CHAT_ID) {
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'signal.png');
    if (caption) {
      form.append('caption', caption.substring(0, 1024));
      form.append('parse_mode', 'HTML');
    }
    const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
    return res.json();
  } catch (e) {
    console.error('Telegram sendPhoto error:', e.message);
    return null;
  }
}

/**
 * Send signal to public channel: image card with text fallback
 */
async function sendSignalToChannel(trade, type) {
  if (!SIGNAL_CHANNEL_ID) return;
  try {
    const renderer = type === 'buy' ? renderBuyCard : renderCloseCard;
    const formatter = type === 'buy' ? formatBuySignal : formatCloseSignal;
    const caption = formatter(trade);

    if (renderer) {
      const png = await renderer(trade);
      await sendPhoto(png, caption, SIGNAL_CHANNEL_ID);
    } else {
      await sendMessage(caption, SIGNAL_CHANNEL_ID);
    }
  } catch (e) {
    // Fallback to text if image fails
    console.error('Signal card render failed, using text:', e.message);
    const formatter = type === 'buy' ? formatBuySignal : formatCloseSignal;
    try { await sendMessage(formatter(trade), SIGNAL_CHANNEL_ID); } catch {}
  }
}

// ─── Discord helpers ──────────────────────────────────────
const DISCORD_COLORS = { green: 0x22c55e, red: 0xef4444, cyan: 0x00d4ff, muted: 0x64748b };

function fmtPriceDiscord(price) {
  const p = parseFloat(price || 0);
  if (p < 0.01) return p.toFixed(8);
  if (p < 1) return p.toFixed(6);
  if (p < 100) return p.toFixed(4);
  return p.toFixed(2);
}

function fmtPatternsDiscord(patternStr) {
  const labels = {
    dip_buy: 'Dip Buy', deep_value_crash: 'Deep Value Crash', bollinger_squeeze: 'Bollinger Squeeze',
    rsi_oversold: 'RSI Oversold', rsi_overbought: 'RSI Overbought', volume_spike_up: 'Volume Spike',
    macd_bullish_cross: 'MACD Bullish Cross', ema_bullish_cross: 'EMA Bullish Cross', momentum_gainer: 'Momentum Gainer',
  };
  if (!patternStr) return 'Mixed';
  return patternStr.split(',').map(p => labels[p.trim()] || p.trim()).join(' + ');
}

function buildBuyEmbed(trade) {
  const pair = trade.symbol || '?';
  const entry = fmtPriceDiscord(trade.entry_price || trade.entryPrice);
  const rawConf = parseFloat(trade.confidence || 0);
  const conf = Math.round(rawConf <= 1 ? rawConf * 100 : rawConf);
  const patterns = fmtPatternsDiscord(trade.pattern);
  const meta = typeof trade.metadata === 'object' ? trade.metadata : {};
  const slRaw = trade.stop_loss || trade.stopLoss || meta.stopLoss || null;
  const tpRaw = trade.take_profit || trade.takeProfit || meta.takeProfit || null;
  const sl = slRaw ? fmtPriceDiscord(slRaw) : null;
  const tp = tpRaw ? fmtPriceDiscord(tpRaw) : null;

  const fields = [
    { name: 'Entry', value: `\`$${entry}\``, inline: true },
  ];
  if (sl) fields.push({ name: 'Stop Loss', value: `\`$${sl}\``, inline: true });
  if (tp) fields.push({ name: 'Take Profit', value: `\`$${tp}\``, inline: true });
  if (sl && tp) {
    const risk = Math.abs(parseFloat(entry) - parseFloat(sl));
    const reward = Math.abs(parseFloat(tp) - parseFloat(entry));
    if (risk > 0) fields.push({ name: 'R:R', value: `1:${(reward / risk).toFixed(1)}`, inline: true });
  }
  fields.push({ name: 'Pattern', value: patterns, inline: true });
  fields.push({ name: 'Confidence', value: `**${conf}%**`, inline: true });

  return {
    color: DISCORD_COLORS.green,
    author: { name: 'CRYONIX' },
    title: `BUY SIGNAL — ${pair}`,
    fields,
    image: { url: 'attachment://signal.png' },
    footer: { text: 'Powered by Cryonix' },
    timestamp: new Date().toISOString(),
  };
}

function buildCloseEmbed(position) {
  const pair = position.symbol || '?';
  const entry = fmtPriceDiscord(position.entry_price || position.entryPrice);
  const exit = fmtPriceDiscord(position.exit_price || position.exitPrice);
  const pnl = parseFloat(position.pnl || 0);
  const entryNum = parseFloat(position.entry_price || position.entryPrice || 0);
  const exitNum = parseFloat(position.exit_price || position.exitPrice || 0);
  const pnlPct = entryNum > 0 ? ((exitNum - entryNum) / entryNum * 100).toFixed(2) : '0';
  const holdH = parseFloat(position.holding_hours || 0);
  const holdStr = holdH < 1 ? `${Math.round(holdH * 60)}min` : `${holdH.toFixed(1)}h`;
  const patterns = fmtPatternsDiscord(position.pattern);

  const isWin = pnl > 0;
  const isLoss = pnl < 0;
  const resultLabel = isWin ? 'WIN' : isLoss ? 'LOSS' : 'BREAKEVEN';
  const color = isWin ? DISCORD_COLORS.green : isLoss ? DISCORD_COLORS.red : DISCORD_COLORS.muted;

  const reasonMap = {
    'STOP_LOSS': 'Stop Loss', 'TAKE_PROFIT': 'Take Profit', 'TRAILING_STOP': 'Trailing Stop',
    'STAGNATION': 'Stagnation', 'NATIVE_SL': 'Stop Loss', 'MANUAL': 'Manual', 'DUST': 'Dust',
  };
  const reason = reasonMap[position.close_reason || position.closeReason] || position.close_reason || position.closeReason || '?';

  return {
    color,
    author: { name: 'CRYONIX' },
    title: `CLOSED — ${resultLabel} — ${pair}`,
    description: `**${pnlPct >= 0 ? '+' : ''}${pnlPct}%**`,
    fields: [
      { name: 'Entry', value: `\`$${entry}\``, inline: true },
      { name: 'Exit', value: `\`$${exit}\``, inline: true },
      { name: 'Duration', value: holdStr, inline: true },
      { name: 'Close Reason', value: reason, inline: true },
      { name: 'Pattern', value: patterns, inline: true },
    ],
    image: { url: 'attachment://signal.png' },
    footer: { text: 'Powered by Cryonix' },
    timestamp: new Date().toISOString(),
  };
}

async function sendDiscordSignal(trade, type) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const embed = type === 'buy' ? buildBuyEmbed(trade) : buildCloseEmbed(trade);
    const renderer = type === 'buy' ? renderBuyCard : renderCloseCard;

    // Try to attach image card
    if (renderer) {
      try {
        const png = await renderer(trade);
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ embeds: [embed] }));
        form.append('files[0]', new Blob([png], { type: 'image/png' }), 'signal.png');
        const res = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
        if (!res.ok) console.error('Discord webhook error:', res.status, await res.text());
        return;
      } catch (e) {
        console.error('Discord image failed, sending embed only:', e.message);
      }
    }

    // Fallback: embed without image
    delete embed.image;
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) console.error('Discord webhook error:', res.status, await res.text());
  } catch (e) {
    console.error('Discord signal error:', e.message);
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
    `/gainers — Top movers &amp; volume surges\n` +
    `/audit — Full system audit\n` +
    `/evolve — Evolution history\n` +
    `/cost — AI API costs\n` +
    `/journal — Trade journal &amp; config analysis\n` +
    `/help — This menu\n\n` +
    `<b>Auto Alerts:</b>\n` +
    `🟩 Trade executed — varför + AI-resonemang\n` +
    `🟢🔴 Trade stängd — P&amp;L + hålltid + reason\n` +
    `☀️ 08:00 UTC — Morning brief\n` +
    `🌙 22:00 UTC — Daily summary\n` +
    `🚨 Health — bara vid statusändring`;
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

    return `🔍 Audit: ${buySignals} signaler, ${totalTrades} trades, ${openPosCount} positioner\n` +
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
    return `🔍 Audit: fel — ${e.message}`;
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
    return `📡 Pipeline ${time}: ${buys15m} signaler, ${pending} i kö\n` +
      `${regimeIcon} ${regime.charAt(0).toUpperCase() + regime.slice(1)}` +
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

    return `💰 AI-kostnad: $${totalCost24h.toFixed(4)} idag, ~$${monthlyEst.toFixed(2)}/mån\n\n` +
      modelLines.join('\n\n') + '\n\n' +
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

  // Auth check: only allow commands from the configured admin chat
  if (CHAT_ID && String(chatId) !== String(CHAT_ID)) {
    console.log(`Unauthorized command ${cmd} from chat ${chatId} (expected ${CHAT_ID})`);
    return;
  }

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

// ─── Trade Alerts (rich, event-driven) ───────────────────
let lastTradeId = null;
let lastClosedId = null;
let lastHealthStatus = 'healthy';

async function checkTradeAlerts() {
  try {
    // Check for NEW trades (BUY executed)
    const r = await query(`
      SELECT t.id, t.symbol, t.side, t.entry_price, t.exit_price, t.pnl, t.pattern,
             t.confidence, t.status, t.timestamp, t.reasoning,
             t.config_version,
             v.reasoning as ai_reasoning, v.adjusted_confidence, v.consensus_level,
             v.usage->>'model' as ai_model
      FROM trades t
      LEFT JOIN validation_history v ON v.symbol = t.symbol
        AND v.action = t.side AND v.timestamp > t.timestamp - INTERVAL '2 minutes'
        AND v.timestamp < t.timestamp + INTERVAL '2 minutes'
      ORDER BY t.id DESC LIMIT 1
    `);
    if (r.rows.length === 0) return;

    const latest = r.rows[0];
    if (lastTradeId === null) {
      lastTradeId = latest.id;
      console.log(`[TRADE-POLL] Initialized lastTradeId=${latest.id} (${latest.symbol})`);
      return;
    }
    if (latest.id <= lastTradeId) return;

    console.log(`[TRADE-POLL] New trade detected: #${latest.id} ${latest.symbol} ${latest.side} (prev: #${lastTradeId})`);
    lastTradeId = latest.id;
    const price = parseFloat(latest.entry_price);
    const priceFmt = price < 1 ? 6 : price < 100 ? 4 : 2;
    const conf = latest.confidence ? `${(parseFloat(latest.confidence) * 100).toFixed(0)}%` : '?';

    // Rich trade message with WHY
    const patterns = (latest.pattern || '?').split(',').map(p => p.trim());
    const patternIcons = {
      'DIP_BUY': '🎯 Dip Buy', 'DEEP_VALUE_CRASH': '💎 Deep Value',
      'BOLLINGER_SQUEEZE': '🔧 Bollinger', 'RSI_OVERSOLD': '📉 RSI Oversold',
      'MACD_BULLISH_CROSS': '📈 MACD Cross', 'EMA_BULLISH_CROSS': '📊 EMA Cross',
    };
    const patternStr = patterns.map(p => patternIcons[p] || p).join(' + ');

    // SL/TP with R:R — read from Redis open position
    let riskStr = '';
    try {
      const rd = await connectRedis();
      const posRaw = await rd.get('positions:open');
      if (posRaw) {
        const positions = JSON.parse(posRaw);
        const pos = positions.find(p => p.symbol === latest.symbol);
        if (pos && pos.stopLoss && pos.takeProfit) {
          const sl = parseFloat(pos.stopLoss);
          const tp = parseFloat(pos.takeProfit);
          const risk = Math.abs(price - sl);
          const reward = Math.abs(tp - price);
          const rr = risk > 0 ? (reward / risk).toFixed(1) : '?';
          const slPct = ((sl - price) / price * 100).toFixed(1);
          const tpPct = ((tp - price) / price * 100).toFixed(1);
          riskStr = `\n📐 SL: $${sl.toFixed(priceFmt)} (${slPct}%) · TP: $${tp.toFixed(priceFmt)} (+${tpPct}%) · R:R ${rr}`;
        }
      }
    } catch {}

    // AI reasoning (truncated)
    let aiStr = '';
    if (latest.ai_reasoning) {
      const reason = latest.ai_reasoning.length > 120
        ? latest.ai_reasoning.substring(0, 120) + '...'
        : latest.ai_reasoning;
      const consensus = latest.consensus_level || '?';
      aiStr = `\n🤖 AI (${consensus}): <i>${reason}</i>`;
    }

    // Capital context
    let capitalStr = '';
    try {
      const rd = await connectRedis();
      const riskRaw = await rd.get('risk:portfolio_state');
      if (riskRaw) {
        const rs = JSON.parse(riskRaw);
        const posRaw = await rd.get('positions:open');
        const positions = posRaw ? JSON.parse(posRaw) : [];
        const maxPos = getToml('limits', 'max_open_positions', 3);
        capitalStr = `\n💰 ${positions.length}/${maxPos} positioner · $${parseFloat(rs.total_capital || 0).toFixed(2)} kapital`;
      }
    } catch {}

    await sendMessage(
      `🟩 <b>KÖP ${latest.symbol}</b> @ $${price.toFixed(priceFmt)}\n\n` +
      `<b>Varför:</b> ${patternStr}\n` +
      `Confidence: <b>${conf}</b> (blended TA+AI)` +
      riskStr + aiStr + capitalStr +
      `\n\n⏱ ${new Date(latest.timestamp).toLocaleString('sv-SE', { timeZone: 'UTC' })}`
    );

    // Post to public channels (Telegram + Discord)
    console.log(`[SIGNAL] Posting BUY ${latest.symbol} to public channels...`);
    const results = await Promise.allSettled([
      sendSignalToChannel(latest, 'buy'),
      sendDiscordSignal(latest, 'buy'),
    ]);
    results.forEach((r, i) => {
      const ch = i === 0 ? 'Telegram' : 'Discord';
      if (r.status === 'fulfilled') console.log(`[SIGNAL] ✅ ${ch} BUY posted`);
      else console.error(`[SIGNAL] ❌ ${ch} BUY failed:`, r.reason?.message || r.reason);
    });

  } catch (err) {
    console.error('[TRADE-ALERT] Error:', err.message || err);
  }
}

async function checkClosedPositions() {
  try {
    const r = await query(`
      SELECT id, symbol, pattern, pnl, close_reason, entry_price, exit_price,
             EXTRACT(EPOCH FROM (closed_at - opened_at))/3600 as holding_hours,
             closed_at, metadata->>'configVersion' as config_version
      FROM position_history
      ORDER BY id DESC LIMIT 1
    `);
    if (r.rows.length === 0) return;

    const latest = r.rows[0];
    if (lastClosedId === null) {
      lastClosedId = latest.id;
      console.log(`[CLOSE-POLL] Initialized lastClosedId=${latest.id} (${latest.symbol})`);
      return;
    }
    if (latest.id <= lastClosedId) return;

    console.log(`[CLOSE-POLL] New close detected: #${latest.id} ${latest.symbol} ${latest.close_reason} (prev: #${lastClosedId})`);
    lastClosedId = latest.id;
    const pnl = parseFloat(latest.pnl || 0);
    const entry = parseFloat(latest.entry_price || 0);
    const exit = parseFloat(latest.exit_price || 0);
    const priceFmt = entry < 1 ? 6 : entry < 100 ? 4 : 2;
    const holdH = parseFloat(latest.holding_hours || 0);
    const pnlPct = entry > 0 ? ((exit - entry) / entry * 100).toFixed(2) : '?';
    const icon = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
    const resultText = pnl > 0 ? 'VINST' : pnl < 0 ? 'FÖRLUST' : 'BREAKEVEN';

    const reasonMap = {
      'STOP_LOSS': '📉 Stop Loss', 'TAKE_PROFIT': '🎯 Take Profit',
      'TRAILING_STOP': '📈 Trailing Stop', 'STAGNATION': '⏳ Stagnation timeout',
      'NATIVE_SL': '🛡️ Binance SL', 'MANUAL': '✋ Manuell', 'DUST': '🧹 Dust',
    };
    const closeReason = reasonMap[latest.close_reason] || latest.close_reason || '?';

    // Running P&L context
    let runningStr = '';
    try {
      const weekly = await query(`
        SELECT COUNT(*) as trades, SUM(pnl) as total_pnl,
               SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
        FROM position_history WHERE closed_at > NOW() - INTERVAL '7 days'
      `);
      const w = weekly.rows[0];
      const wTrades = parseInt(w.trades || 0);
      const wPnl = parseFloat(w.total_pnl || 0);
      const wWR = wTrades > 0 ? ((parseInt(w.wins || 0) / wTrades) * 100).toFixed(0) : '-';
      runningStr = `\n📊 Vecka: ${wTrades} trades · ${wWR}% WR · $${wPnl >= 0 ? '+' : ''}${wPnl.toFixed(2)}`;
    } catch {}

    await sendMessage(
      `${icon} <b>${resultText}: ${latest.symbol}</b>\n\n` +
      `Entry: $${entry.toFixed(priceFmt)} → Exit: $${exit.toFixed(priceFmt)} (${pnlPct}%)\n` +
      `<b>P&L: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</b>\n\n` +
      `Stängd: ${closeReason}\n` +
      `Hålltid: ${holdH < 1 ? `${(holdH * 60).toFixed(0)}min` : `${holdH.toFixed(1)}h`}\n` +
      `Mönster: ${latest.pattern || '?'}` +
      runningStr
    );

    // Post to public channels (Telegram + Discord)
    console.log(`[SIGNAL] Posting CLOSE ${latest.symbol} to public channels...`);
    const closeResults = await Promise.allSettled([
      sendSignalToChannel(latest, 'close'),
      sendDiscordSignal(latest, 'close'),
    ]);
    closeResults.forEach((r, i) => {
      const ch = i === 0 ? 'Telegram' : 'Discord';
      if (r.status === 'fulfilled') console.log(`[SIGNAL] ✅ ${ch} CLOSE posted`);
      else console.error(`[SIGNAL] ❌ ${ch} CLOSE failed:`, r.reason?.message || r.reason);
    });
  } catch (err) {
    console.error('[CLOSE-ALERT] Error:', err.message || err);
  }
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
        `🚨 System nere: ${status.toUpperCase()}\n\n${down}`
      );
    } else if (status === 'healthy' && lastHealthStatus !== 'healthy' && lastHealthStatus !== null) {
      await sendMessage(
        `✅ System återställt — alla tjänster uppe (${h.totalLatency || '?'}ms)`
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
      `☀️ Morgon ${date}: $${capital.toFixed(2)} · 24h P&L $${yPnl >= 0 ? '+' : ''}${yPnl.toFixed(2)}\n` +
      `${regimeIcon} ${regime.charAt(0).toUpperCase() + regime.slice(1)} · ${healthLine}\n\n` +
      `💰 Loss limit: -$${dailyLimit}\n` +
      `${yIcon} 24h: ${yTrades} trades · ${yWinRate}% WR\n\n` +
      posBlock
    );
  } catch (e) {
    await sendMessage(`☀️ Morgon: fel — ${e.message}`);
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
      `🌙 Dagssummering: P&L $${dPnl >= 0 ? '+' : ''}${dPnl.toFixed(2)} · ${dTrades} trades\n` +
      `${date} · ${regimeIcon} ${regime.charAt(0).toUpperCase() + regime.slice(1)}\n\n` +
      `${pnlIcon} <b>24h</b>: <b>$${dPnl >= 0 ? '+' : ''}${dPnl.toFixed(2)}</b> · ${dTrades}/${maxTradesPerDay} trades · ${dWR}% WR\n` +
      `  Best: $${parseFloat(d.best || 0).toFixed(2)} · Worst: $${parseFloat(d.worst || 0).toFixed(2)}\n` +
      `  7d: $${wPnl >= 0 ? '+' : ''}${wPnl.toFixed(2)} · ${wTrades} trades\n\n` +
      `💰 <b>Capital</b>: $${capital.toFixed(2)}\n` +
      `  Positions: ${positions.length}/${maxPos} · Risk: ${riskLevel}\n` +
      `  Daily loss limit: -$${dailyLimit}` +
      tradesBlock
    );
  } catch (e) {
    await sendMessage(`🌙 Dagssummering: fel — ${e.message}`);
  }
}

// ─── Scheduled report timers ─────────────────────────────
function startScheduledReports() {
  // Check every minute if it's time for a scheduled report
  let lastMorning = null;
  let lastEvening = null;

  setInterval(() => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const today = now.toISOString().split('T')[0];

    // Morning brief at 08:00 UTC (09:00 CET)
    if (utcHour === 8 && utcMinute === 0 && lastMorning !== today) {
      lastMorning = today;
      sendMorningBrief().catch(console.error);
    }

    // Daily summary at 22:00 UTC (23:00 CET)
    if (utcHour === 22 && utcMinute === 0 && lastEvening !== today) {
      lastEvening = today;
      sendDailySummary().catch(console.error);
    }
  }, 60000);

  // Trade alerts: check for new trades every 15s
  setInterval(() => checkTradeAlerts().catch(e => console.error('[TRADE-POLL] Fatal:', e.message)), TRADE_POLL);

  // Close alerts: check for closed positions every 15s (independent of trade detection)
  setInterval(() => checkClosedPositions().catch(e => console.error('[CLOSE-POLL] Fatal:', e.message)), TRADE_POLL);

  // Health alerts: only on status CHANGE (healthy→down or down→healthy)
  setInterval(() => checkHealthAlerts().catch(() => {}), HEALTH_INTERVAL);

  // Pipeline spam removed — trades and closes are the real events
  console.log('📅 Reports: 08:00 morning, 22:00 summary, trade+close alerts, health on change');
}

// ─── Reconnection helpers ─────────────────────────────────
async function reconnectDB() {
  try { if (db) await db.end().catch(() => {}); } catch {}
  db = null;
  await connectDB();
  console.log('✅ Postgres reconnected');
}

async function reconnectRedis() {
  try { if (redis) await redis.quit().catch(() => {}); } catch {}
  redis = null;
  await connectRedis();
  console.log('✅ Redis reconnected');
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

  // Connect to services with retry
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await connectDB();
      console.log('✅ Postgres connected');
      break;
    } catch (e) {
      if (attempt === 5) console.warn('⚠️  Postgres not available after 5 attempts:', e.message);
      else await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await connectRedis();
      console.log('✅ Redis connected');
      break;
    } catch (e) {
      if (attempt === 5) console.warn('⚠️  Redis not available after 5 attempts:', e.message);
      else await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }

  // Start scheduled reports
  startScheduledReports();

  // Send startup message
  await sendMessage('🤖 <b>Cryonix Bot Online</b>\n\nType /help for commands.');
  console.log('✅ Bot running — polling for commands...');

  // Polling loop with exponential backoff on errors
  let offset = 0;
  let consecutiveErrors = 0;
  while (true) {
    try {
      const updates = await getUpdates(offset);
      consecutiveErrors = 0; // Reset on success
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (msg?.text?.startsWith('/')) {
          console.log(`[CMD] ${msg.from?.first_name}: ${msg.text}`);
          await handleCommand(msg.text, msg.chat.id);
        }
      }
    } catch (e) {
      consecutiveErrors++;
      const backoff = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 120000);
      console.error(`Poll error (streak ${consecutiveErrors}): ${e.message} — retrying in ${backoff / 1000}s`);
      await new Promise(r => setTimeout(r, backoff));

      // Attempt to reconnect services after repeated failures
      if (consecutiveErrors >= 3 && consecutiveErrors % 3 === 0) {
        try { await reconnectDB(); } catch {}
        try { await reconnectRedis(); } catch {}
      }
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
