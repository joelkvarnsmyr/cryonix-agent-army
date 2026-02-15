"""
Telegram Signal Scraper — Cryonix Agent Army

Connects to Telegram as a user client (MTProto via Telethon),
listens to configured signal channels in real-time, parses
BUY/SELL signals, and writes to Redis + Postgres.

Signals are used as confidence modifiers for internal QuantGuild signals.
Phase 1: Log only (CONFIDENCE_BOOST_ENABLED=false).
Phase 2: Active confidence boost when channel quality is proven.
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import redis as redis_lib
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession

from parser import parse_signal

load_dotenv()

# ─── Logging ────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    stream=sys.stdout,
)
log = logging.getLogger('telegram-scraper')

# ─── Config ─────────────────────────────────────────────────────────
TELEGRAM_API_ID = int(os.environ['TELEGRAM_API_ID'])
TELEGRAM_API_HASH = os.environ['TELEGRAM_API_HASH']
TELEGRAM_SESSION = os.environ['TELEGRAM_SESSION']
TELEGRAM_CHANNELS = [c.strip() for c in os.getenv('TELEGRAM_CHANNELS', '').split(',') if c.strip()]
KV_URL = os.getenv('KV_URL', 'redis://localhost:6379')
POSTGRES_URL = os.getenv('POSTGRES_URL', 'postgresql://postgres:password@localhost:5432/cryonix')
CONFIDENCE_BOOST_ENABLED = os.getenv('CONFIDENCE_BOOST_ENABLED', 'false').lower() == 'true'

# Confidence delta based on channel consensus
CONFIDENCE_DELTAS = {
    1: 0.05,  # 1 channel match: +5%
    2: 0.08,  # 2 channels match: +8%
    3: 0.12,  # 3+ channels match: +12%
}
MAX_CONFIDENCE_DELTA = 0.12
SIGNAL_TTL_SECONDS = 30 * 60  # 30 minutes
DEDUP_TTL_SECONDS = 30 * 60   # 30 minutes

# ─── Redis ──────────────────────────────────────────────────────────
_redis: redis_lib.Redis | None = None


def get_redis() -> redis_lib.Redis:
    global _redis
    if _redis is None:
        _redis = redis_lib.from_url(KV_URL, decode_responses=True)
    return _redis


# ─── Postgres ───────────────────────────────────────────────────────
_pg_conn = None


def get_pg():
    global _pg_conn
    if _pg_conn is None or _pg_conn.closed:
        _pg_conn = psycopg2.connect(POSTGRES_URL)
        _pg_conn.autocommit = True
    return _pg_conn


def ensure_tables():
    """Create telegram tables if they don't exist (idempotent)."""
    conn = get_pg()
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS telegram_signals (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL,
                channel_id VARCHAR(50) NOT NULL,
                channel_name VARCHAR(100) NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                action VARCHAR(10) NOT NULL,
                entry_price DECIMAL(20,8),
                entry_price_high DECIMAL(20,8),
                stop_loss DECIMAL(20,8),
                tp1 DECIMAL(20,8),
                tp2 DECIMAL(20,8),
                tp3 DECIMAL(20,8),
                raw_message TEXT NOT NULL,
                parsed BOOLEAN DEFAULT TRUE,
                matched_internal_signal BOOLEAN DEFAULT FALSE,
                outcome VARCHAR(20),
                metadata JSONB
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS telegram_channels (
                id SERIAL PRIMARY KEY,
                channel_id VARCHAR(50) NOT NULL UNIQUE,
                channel_name VARCHAR(100) NOT NULL,
                total_signals INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                win_rate DECIMAL(5,2),
                avg_confidence_boost DECIMAL(5,4),
                is_active BOOLEAN DEFAULT TRUE,
                added_at TIMESTAMPTZ DEFAULT NOW(),
                last_signal_at TIMESTAMPTZ,
                metadata JSONB
            );
        """)
    log.info('Database tables ensured')


def save_signal_to_postgres(channel_id: str, channel_name: str, signal, raw_message: str):
    """Insert parsed signal into telegram_signals table."""
    try:
        conn = get_pg()
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO telegram_signals
                    (channel_id, channel_name, symbol, action,
                     entry_price, entry_price_high, stop_loss, tp1, tp2, tp3,
                     raw_message, parsed, outcome)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'PENDING')
            """, (
                channel_id, channel_name, signal.symbol, signal.action,
                signal.entry, signal.entry_high, signal.sl,
                signal.tp1, signal.tp2, signal.tp3,
                raw_message[:2000],  # Truncate very long messages
                True,
            ))
            # Update channel stats
            cur.execute("""
                INSERT INTO telegram_channels (channel_id, channel_name, total_signals, last_signal_at)
                VALUES (%s, %s, 1, NOW())
                ON CONFLICT (channel_id)
                DO UPDATE SET
                    total_signals = telegram_channels.total_signals + 1,
                    last_signal_at = NOW()
            """, (channel_id, channel_name))
    except Exception as e:
        log.error(f'Postgres save failed: {e}')


