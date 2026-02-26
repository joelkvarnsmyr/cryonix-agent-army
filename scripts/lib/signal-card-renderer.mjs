/**
 * Signal card image renderer for Telegram channel
 * Uses satori (JSX → SVG) + resvg (SVG → PNG)
 * Generates branded dark-theme signal cards
 */

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load font once at startup
let fontData;
try {
  fontData = readFileSync(join(__dirname, 'fonts', 'Inter-Bold.ttf'));
} catch {
  // Font will be loaded on first render if not available at startup
  fontData = null;
}

let fontDataRegular;
try {
  fontDataRegular = readFileSync(join(__dirname, 'fonts', 'Inter-Regular.ttf'));
} catch {
  fontDataRegular = null;
}

// Download fonts if not bundled (with mutex to prevent race condition)
let fontLoadPromise = null;

async function ensureFonts() {
  if (fontData && fontDataRegular) return;

  // Use a shared promise to prevent concurrent font downloads
  if (!fontLoadPromise) {
    fontLoadPromise = _loadFonts().catch(err => {
      fontLoadPromise = null; // allow retry on failure
      throw err;
    });
  }
  return fontLoadPromise;
}

async function _loadFonts() {
  const TIMEOUT = 10000;

  const fetchFont = async (weight) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const cssUrl = `https://fonts.googleapis.com/css2?family=Inter:wght@${weight}&display=swap`;
      const cssRes = await fetch(cssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: controller.signal,
      });
      const css = await cssRes.text();
      // Match both .ttf and .woff2 font URLs
      const match = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+\.(?:ttf|woff2))\)/);
      if (!match) throw new Error(`Could not find font URL for weight ${weight}`);
      const fontRes = await fetch(match[1], { signal: controller.signal });
      return Buffer.from(await fontRes.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  };

  if (!fontData) fontData = await fetchFont(700);
  if (!fontDataRegular) fontDataRegular = await fetchFont(400);
}

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
  if (!patternStr) return ['Mixed'];
  return patternStr.split(',').map(p => PATTERN_LABELS[p.trim()] || p.trim());
}

const COLORS = {
  bg: '#080d19',
  cardBg: '#0c1526',
  border: '#1a2744',
  cyan: '#00d4ff',
  green: '#22c55e',
  red: '#ef4444',
  white: '#e2e8f0',
  muted: '#64748b',
  accent: '#0ea5e9',
};

/**
 * Render a BUY signal card as PNG buffer
 */
export async function renderBuyCard(trade) {
  await ensureFonts();

  const symbol = (trade.symbol || '').replace('/USDC', '').replace('/USDT', '');
  const pair = trade.symbol || `${symbol}/USDC`;
  const entry = fmtPrice(trade.entry_price || trade.entryPrice);
  const conf = Math.round(parseFloat(trade.confidence || 0));
  const patterns = fmtPatterns(trade.pattern);
  const meta = typeof trade.metadata === 'object' ? trade.metadata : {};
  const slRaw = trade.stop_loss || trade.stopLoss || meta.stopLoss || null;
  const tpRaw = trade.take_profit || trade.takeProfit || meta.takeProfit || null;
  const sl = slRaw ? fmtPrice(slRaw) : null;
  const tp = tpRaw ? fmtPrice(tpRaw) : null;

  let rrText = null;
  if (sl && tp) {
    const entryNum = parseFloat(entry);
    const slNum = parseFloat(sl);
    const tpNum = parseFloat(tp);
    const risk = Math.abs(entryNum - slNum);
    const reward = Math.abs(tpNum - entryNum);
    if (risk > 0) rrText = `1:${(reward / risk).toFixed(1)}`;
  }

  const jsx = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: `linear-gradient(135deg, ${COLORS.bg} 0%, ${COLORS.cardBg} 100%)`,
        padding: '40px',
        fontFamily: 'Inter',
        color: COLORS.white,
      },
      children: [
        // Top bar: signal type + branding
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '24px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          background: COLORS.green,
                          color: '#000',
                          padding: '6px 16px',
                          borderRadius: '6px',
                          fontSize: '18px',
                          fontWeight: 700,
                          letterSpacing: '1px',
                        },
                        children: 'BUY SIGNAL',
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: COLORS.cyan,
                    fontSize: '16px',
                    fontWeight: 700,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          background: COLORS.cyan,
                        },
                      },
                    },
                    'CRYONIX',
                  ],
                },
              },
            ],
          },
        },
        // Symbol
        {
          type: 'div',
          props: {
            style: {
              fontSize: '48px',
              fontWeight: 700,
              letterSpacing: '-1px',
              marginBottom: '32px',
            },
            children: pair,
          },
        },
        // Price grid
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              gap: '20px',
              marginBottom: '32px',
            },
            children: [
              priceBox('ENTRY', `$${entry}`, COLORS.white),
              sl ? priceBox('STOP LOSS', `$${sl}`, COLORS.red) : null,
              tp ? priceBox('TAKE PROFIT', `$${tp}`, COLORS.green) : null,
            ].filter(Boolean),
          },
        },
        // Bottom row: patterns + confidence + R:R
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              marginTop: 'auto',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
                  children: patterns.map(p => patternBadge(p)),
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                  },
                  children: [
                    rrText ? {
                      type: 'div',
                      props: {
                        style: { fontSize: '16px', color: COLORS.muted },
                        children: `R:R ${rrText}`,
                      },
                    } : null,
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '28px',
                          fontWeight: 700,
                          color: conf >= 75 ? COLORS.green : conf >= 60 ? COLORS.cyan : COLORS.muted,
                        },
                        children: `${conf}%`,
                      },
                    },
                  ].filter(Boolean),
                },
              },
            ],
          },
        },
      ],
    },
  };

  return renderToBuffer(jsx);
}

