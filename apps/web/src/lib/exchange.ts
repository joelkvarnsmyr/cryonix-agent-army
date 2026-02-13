import ccxt, { binance } from 'ccxt';

// Singleton pattern for exchange instance
let exchangeInstance: binance | null = null;

/**
 * Get the Binance exchange instance configured for the correct environment.
 * Uses testnet when BINANCE_TESTNET=true.
 */
export function getExchange(): binance {
    if (!exchangeInstance) {
        const isTestnet = process.env.BINANCE_TESTNET === 'true';

        exchangeInstance = new ccxt.binance({
            apiKey: process.env.BINANCE_API_KEY,
            secret: process.env.BINANCE_API_SECRET,
            enableRateLimit: true,
            sandbox: isTestnet,
        });

        // Set testnet URLs if using testnet
        if (isTestnet) {
            exchangeInstance.setSandboxMode(true);
        }
    }

    return exchangeInstance;
}

// Export default exchange for convenience
export const exchange = getExchange();
