import { NextRequest, NextResponse } from 'next/server';

const PYTHON_ENGINE_URL = process.env.PYTHON_ENGINE_URL || 'http://localhost:8000';

export async function GET() {
  try {
    const response = await fetch(`${PYTHON_ENGINE_URL}/risk/status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    return NextResponse.json(data);

  } catch (error) {
    console.error('[API/Risk] Error:', error);
    return NextResponse.json(
      { error: 'Failed to get risk status', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, pnl, is_win, signal } = body;

    let endpoint = '';
    let method = 'POST';
    let requestBody = {};

    switch (action) {
      case 'check':
        endpoint = '/risk/check';
        requestBody = signal;
        break;
      case 'record-trade':
        endpoint = `/risk/record-trade?pnl=${pnl}&is_win=${is_win}`;
        break;
      case 'reset-circuit-breaker':
        endpoint = '/risk/reset-circuit-breaker';
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const response = await fetch(`${PYTHON_ENGINE_URL}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: Object.keys(requestBody).length > 0 ? JSON.stringify(requestBody) : undefined,
    });

    const data = await response.json();
    return NextResponse.json(data);

  } catch (error) {
    console.error('[API/Risk] Error:', error);
    return NextResponse.json(
      { error: 'Failed to process risk action', details: String(error) },
      { status: 500 }
    );
  }
}
