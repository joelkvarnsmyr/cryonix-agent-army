"""Shared database connections for Strategy Lab scripts."""
import os
import psycopg2
import redis as redis_lib
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', '.env'))


def get_pg():
    """Get a Postgres connection. Caller must close."""
    url = os.environ.get('POSTGRES_URL')
    if not url:
        password = os.environ.get('POSTGRES_PASSWORD', 'password')
        url = f'postgresql://postgres:{password}@localhost:5432/cryonix'
    return psycopg2.connect(url)


def get_redis():
    """Get a Redis connection. Caller must close."""
    url = os.environ.get('KV_URL', 'redis://localhost:6379')
    return redis_lib.from_url(url, decode_responses=True)
