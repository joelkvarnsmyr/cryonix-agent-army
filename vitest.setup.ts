/**
 * Vitest Global Setup
 * Configures the test environment with global mocks and utilities
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest';

// Mock console methods to reduce noise in tests (optional)
// Uncomment to suppress console output during tests
// vi.spyOn(console, 'log').mockImplementation(() => {});
// vi.spyOn(console, 'info').mockImplementation(() => {});

// Mock timers for tests that need time control
// vi.useFakeTimers();

// Global fetch mock setup
const originalFetch = global.fetch;

beforeAll(() => {
    // Setup any global state or mocks before all tests

    // Mock crypto.randomUUID for consistent test output
    if (!global.crypto) {
        global.crypto = {
            randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
        } as Crypto;
    }
});

afterEach(() => {
    // Clean up mocks after each test
    vi.clearAllMocks();

    // Restore timers if they were mocked
    vi.useRealTimers();
});

afterAll(() => {
    // Restore original fetch
    global.fetch = originalFetch;

    // Clean up all mocks
    vi.restoreAllMocks();
});

// Global test utilities
declare global {
    // Add any global type extensions here
    var testUtils: {
        delay: (ms: number) => Promise<void>;
        generateUUID: () => string;
    };
}

// Export test utilities
global.testUtils = {
    delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    generateUUID: () => 'test-uuid-' + Date.now().toString(36),
};
