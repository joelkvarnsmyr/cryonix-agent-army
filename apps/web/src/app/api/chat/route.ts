import { NextRequest, NextResponse } from 'next/server';
import { ClaudeAssistantAgent } from '@cryonix/agents';

const claudeAssistant = new ClaudeAssistantAgent();
let initialized = false;

export async function POST(request: NextRequest) {
  try {
    if (!initialized) {
      await claudeAssistant.initialize();
      initialized = true;
    }

    const body = await request.json();
    const { message, context } = body;

    if (!message) {
      return NextResponse.json(
        { success: false, error: 'Message is required' },
        { status: 400 }
      );
    }

    const response = await claudeAssistant.chat(message, context);

    return NextResponse.json({
      success: true,
      message: response,
    });
  } catch (error: any) {
    console.error('Error in chat:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to process chat' },
      { status: 500 }
    );
  }
}
