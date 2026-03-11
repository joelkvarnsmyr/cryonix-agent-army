/**
 * Public signal formatter for Telegram channel
 * Formats BUY and CLOSE signals in English, no sensitive data
 */

const PATTERN_LABELS = {
  dip_buy: 'Dip Buy',
  deep_value_crash: 'Deep Value Crash',
  bollinger_squeeze: 'Bollinger Squeeze',
  rsi_oversold: 'RSI Oversold',
  rsi_overbought: 'RSI Overbought',
  volume_spike_up: 'Volume Spike',
  macd_bullish_cross: 'MACD Bullish Cross',
  ema_bullish_cross: 'EMA Bullish Cross',
  momentum_gainer: 'Momentum Gainer',
};

function fmtPrice(price) {
  const p = parseFloat(price || 0);
  if (p < 0.01) return p.toFixed(8);
  if (p < 1) return p.toFixed(6);
  if (p < 100) return p.toFixed(4);
  return p.toFixed(2);
}

function fmtPatterns(patternStr) {
  if (!patternStr) return 'Mixed';
  return patternStr.split(',').map(p => PATTERN_LABELS[p.trim()] || p.trim()).join(' + ');
}

/**
 * Format a BUY signal for the public Telegram channel
 * @param {object} trade - Trade object from DB (symbol, entry_price, pattern, confidence, metadata)
 */
export function formatBuySignal(trade) {
  const symbol = (trade.symbol || '').replace('/USDC', '').replace('/USDT', '');
  const pair = trade.symbol || `${symbol}/USDC`;
  const entry = fmtPrice(trade.entry_price || trade.entryPrice);
  const rawConf = parseFloat(trade.confidence || 0);
  const conf = Math.round(rawConf <= 1 ? rawConf * 100 : rawConf);
  const patterns = fmtPatterns(trade.pattern);

  const meta = typeof trade.metadata === 'object' ? trade.metadata : {};
  const slRaw = trade.stop_loss || trade.stopLoss || meta.stopLoss || null;
  const tpRaw = trade.take_profit || trade.takeProfit || meta.takeProfit || null;
  const sl = slRaw ? fmtPrice(slRaw) : null;
  const tp = tpRaw ? fmtPrice(tpRaw) : null;

  let lines = [
    `<b>BUY ${pair}</b>`,
    ``,
    `Entry: <code>$${entry}</code>`,
  ];

  if (sl) lines.push(`Stop Loss: <code>$${sl}</code>`);
  if (tp) lines.push(`Take Profit: <code>$${tp}</code>`);
  if (sl && tp) {
    const entryNum = parseFloat(entry);
    const slNum = parseFloat(sl);
    const tpNum = parseFloat(tp);
    const risk = Math.abs(entryNum - slNum);
    const reward = Math.abs(tpNum - entryNum);
    if (risk > 0) lines.push(`R:R: <b>1:${(reward / risk).toFixed(1)}</b>`);
  }

  lines.push(``);
  lines.push(`Pattern: ${patterns}`);
  lines.push(`Confidence: <b>${conf}%</b>`);
  lines.push(``);
  lines.push(`<i>Powered by Cryonix</i>`);

  return lines.join('\n');
}

/**
 * Format a CLOSE signal for the public Telegram channel
 * @param {object} position - Position from position_history (symbol, entry_price, exit_price, pnl, close_reason, etc.)
 */
export function formatCloseSignal(position) {
  const symbol = (position.symbol || '').replace('/USDC', '').replace('/USDT', '');
  const pair = position.symbol || `${symbol}/USDC`;
  const entry = fmtPrice(position.entry_price || position.entryPrice);
  const exit = fmtPrice(position.exit_price || position.exitPrice);
  const pnl = parseFloat(position.pnl || 0);
  const entryNum = parseFloat(position.entry_price || position.entryPrice || 0);
  const exitNum = parseFloat(position.exit_price || position.exitPrice || 0);
  const pnlPct = entryNum > 0 ? ((exitNum - entryNum) / entryNum * 100).toFixed(2) : '?';

  const holdH = parseFloat(position.holding_hours || 0);
  const holdStr = holdH < 1 ? `${Math.round(holdH * 60)}min` : `${holdH.toFixed(1)}h`;

  const icon = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN';
  const emoji = pnl > 0 ? '\u2705' : pnl < 0 ? '\u274C' : '\u2796';

  const reasonMap = {
    'STOP_LOSS': 'Stop Loss',
    'TAKE_PROFIT': 'Take Profit',
    'TRAILING_STOP': 'Trailing Stop',
    'STAGNATION': 'Stagnation Timeout',
    'NATIVE_SL': 'Stop Loss (Exchange)',
    'MANUAL': 'Manual Close',
    'DUST': 'Dust Cleanup',
  };
  const closeReason = reasonMap[position.close_reason || position.closeReason] || position.close_reason || position.closeReason || '?';

  let lines = [
    `<b>${emoji} ${icon}: ${pair}</b>`,
    ``,
    `Entry: <code>$${entry}</code> → Exit: <code>$${exit}</code>`,
    `P&L: <b>${pnlPct}%</b>`,
    ``,
    `Closed: ${closeReason}`,
    `Duration: ${holdStr}`,
    `Pattern: ${fmtPatterns(position.pattern)}`,
    ``,
    `<i>Powered by Cryonix</i>`,
  ];

  return lines.join('\n');
}