def save_unparsed_to_postgres(channel_id: str, channel_name: str, raw_message: str):
    """Log messages we couldn't parse (for parser improvement)."""
    try:
        conn = get_pg()
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO telegram_signals
                    (channel_id, channel_name, symbol, action, raw_message, parsed)
                VALUES (%s, %s, 'UNKNOWN', 'UNKNOWN', %s, FALSE)
            """, (channel_id, channel_name, raw_message[:2000]))
    except Exception as e:
        log.error(f'Postgres unparsed save failed: {e}')


# ─── Redis Signal Publishing ───────────────────────────────────────


def is_duplicate(r: redis_lib.Redis, channel_name: str, symbol: str, action: str) -> bool:
    """Check dedup key to prevent processing same signal twice."""
    key = f'telegram:dedup:{channel_name}:{symbol}:{action}'
    if r.exists(key):
        return True
    r.setex(key, DEDUP_TTL_SECONDS, '1')
    return False


def publish_to_redis(channel_name: str, signal):
    """Update Redis with active Telegram signal for auto-trade consumption."""
    try:
        r = get_redis()

        # Per-symbol key (quick lookup by auto-trade)
        sym_key = f'telegram:signal:{signal.symbol}'
        existing = r.get(sym_key)

        channels = [channel_name]
        if existing:
            try:
                data = json.loads(existing)
                existing_channels = data.get('channels', [])
                if channel_name not in existing_channels:
                    channels = existing_channels + [channel_name]
                else:
                    channels = existing_channels
            except json.JSONDecodeError:
                pass

        consensus = len(channels)
        delta = CONFIDENCE_DELTAS.get(min(consensus, 3), MAX_CONFIDENCE_DELTA)

        sym_data = {
            'action': signal.action,
            'channels': channels,
            'consensus': consensus,
            'confidence_delta': delta,
            'latest_at': datetime.now(timezone.utc).isoformat(),
            'entry': signal.entry,
            'sl': signal.sl,
            'tp1': signal.tp1,
        }
        r.setex(sym_key, SIGNAL_TTL_SECONDS, json.dumps(sym_data))

        # Aggregate active signals list (consumed by auto-trade)
        _update_active_signals(r)

        log.info(f'Redis published: {signal.symbol} {signal.action} '
                 f'({consensus} channel(s), delta={delta})')

    except Exception as e:
        log.error(f'Redis publish failed: {e}')


def _update_active_signals(r: redis_lib.Redis):
    """Rebuild the signals:telegram:active aggregate from per-symbol keys."""
    try:
        # Scan for all active telegram signal keys
        keys = list(r.scan_iter('telegram:signal:*'))
        signals = []
        for key in keys:
            raw = r.get(key)
            if not raw:
                continue
            try:
                data = json.loads(raw)
                # Extract symbol from key (telegram:signal:SOL/USDC -> SOL/USDC)
                symbol = key.replace('telegram:signal:', '')
                data['symbol'] = symbol
                signals.append(data)
            except json.JSONDecodeError:
                continue

        active_data = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'signals': signals,
            'boost_enabled': CONFIDENCE_BOOST_ENABLED,
        }
        r.setex('signals:telegram:active', SIGNAL_TTL_SECONDS, json.dumps(active_data))
    except Exception as e:
        log.error(f'Failed to update active signals: {e}')


# ─── Channel Quality Cache ──────────────────────────────────────────


def refresh_channel_quality():
    """Refresh channel quality metrics from Postgres to Redis (called hourly)."""
    try:
        conn = get_pg()
        r = get_redis()
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT channel_id, channel_name, total_signals, wins, losses,
                       win_rate, is_active
                FROM telegram_channels
            """)
            for row in cur.fetchall():
                quality = {
                    'win_rate': float(row['win_rate']) if row['win_rate'] else 0,
                    'total_signals': row['total_signals'] or 0,
                    'active': row['is_active'],
                }
                r.setex(
                    f"telegram:channel:{row['channel_id']}:quality",
                    3600,  # 1h TTL
                    json.dumps(quality),
                )
        log.info('Channel quality cache refreshed')
    except Exception as e:
        log.error(f'Channel quality refresh failed: {e}')


