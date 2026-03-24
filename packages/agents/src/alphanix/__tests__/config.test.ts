import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { loadAlphanixConfig, resetAlphanixConfig, toPodConfig } from '../config';

const TOML_PATH = join(__dirname, '..', '..', '..', '..', '..', 'alphanix.toml');

describe('loadAlphanixConfig', () => {
    beforeEach(() => {
        resetAlphanixConfig();
    });

    it('should load config from alphanix.toml', () => {
        const config = loadAlphanixConfig(TOML_PATH);

        expect(config.orchestrator.max_pods).toBe(10);
        expect(config.orchestrator.capital_total_usd).toBe(10000);
        expect(config.orchestrator.esg.enabled).toBe(false);
        expect(config.swarms.max_concurrent_workers).toBe(5);
        expect(config.pods.crypto_momentum.enabled).toBe(true);
        expect(config.pods.crypto_momentum.adapter).toBe('binance');
        expect(config.pods.us_tech.enabled).toBe(true);
        expect(config.timing.orchestrator_loop_ms).toBe(60000);
    });

    it('should return defaults when file not found', () => {
        const config = loadAlphanixConfig('/nonexistent/path/alphanix.toml');

        expect(config.orchestrator.max_pods).toBe(10);
        expect(config.pods.crypto_momentum.enabled).toBe(true);
        expect(config.pods.crypto_momentum.symbols).toEqual(['BTC/USDC', 'ETH/USDC', 'SOL/USDC']);
        expect(config.timing.pod_default_loop_ms).toBe(30000);
    });

    it('should cache config on second call (toBe same reference)', () => {
        const first = loadAlphanixConfig(TOML_PATH);
        const second = loadAlphanixConfig(TOML_PATH);

        expect(second).toBe(first);
    });

    it('should have all pod configs defined', () => {
        const config = loadAlphanixConfig(TOML_PATH);
        const podIds = Object.keys(config.pods);

        expect(podIds).toContain('crypto_momentum');
        expect(podIds).toContain('us_tech');
        expect(podIds).toContain('nordic_value');
        expect(podIds.length).toBeGreaterThan(5);
    });
});

describe('toPodConfig', () => {
    it('should convert raw pod to PodConfig type', () => {
        const config = loadAlphanixConfig(TOML_PATH);
        const pod = toPodConfig('crypto_momentum', config.pods.crypto_momentum);

        expect(pod.id).toBe('crypto_momentum');
        expect(pod.enabled).toBe(true);
        expect(pod.adapter).toBe('binance');
        expect(pod.capitalPct).toBe(15);
        expect(pod.strategy).toBe('momentum');
        expect(pod.symbols).toEqual(['BTC/USDC', 'ETH/USDC', 'SOL/USDC']);
        expect(pod.pollIntervalMs).toBe(30000);
        expect(pod.riskMaxDrawdownPct).toBe(3.0);
        expect(pod.riskMaxPositions).toBe(5);
        expect(pod.tradingHours).toBeUndefined();
    });

    it('should include tradingHours when present', () => {
        const config = loadAlphanixConfig(TOML_PATH);
        const pod = toPodConfig('us_tech', config.pods.us_tech);

        expect(pod.tradingHours).toBe('09:30-16:00 ET');
    });
});
