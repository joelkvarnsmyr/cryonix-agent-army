import { Client as PgClient } from 'pg';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from workspace root if running locally
dotenv.config({ path: resolve(__dirname, '../../.env') });

const OLD_TABLE = 'polynix_trades';

async function archiveHistory() {
    console.log('--- Polynix History Archiver ---');
    
    const url = process.env.POSTGRES_URL || 'postgresql://postgres:password@localhost:5432/cryonix';
    if (!url) {
        console.error('❌ POSTGRES_URL is not set in environment.');
        process.exit(1);
    }

    const pg = new PgClient({ connectionString: url });
    
    try {
        await pg.connect();
        console.log('✅ Connected to Postgres database.');

        // Format a timestamp like _2026_03_26_1650
        const date = new Date();
        const ts = `_${date.getFullYear()}_${(date.getMonth()+1).toString().padStart(2, '0')}_${date.getDate().toString().padStart(2, '0')}_${date.getTime()}`;
        const newTableName = `${OLD_TABLE}_archive${ts}`;

        // Check if the original table exists
        const checkRes = await pg.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = $1
            );
        `, [OLD_TABLE]);

        if (!checkRes.rows[0].exists) {
            console.log(`ℹ️ Tabellen '${OLD_TABLE}' finns inte, det finns inget att arkivera.`);
        } else {
            console.log(`📦 Arkiverar '${OLD_TABLE}' -> '${newTableName}' ...`);
            await pg.query(`ALTER TABLE ${OLD_TABLE} RENAME TO ${newTableName};`);
            console.log('✅ Tabellen har bytt namn och arkiverats.');
        }

        console.log('\n=======================================');
        console.log('🎉 Arkivering klar!');
        console.log('Nästa gång Polynix startas kommer en helt tom, ny');
        console.log(`'${OLD_TABLE}'-tabell att skapas automatiskt, och boten`);
        console.log('börjar sin P&L (vinst/förlust)-räkning från noll.');
        console.log('=======================================\n');

    } catch (err: any) {
        console.error('❌ Ett fel uppstod:', err.message);
    } finally {
        await pg.end();
    }
}

archiveHistory();
