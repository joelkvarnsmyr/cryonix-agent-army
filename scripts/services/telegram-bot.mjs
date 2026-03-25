#!/usr/bin/env node
/**
 * Cryonix Telegram Bot
 * Sends evolution reports and system status to Telegram.
 * 
 * Usage:
 *   import { TelegramBot } from './telegram-bot.mjs';
 *   const bot = new TelegramBot();
 *   await bot.send('Hello!');
 *   await bot.sendEvolutionReport({ ... });
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';

export class TelegramBot {
  constructor(token, chatId) {
    this.token = token || process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = chatId || process.env.TELEGRAM_CHAT_ID;

    if (!this.token || !this.chatId) {
      console.warn('⚠️  Telegram bot not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    }
  }

  get configured() {
    return !!(this.token && this.chatId);
  }

  /** Send a plain text or HTML message */
  async send(text, parseMode = 'HTML') {
    if (!this.configured) return null;

    try {
      const res = await fetch(`${TELEGRAM_API}${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: text.substring(0, 4096), // Telegram limit
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });
      const data = await res.json();
      if (!data.ok) console.error('Telegram error:', data.description);
      return data;
    } catch (error) {
      console.error('Telegram send failed:', error.message);
      return null;
    }
  }

  /** Report evolution engine start */
  async sendEvolutionStart(runId) {
    return this.send(
      `🚀 Evolution startad: ${runId}\n` +
      `${new Date().toISOString()}`
    );
  }

  /** Report performance analysis results */
  async sendPerformanceReport(data) {
    if (!data) {
      return this.send('📊 Evolution: inga trades senaste 24h — skippar');
    }

    const patternLines = data.patterns.map(p => {
      const winRate = ((parseInt(p.wins) / parseInt(p.trade_count)) * 100).toFixed(0);
      const pnl = parseFloat(p.total_pnl).toFixed(2);
      const emoji = parseFloat(p.total_pnl) >= 0 ? '🟢' : '🔴';
      return `${emoji} ${p.pattern}: ${p.trade_count} trades, $${pnl}, ${winRate}% WR`;
    }).join('\n');

    return this.send(
      `📊 Performance 24h: P&L $${data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)}, ${data.totalTrades} trades\n` +
      `Svagast: ${data.weakestPattern} ($${data.weakestPnl.toFixed(2)})\n` +
      `Evolution: ${data.needsEvolution ? '⚡ behövs' : '✅ ej nödvändig'}\n\n` +
      patternLines
    );
  }

  /** Report Claude analysis start */
  async sendClaudeAnalysis(model, turns) {
    return this.send(
      `🧠 Evolution: Claude analyserar (${model}, ${turns} steg)`
    );
  }

  /** Report Claude mutation result */
  async sendClaudeMutation(success, model) {
    const emoji = success ? '✅' : '❌';
    return this.send(
      `🔧 Mutation ${emoji}: ${success ? 'ändringar applicerade' : 'misslyckades'} (${model})`
    );
  }

  /** Report verification results */
  async sendVerificationResult(passed, failedCommand) {
    if (passed) {
      return this.send('🧪 Verifiering: ✅ alla tester godkända');
    }
    return this.send(
      `🧪 Verifiering: ❌ misslyckades\n` +
      `Kommando: <code>${failedCommand}</code>`
    );
  }

  /** Report git commit + push */
  async sendGitReport(commitMsg, pushed) {
    return this.send(
      `📝 Git: ${commitMsg}\n` +
      `${pushed ? '✅ Pushad till GitHub' : '⚠️ Bara lokalt'}`
    );
  }

  /** Report final evolution result */
  async sendEvolutionResult(success, details = {}) {
    const duration = details.duration ? `${details.duration.toFixed(0)}s` : '?';
    const emoji = success ? '🎉' : '💥';

    return this.send(
      `${emoji} Evolution ${success ? 'klar' : 'misslyckades'}: ${details.reason || '?'}\n` +
      `Run: <code>${details.runId || '?'}</code> · ${duration} · ${details.attempts || '?'} försök`
    );
  }
}

// CLI: send a message directly
// Usage: node telegram-bot.mjs "your message here"
if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = await import('dotenv');
  config();

  const message = process.argv.slice(2).join(' ') || 'Test from Cryonix Telegram Bot';
  const bot = new TelegramBot();
  const result = await bot.send(message);
  console.log(result?.ok ? '✅ Sent' : '❌ Failed');
}