# ─── Telegram Client ────────────────────────────────────────────────

# Channel ID -> name mapping (populated at startup)
channel_map: dict[int, str] = {}


async def resolve_channels(client: TelegramClient):
    """Resolve channel usernames to IDs and build mapping."""
    for username in TELEGRAM_CHANNELS:
        try:
            entity = await client.get_entity(username)
            channel_map[entity.id] = username
            log.info(f'Resolved channel: {username} -> {entity.id}')
        except Exception as e:
            log.error(f'Failed to resolve channel {username}: {e}')

    if not channel_map:
        log.error('No channels resolved! Check TELEGRAM_CHANNELS config.')
        sys.exit(1)

    log.info(f'Monitoring {len(channel_map)} channels: {list(channel_map.values())}')


async def handle_message(event):
    """Process incoming message from monitored channel."""
    try:
        chat_id = event.chat_id
        channel_name = channel_map.get(chat_id, str(chat_id))
        text = event.message.text or ''

        if not text or len(text) < 5:
            return

        # Try to parse as signal
        signal = parse_signal(text)

        if signal is None:
            # Not a signal — only log if message looks potentially signal-like
            signal_hints = ['buy', 'sell', 'long', 'short', 'entry', 'tp', 'sl', 'target']
            if any(hint in text.lower() for hint in signal_hints):
                save_unparsed_to_postgres(str(chat_id), channel_name, text)
                log.debug(f'[{channel_name}] Unparsed potential signal: {text[:80]}...')
            return

        log.info(f'[{channel_name}] Parsed: {signal.action} {signal.symbol} '
                 f'@ {signal.entry} SL={signal.sl} TP1={signal.tp1}')

        # Dedup check
        r = get_redis()
        if is_duplicate(r, channel_name, signal.symbol, signal.action):
            log.info(f'[{channel_name}] Duplicate skipped: {signal.symbol} {signal.action}')
            return

        # Write to Postgres (always — historical log)
        save_signal_to_postgres(str(chat_id), channel_name, signal, text)

        # Write to Redis (for auto-trade consumption)
        publish_to_redis(channel_name, signal)

    except Exception as e:
        log.error(f'Message handler error: {e}', exc_info=True)


async def quality_refresh_loop():
    """Refresh channel quality cache every hour."""
    while True:
        await asyncio.sleep(3600)
        try:
            refresh_channel_quality()
        except Exception as e:
            log.error(f'Quality refresh loop error: {e}')


async def main():
    log.info('Starting Telegram Signal Scraper')
    log.info(f'Channels: {TELEGRAM_CHANNELS}')
    log.info(f'Confidence boost: {"ENABLED" if CONFIDENCE_BOOST_ENABLED else "DISABLED (log only)"}')
    log.info(f'Redis: {KV_URL}')

    # Verify connections
    try:
        r = get_redis()
        r.ping()
        log.info('Redis connected')
    except Exception as e:
        log.error(f'Redis connection failed: {e}')
        sys.exit(1)

    try:
        ensure_tables()
        log.info('Postgres connected')
    except Exception as e:
        log.error(f'Postgres connection failed: {e}')
        sys.exit(1)

    # Initialize Telegram client
    client = TelegramClient(
        StringSession(TELEGRAM_SESSION),
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH,
    )
    await client.start()
    me = await client.get_me()
    log.info(f'Telegram connected as: {me.first_name} (@{me.username})')

    # Resolve channels
    await resolve_channels(client)

    # Register event handler for monitored channels
    channel_ids = list(channel_map.keys())
    client.add_event_handler(handle_message, events.NewMessage(chats=channel_ids))
    log.info('Event handler registered — listening for signals...')

    # Initial quality cache refresh
    refresh_channel_quality()

    # Start background quality refresh loop
    asyncio.create_task(quality_refresh_loop())

    # Keep running
    await client.run_until_disconnected()


if __name__ == '__main__':
    asyncio.run(main())