/**
 * Render a CLOSE signal card as PNG buffer
 */
export async function renderCloseCard(position) {
  await ensureFonts();

  const pair = position.symbol || '?';
  const entry = fmtPrice(position.entry_price || position.entryPrice);
  const exit = fmtPrice(position.exit_price || position.exitPrice);
  const pnl = parseFloat(position.pnl || 0);
  const entryNum = parseFloat(position.entry_price || position.entryPrice || 0);
  const exitNum = parseFloat(position.exit_price || position.exitPrice || 0);
  const pnlPct = entryNum > 0 ? ((exitNum - entryNum) / entryNum * 100) : 0;
  const holdH = parseFloat(position.holding_hours || 0);
  const holdStr = holdH < 1 ? `${Math.round(holdH * 60)}min` : `${holdH.toFixed(1)}h`;
  const patterns = fmtPatterns(position.pattern);

  const isWin = pnl > 0;
  const isLoss = pnl < 0;
  const resultColor = isWin ? COLORS.green : isLoss ? COLORS.red : COLORS.muted;
  const resultLabel = isWin ? 'WIN' : isLoss ? 'LOSS' : 'BREAKEVEN';
  const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

  const reasonMap = {
    'STOP_LOSS': 'Stop Loss', 'TAKE_PROFIT': 'Take Profit',
    'TRAILING_STOP': 'Trailing Stop', 'STAGNATION': 'Stagnation',
    'NATIVE_SL': 'Stop Loss', 'MANUAL': 'Manual', 'DUST': 'Dust',
  };
  const reason = reasonMap[position.close_reason || position.closeReason] || position.close_reason || position.closeReason || '?';

  const jsx = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: `linear-gradient(135deg, ${COLORS.bg} 0%, ${COLORS.cardBg} 100%)`,
        padding: '40px',
        fontFamily: 'Inter',
        color: COLORS.white,
      },
      children: [
        // Top bar
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '24px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          background: resultColor,
                          color: '#000',
                          padding: '6px 16px',
                          borderRadius: '6px',
                          fontSize: '18px',
                          fontWeight: 700,
                          letterSpacing: '1px',
                        },
                        children: `CLOSED — ${resultLabel}`,
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: COLORS.cyan,
                    fontSize: '16px',
                    fontWeight: 700,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          background: COLORS.cyan,
                        },
                      },
                    },
                    'CRYONIX',
                  ],
                },
              },
            ],
          },
        },
        // Symbol + P&L
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '32px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: '48px', fontWeight: 700, letterSpacing: '-1px' },
                  children: pair,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: '42px', fontWeight: 700, color: resultColor },
                  children: pnlStr,
                },
              },
            ],
          },
        },
        // Price grid
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              gap: '20px',
              marginBottom: '32px',
            },
            children: [
              priceBox('ENTRY', `$${entry}`, COLORS.white),
              priceBox('EXIT', `$${exit}`, resultColor),
              priceBox('DURATION', holdStr, COLORS.muted),
            ],
          },
        },
        // Bottom: patterns + close reason
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              marginTop: 'auto',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
                  children: patterns.map(p => patternBadge(p)),
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: '16px', color: COLORS.muted },
                  children: reason,
                },
              },
            ],
          },
        },
      ],
    },
  };

  return renderToBuffer(jsx);
}

function priceBox(label, value, valueColor) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '16px 24px',
        flex: '1',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { fontSize: '12px', color: COLORS.muted, letterSpacing: '1px', marginBottom: '4px' },
            children: label,
          },
        },
        {
          type: 'div',
          props: {
            style: { fontSize: '22px', fontWeight: 700, color: valueColor },
            children: value,
          },
        },
      ],
    },
  };
}

function patternBadge(name) {
  return {
    type: 'div',
    props: {
      style: {
        fontSize: '13px',
        padding: '4px 12px',
        borderRadius: '6px',
        background: 'rgba(0, 212, 255, 0.1)',
        border: `1px solid rgba(0, 212, 255, 0.25)`,
        color: COLORS.cyan,
      },
      children: name,
    },
  };
}

async function renderToBuffer(jsx) {
  const svg = await satori(jsx, {
    width: 800,
    height: 420,
    fonts: [
      { name: 'Inter', data: fontDataRegular, weight: 400 },
      { name: 'Inter', data: fontData, weight: 700 },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 800 },
  });
  return resvg.render().asPng();
}
