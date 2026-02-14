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
      `🚀 <b>Evolution Started</b>\n` +
      `Run: <code>${runId}</code>\n` +
      `Time: ${new Date().toISOString()}`
    );
  }

  /** Report performance analysis results */
  async sendPerformanceReport(data) {
    if (!data) {
      return this.send('📊 <b>Evolution Analysis</b>\nNo trades in last 24h — skipping.');
    }

    const patternLines = data.patterns.map(p => {
      const winRate = ((parseInt(p.wins) / parseInt(p.trade_count)) * 100).toFixed(0);
      const pnl = parseFloat(p.total_pnl).toFixed(2);
      const emoji = parseFloat(p.total_pnl) >= 0 ? '🟢' : '🔴';
      return `${emoji} ${p.pattern}: ${p.trade_count} trades, $${pnl}, ${winRate}% WR`;
    }).join('\n');

    return this.send(
      `📊 <b>Performance Report (24h)</b>\n\n` +
      `Total P&L: <b>$${data.totalPnl.toFixed(2)}</b>\n` +
      `Trades: ${data.totalTrades}\n` +
      `Weakest: ${data.weakestPattern} ($${data.weakestPnl.toFixed(2)})\n` +
      `Evolution needed: ${data.needsEvolution ? '⚡ YES' : '✅ NO'}\n\n` +
      patternLines
    );
  }

  /** Report GROK analysis phase */
  async sendGrokPhase(instructionLength, tokensIn, tokensOut) {
    return this.send(
      `🧠 <b>GROK Analysis Complete</b>\n` +
      `Instruction: ${instructionLength} chars\n` +
      `Tokens: ${tokensIn} in / ${tokensOut} out`
    );
  }

  /** Report Copilot execution phase */
  async sendCopilotPhase(success, model) {
    const emoji = success ? '✅' : '❌';
    return this.send(
      `🔧 <b>Copilot Execution</b> ${emoji}\n` +
      `Model: ${model}\n` +
      `Result: ${success ? 'Changes applied' : 'Failed'}`
    );
  }

  /** Report verification results */
  async sendVerificationResult(passed, failedCommand) {
    if (passed) {
      return this.send('🧪 <b>Verification</b> ✅ All tests passed');
    }
    return this.send(
      `🧪 <b>Verification</b> ❌ Failed\n` +
      `Command: <code>${failedCommand}</code>`
    );
  }

  /** Report git commit + push */
  async sendGitReport(commitMsg, pushed) {
    return this.send(
      `📝 <b>Git Commit</b>\n` +
      `<code>${commitMsg}</code>\n` +
      `Push: ${pushed ? '✅ Pushed to GitHub' : '⚠️ Local only'}`
    );
  }

  /** Report final evolution result */
  async sendEvolutionResult(success, details = {}) {
    const duration = details.duration ? `${details.duration.toFixed(0)}s` : '?';
    const emoji = success ? '🎉' : '💥';

    return this.send(
      `${emoji} <b>Evolution ${success ? 'Complete' : 'Failed'}</b>\n\n` +
      `Run: <code>${details.runId || '?'}</code>\n` +
      `Duration: ${duration}\n` +
      `Reason: ${details.reason || '?'}\n` +
      `Attempts: ${details.attempts || '?'}`
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
