import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // Setup files for global test configuration
        setupFiles: ['./vitest.setup.ts'],
        // Coverage configuration
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html', 'lcov'],
            reportsDirectory: './coverage',
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mock*.ts',
                '**/__tests__/**',
                '**/index.ts', // Barrel files
                '**/*.setup.ts',
            ],
            include: [
                'packages/agents/src/**/*.ts',
                'packages/types/src/**/*.ts',
                'packages/database/src/**/*.ts',
                'apps/web/src/**/*.ts',
            ],
            thresholds: {
                statements: 70,
                branches: 65,
                functions: 70,
                lines: 70,
            },
        },
        // Test file patterns
        include: [
            'packages/**/src/**/*.test.ts',
            'packages/**/src/**/*.spec.ts',
            'apps/**/src/**/*.test.ts',
            'apps/**/src/**/*.spec.ts',
        ],
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.turbo/**',
            '**/.next/**',
        ],
        // Test timeout (5 seconds)
        testTimeout: 5000,
        // Hook timeout
        hookTimeout: 10000,
        // Retry failed tests
        retry: 1,
        // Reporter configuration
        reporters: ['verbose'],
        // Pool configuration for parallel execution
        pool: 'threads',
        poolOptions: {
            threads: {
                singleThread: false,
                isolate: true,
            },
        },
        // Snapshot configuration
        snapshotFormat: {
            printBasicPrototype: false,
        },
    },
    resolve: {
        alias: {
            '@cryonix/agents': path.resolve(__dirname, './packages/agents/src'),
            '@cryonix/types': path.resolve(__dirname, './packages/types/src'),
            '@cryonix/database': path.resolve(__dirname, './packages/database/src'),
            '@cryonix/ui': path.resolve(__dirname, './packages/ui/src'),
            '@': path.resolve(__dirname, './apps/web/src'),
        },
    },
});
