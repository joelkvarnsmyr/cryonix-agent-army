import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Initialize Drizzle with postgres.js (works both locally and on Vercel)
const connectionString = process.env.POSTGRES_URL || 'postgres://postgres:password@localhost:5432/cryonix';
const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Export schema
export * from './schema';

// Export repositories
export * from './signals.repository';
export * from './backtest.repository';
export * from './validation.repository';
export * from './positions.repository';
export * from './trades.repository';

// Helper functions
export const getDb = () => db;
