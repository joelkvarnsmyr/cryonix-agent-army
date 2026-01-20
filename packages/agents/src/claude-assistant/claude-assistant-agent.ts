import { BaseAgent } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import OpenAI from 'openai';

export class ClaudeAssistantAgent extends BaseAgent {
  private grok: OpenAI | null = null;
  private conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  constructor() {
    super({
      id: 'claude_assistant',
      name: 'AI Assistant Agent',
      description: 'GROK-powered natural language trading assistant',
      enabled: true,
    });
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing AI Assistant Agent with GROK...');

    // Initialize xAI GROK (OpenAI-compatible API)
    this.grok = new OpenAI({
      apiKey: process.env.XAI_API_KEY || '',
      baseURL: 'https://api.x.ai/v1',
    });

    this.setStatus('idle');
  }

  async start(): Promise<void> {
    this.log('info', 'Starting AI Assistant Agent...');
    this.setStatus('running');
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping AI Assistant Agent...');
    this.setStatus('idle');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', 'Received message', message);
  }

  async chat(userMessage: string, systemContext?: any): Promise<string> {
    try {
      if (!this.grok) {
        throw new Error('GROK not initialized');
      }

      const systemPrompt = this.buildSystemPrompt(systemContext);

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...this.conversationHistory,
        { role: 'user' as const, content: userMessage },
      ];

      const response = await this.grok.chat.completions.create({
        model: 'grok-beta',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
      });

      const assistantMessage = response.choices[0]?.message?.content || '';

      // Update conversation history
      this.conversationHistory.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantMessage }
      );

      // Keep only last 10 messages to avoid token limits
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      return assistantMessage;
    } catch (error) {
      this.log('error', 'Error in chat', error);
      return 'Sorry, I encountered an error. Please try again.';
    }
  }

  async analyzeSignal(signal: any): Promise<any> {
    try {
      if (!this.grok) {
        throw new Error('GROK not initialized');
      }

      const prompt = `
Analyze this crypto trading signal and provide your assessment:

Symbol: ${signal.symbol}
Pattern: ${signal.pattern}
Current Price: $${signal.entry_price}
Target: $${signal.target_price}
Stop Loss: $${signal.stop_loss}
Confidence: ${(signal.confidence * 100).toFixed(0)}%

Reasoning:
${signal.reasoning.join('\n')}

Provide:
1. Your confidence score (0-1)
2. Key risks to consider
3. What would invalidate this trade
4. Recommended position size (% of portfolio)

Format as JSON:
{
  "confidence": 0.75,
  "risks": ["risk 1", "risk 2"],
  "invalidation": "explanation",
  "position_size": 0.02,
  "explanation": "your analysis"
}
`;

      const response = await this.grok.chat.completions.create({
        model: 'grok-beta',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content || '{}';

      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return {
        confidence: 0.5,
        risks: ['Unable to analyze signal'],
        invalidation: 'Unknown',
        position_size: 0.01,
        explanation: 'Analysis failed',
      };
    } catch (error) {
      this.log('error', 'Error analyzing signal', error);
      return null;
    }
  }

  private buildSystemPrompt(context?: any): string {
    return `You are GROK, an AI trading assistant for the Cryonix AI Trading Dashboard.

You help users make informed trading decisions by:
- Analyzing trading signals and patterns
- Explaining agent decisions in simple terms
- Providing market insights and risk analysis
- Answering questions about the trading system

Current System Status:
${context ? JSON.stringify(context, null, 2) : 'No context provided'}

Be conversational, witty (like the real GROK), and provide actionable insights.
Always emphasize risk management and never guarantee profits.
`;
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.log('info', 'Conversation history cleared');
  }
}
