import { drizzle } from 'drizzle-orm/vercel-postgres';
import { sql as vercelSql } from '@vercel/postgres';
import * as schema from './schema';

// Initialize Drizzle with Vercel Postgres
export const db = drizzle(vercelSql, { schema });

// Export schema
export * from './schema';

// Helper functions
export const getDb = () => db;
