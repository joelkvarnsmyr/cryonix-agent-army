import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:3004';

console.log(`🔌 Connecting to ${WS_URL}...`);
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ Connected!');

    // Simulate a new signal
    const signal = {
        type: 'NEW_SIGNAL',
        data: {
            symbol: 'BTC/USDT',
            side: 'BUY',
            confidence: 0.85,
            timestamp: Date.now(),
            reasoning: 'Simulated Bullish Divergence + Volume Spike',
            entry: 47500,
            target: 48200,
            stopLoss: 47100
        }
    };

    console.log('🚀 Sending simulated signal:', signal);

    ws.send(JSON.stringify({
        type: 'BROADCAST',
        payload: signal
    }));

    // Simulate portfolio update
    const portfolioUpdate = {
        type: 'PORTFOLIO_UPDATE',
        data: {
            summary: {
                totalValueUSD: 50000 + Math.random() * 1000
            }
        }
    };

    console.log('💰 Sending portfolio update...');
    ws.send(JSON.stringify({
        type: 'BROADCAST',
        payload: portfolioUpdate
    }));

    setTimeout(() => {
        console.log('👋 Closing connection');
        ws.close();
        process.exit(0);
    }, 1000);
});

ws.on('error', (err) => {
    console.error('❌ Connection error:', err.message);
    console.log('💡 Tip: Is the WebSocket server running? (pnpm run ws:dev)');
    process.exit(1);
});
