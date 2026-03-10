"""Tests for on-chain alert writing logic in x_sentiment.py"""
import json
import sys
import os
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Import the functions we'll test
# We test write_to_redis in isolation by passing a mock Redis client


def make_redis_mock():
    r = MagicMock()
    r.calls = {}
    def setex_side_effect(key, ttl, value):
        r.calls[key] = {'ttl': ttl, 'value': value}
    r.setex.side_effect = setex_side_effect
    r.set.side_effect = lambda key, value, ex=None: None
    r.get = MagicMock(return_value=None)
    return r


def test_onchain_alert_writes_json():
    """When onchain_alert present, sentiment:alert:{SYMBOL} should be JSON with severity."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'BTC': {
            'score': 1,
            'volume': 'high',
            'narrative': 'all good',
            'alert': None,
            'onchain_alert': {
                'severity': 'warning',
                'reason': 'Large exchange deposits detected',
                'source': '@lookonchain',
            }
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    assert 'sentiment:alert:BTC' in r.calls
    payload = json.loads(r.calls['sentiment:alert:BTC']['value'])
    assert payload['severity'] == 'warning'
    assert payload['reason'] == 'Large exchange deposits detected'
    assert payload['source'] == '@lookonchain'
    assert 'detected_at' in payload
    # TTL should be ONCHAIN_ALERT_TTL (3600)
    assert r.calls['sentiment:alert:BTC']['ttl'] == 3600


def test_critical_onchain_alert_writes_json():
    """Critical severity is stored correctly."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'ETH': {
            'score': -3,
            'volume': 'high',
            'narrative': 'protocol hacked',
            'alert': 'hack reported',
            'onchain_alert': {
                'severity': 'critical',
                'reason': 'Exploit draining funds',
                'source': '@rektfeed',
            }
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    payload = json.loads(r.calls['sentiment:alert:ETH']['value'])
    assert payload['severity'] == 'critical'


def test_plain_alert_writes_string_when_no_onchain():
    """When no onchain_alert, plain alert string is written (backward compat)."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'SOL': {
            'score': -1,
            'volume': 'medium',
            'narrative': 'some FUD',
            'alert': 'hack reported',
            'onchain_alert': None,
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    assert 'sentiment:alert:SOL' in r.calls
    # Should be plain string, not JSON
    value = r.calls['sentiment:alert:SOL']['value']
    assert value == 'hack reported'


def test_no_alert_writes_nothing():
    """When no alert and no onchain_alert, sentiment:alert key is not written."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    sentiment_data = {
        'BTC': {
            'score': 2,
            'volume': 'high',
            'narrative': 'all good',
            'alert': None,
            'onchain_alert': None,
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    assert 'sentiment:alert:BTC' not in r.calls


def test_onchain_alert_idempotent_same_severity():
    """If same severity already exists in Redis, do not overwrite (idempotent)."""
    from x_sentiment import write_to_redis
    r = make_redis_mock()
    existing_payload = json.dumps({
        'severity': 'warning',
        'reason': 'Old reason',
        'source': '@old',
        'detected_at': '2026-03-10T00:00:00+00:00',
    })
    r.get = MagicMock(return_value=existing_payload)
    sentiment_data = {
        'BTC': {
            'score': 0,
            'volume': 'low',
            'narrative': 'neutral',
            'alert': None,
            'onchain_alert': {
                'severity': 'warning',
                'reason': 'New reason',
                'source': '@new',
            }
        }
    }
    write_to_redis(r, sentiment_data, 'grok-3-mini', 100)
    # setex should NOT have been called — same severity already in Redis
    assert 'sentiment:alert:BTC' not in r.calls
