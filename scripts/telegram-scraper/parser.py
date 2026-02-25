"""
Multi-format Telegram signal parser.

Parses BUY/SELL signals from various Telegram channel formats:
1. Cornix format: "BUY SOL/USDT\nEntry: $88.50 - $89.20\nTP1: $91.00\nSL: $86.80"
2. Simple: "BUY SOL @ 88.5, SL 86.8, TP 91.0"
3. Alert style: "SOL Long Entry 88.50"
4. Emoji-driven: green emoji = buy, red emoji = sell

Returns None if unparseable (not all messages are signals).
"""

import re
from dataclasses import dataclass
from typing import Optional

# Pairs we trade on Cryonix (USDC base)
KNOWN_SYMBOLS = {
    'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT', 'MATIC',
    'LINK', 'UNI', 'ATOM', 'NEAR', 'ARB', 'OP', 'DOGE', 'SHIB', 'PEPE',
    'SUI', 'APT', 'INJ', 'TIA', 'SEI', 'FET', 'RNDR', 'WLD', 'JUP',
    'PYTH', 'WIF', 'BONK', 'FIL', 'LTC', 'BCH', 'ETC', 'ALGO',
    'HBAR', 'VET', 'FTM', 'SAND', 'MANA', 'AAVE', 'MKR', 'CRV',
}

# Symbol aliases (normalize to our format)
SYMBOL_ALIASES = {
    'SOLANA': 'SOL', 'BITCOIN': 'BTC', 'ETHEREUM': 'ETH',
    'POLYGON': 'MATIC', 'POLKADOT': 'DOT', 'CARDANO': 'ADA',
    'AVALANCHE': 'AVAX', 'CHAINLINK': 'LINK', 'UNISWAP': 'UNI',
    'COSMOS': 'ATOM', 'ARBITRUM': 'ARB', 'OPTIMISM': 'OP',
    'DOGECOIN': 'DOGE', 'FILECOIN': 'FIL', 'LITECOIN': 'LTC',
    'FANTOM': 'FTM',
}


@dataclass
class ParsedSignal:
    symbol: str           # Normalized: "SOL/USDC"
    action: str           # "BUY" or "SELL"
    entry: Optional[float] = None
    entry_high: Optional[float] = None   # Upper bound of entry range
    sl: Optional[float] = None
    tp1: Optional[float] = None
    tp2: Optional[float] = None
    tp3: Optional[float] = None


def normalize_symbol(raw: str) -> Optional[str]:
    """Normalize symbol variants to our SYMBOL/USDC format."""
    raw = raw.upper().strip()
    # Remove quote currency suffixes
    for suffix in ('/USDT', '/USDC', '/USD', '/BUSD', 'USDT', 'USDC', 'USD', 'BUSD', 'PERP'):
        raw = raw.replace(suffix, '')
    raw = raw.strip('/ ')
    # Check aliases
    if raw in SYMBOL_ALIASES:
        raw = SYMBOL_ALIASES[raw]
    if raw in KNOWN_SYMBOLS:
        return f"{raw}/USDC"
    return None


def _extract_price(text: str) -> Optional[float]:
    """Extract a single price from text like '$88.50' or '88.50'.
    If text contains a colon, extract from after the colon to avoid
    matching numbers in labels like 'TP1:' or 'Target 2:'."""
    # Use text after colon if present (avoids matching label numbers)
    colon_idx = text.find(':')
    search_text = text[colon_idx + 1:] if colon_idx >= 0 else text
    m = re.search(r'\$?([\d,]+\.?\d*)', search_text)
    if m:
        return float(m.group(1).replace(',', ''))
    return None


def _extract_price_range(text: str) -> tuple[Optional[float], Optional[float]]:
    """Extract price range like '$88.50 - $89.20' or single price."""
    prices = re.findall(r'\$?([\d,]+\.?\d+)', text)
    prices = [float(p.replace(',', '')) for p in prices]
    if len(prices) >= 2:
        return prices[0], prices[1]
    if len(prices) == 1:
        return prices[0], None
    return None, None


def parse_cornix_format(text: str) -> Optional[ParsedSignal]:
    """
    Parse Cornix-style signals:
    BUY SOL/USDT
    Entry: $88.50 - $89.20
    TP1: $91.00
    TP2: $93.00
    SL: $86.80
    """
    lines = text.strip().split('\n')
    action = None
    symbol = None

    # Find action + symbol in first few lines
    skip_words = {'BUY', 'SELL', 'LONG', 'SHORT', 'ENTRY', 'TARGET', 'STOP', 'LOSS', 'TAKE', 'PROFIT'}
    for line in lines[:4]:
        line_clean = re.sub(r'[^\w\s/$@.\-]', '', line).strip()
        if re.search(r'\b(BUY|LONG)\b', line_clean, re.I):
            action = 'BUY'
        elif re.search(r'\b(SELL|SHORT)\b', line_clean, re.I):
            action = 'SELL'
        # Find symbol (skip action keywords)
        if not symbol:
            for sym_match in re.finditer(r'([A-Z]{2,10})(?:/(?:USDT|USDC|USD|BUSD))?', line_clean):
                candidate = sym_match.group(1)
                if candidate in skip_words:
                    continue
                sym = normalize_symbol(candidate)
                if sym:
                    symbol = sym
                    break

    if not action or not symbol:
        return None

    entry, entry_high, sl, tp1, tp2, tp3 = None, None, None, None, None, None

    for line in lines:
        line_lower = line.lower().strip()
        if re.match(r'entry', line_lower) or re.match(r'buy\s*(zone|price|range)', line_lower):
            entry, entry_high = _extract_price_range(line)
        elif re.match(r'(sl|stop\s*loss|stoploss)', line_lower):
            sl = _extract_price(line)
        elif re.match(r'tp\s*1|target\s*1|take\s*profit\s*1', line_lower):
            tp1 = _extract_price(line)
        elif re.match(r'tp\s*2|target\s*2|take\s*profit\s*2', line_lower):
            tp2 = _extract_price(line)
        elif re.match(r'tp\s*3|target\s*3|take\s*profit\s*3', line_lower):
            tp3 = _extract_price(line)

    if entry is None:
        return None

    return ParsedSignal(
        symbol=symbol, action=action,
        entry=entry, entry_high=entry_high,
        sl=sl, tp1=tp1, tp2=tp2, tp3=tp3,
    )


def parse_simple_format(text: str) -> Optional[ParsedSignal]:
    """
    Parse simple inline signals:
    "BUY SOL @ 88.5, SL 86.8, TP 91.0"
    "SELL ETH 2050, stop 2100, target 1950"
    """
    text_upper = text.upper()

    # Detect action
    action = None
    if re.search(r'\b(BUY|LONG|LONGING)\b', text_upper):
        action = 'BUY'
    elif re.search(r'\b(SELL|SHORT|SHORTING)\b', text_upper):
        action = 'SELL'
    if not action:
        return None

    # Find symbol
    symbol = None
    for sym_match in re.finditer(r'\b([A-Z]{2,10})\b', text_upper):
        candidate = sym_match.group(1)
        if candidate in ('BUY', 'SELL', 'LONG', 'SHORT', 'LONGING', 'SHORTING',
                         'USDT', 'USDC', 'USD', 'SL', 'TP', 'ENTRY', 'TARGET',
                         'STOP', 'LOSS', 'TAKE', 'PROFIT', 'AT', 'THE'):
            continue
        sym = normalize_symbol(candidate)
        if sym:
            symbol = sym
            break

    if not symbol:
        return None

    # Extract prices
    entry = None
    sl = None
    tp1 = None

    # Entry: after @ or after symbol
    entry_match = re.search(r'@\s*\$?([\d,]+\.?\d*)', text)
    if entry_match:
        entry = float(entry_match.group(1).replace(',', ''))
    else:
        # Price right after action+symbol
        after_sym = re.search(r'(?:BUY|SELL|LONG|SHORT)\s+\w+\s+\$?([\d,]+\.?\d+)', text, re.I)
        if after_sym:
            entry = float(after_sym.group(1).replace(',', ''))

    # SL
    sl_match = re.search(r'(?:SL|stop\s*loss?|stop)\s*:?\s*\$?([\d,]+\.?\d+)', text, re.I)
    if sl_match:
        sl = float(sl_match.group(1).replace(',', ''))

    # TP
    tp_match = re.search(r'(?:TP|target|take\s*profit)\s*:?\s*\$?([\d,]+\.?\d+)', text, re.I)
    if tp_match:
        tp1 = float(tp_match.group(1).replace(',', ''))

    if entry is None:
        return None

    return ParsedSignal(
        symbol=symbol, action=action,
        entry=entry, sl=sl, tp1=tp1,
    )


def parse_sentiment_format(text: str) -> Optional[ParsedSignal]:
    """
    Parse sentiment/analysis-style messages common in free channels.
    Handles formats like:
    - "$ETH breakout the triangle. Looks bullish here."
    - "**$BTC** Price swept equal lows, bouncing back"
    - "$DEXE 🔥 Pumped 11.84%"
    """
    BULLISH_KEYWORDS = {
        'bullish', 'breakout', 'bounce', 'bouncing', 'pump', 'pumped', 'pumping',
        'rally', 'moon', 'accumulate', 'accumulation', 'oversold',
        'bullrun', 'reversal', 'recovery', 'uptrend', 'ascending',
    }
    BEARISH_KEYWORDS = {
        'bearish', 'breakdown', 'dump', 'dumped', 'dumping', 'crash',
        'falling', 'overbought', 'decline', 'descending',
        'rejection', 'selloff', 'downtrend',
    }
    BULLISH_EMOJIS = {'\U0001f525', '\U0001f680', '\U0001f4c8', '\U0001f49a', '\u2705', '\U0001f7e2', '\U0001f7e9', '\U0001f4aa', '\U0001f91d'}
    BEARISH_EMOJIS = {'\U0001f4c9', '\U0001f534', '\U0001f7e5', '\u274c', '\u26a0\ufe0f', '\U0001f494'}

    # Extract symbol from $SYMBOL or **$SYMBOL** format
    symbol = None
    sym_match = re.search(r'\*{0,2}\$([A-Za-z]{2,10})\*{0,2}', text)
    if sym_match:
        sym = normalize_symbol(sym_match.group(1))
        if sym:
            symbol = sym

    # Also try #SYMBOL/USDT format
    if not symbol:
        sym_match = re.search(r'#([A-Za-z]{2,10})/(?:USDT|USDC|USD)', text, re.I)
        if sym_match:
            sym = normalize_symbol(sym_match.group(1))
            if sym:
                symbol = sym

    if not symbol:
        return None

    # Detect sentiment
    text_lower = text.lower()
    words = set(re.findall(r'[a-z]+', text_lower))

    bullish_score = len(words & BULLISH_KEYWORDS)
    bearish_score = len(words & BEARISH_KEYWORDS)

    # Count emoji sentiment
    for e in BULLISH_EMOJIS:
        if e in text:
            bullish_score += 1
    for e in BEARISH_EMOJIS:
        if e in text:
            bearish_score += 1

    # Need at least 1 indicator and clear direction
    if bullish_score == 0 and bearish_score == 0:
        return None
    if bullish_score == bearish_score:
        return None

    action = 'BUY' if bullish_score > bearish_score else 'SELL'

    return ParsedSignal(
        symbol=symbol, action=action,
        entry=None, sl=None, tp1=None,
    )


def parse_emoji_format(text: str) -> Optional[ParsedSignal]:
    """
    Parse emoji-driven signals where green = buy, red = sell.
    """
    buy_emojis = {'🟢', '🟩', '🚀', '💚', '✅', '📈'}
    sell_emojis = {'🔴', '🟥', '❌', '📉', '💔'}

    action = None
    for e in buy_emojis:
        if e in text:
            action = 'BUY'
            break
    if not action:
        for e in sell_emojis:
            if e in text:
                action = 'SELL'
                break

    if not action:
        return None

    # Find symbol
    symbol = None
    for sym_match in re.finditer(r'([A-Z]{2,10})(?:/(?:USDT|USDC|USD))?', text.upper()):
        sym = normalize_symbol(sym_match.group(1))
        if sym:
            symbol = sym
            break

    if not symbol:
        return None

    # Try to extract prices
    prices = re.findall(r'\$?([\d,]+\.?\d+)', text)
    prices = [float(p.replace(',', '')) for p in prices]

    entry = prices[0] if len(prices) >= 1 else None
    sl = None
    tp1 = None

    # If we have multiple prices, try to identify SL/TP by context
    if len(prices) >= 2:
        sl_match = re.search(r'(?:SL|stop)\s*:?\s*\$?([\d,]+\.?\d+)', text, re.I)
        tp_match = re.search(r'(?:TP|target)\s*:?\s*\$?([\d,]+\.?\d+)', text, re.I)
        if sl_match:
            sl = float(sl_match.group(1).replace(',', ''))
        if tp_match:
            tp1 = float(tp_match.group(1).replace(',', ''))

    return ParsedSignal(
        symbol=symbol, action=action,
        entry=entry, sl=sl, tp1=tp1,
    )


def parse_signal(text: str) -> Optional[ParsedSignal]:
    """
    Try all parsers in order of specificity.
    Returns ParsedSignal or None if message isn't a trading signal.
    """
    if not text or len(text) < 5:
        return None

    # Skip obvious non-signals
    text_lower = text.lower()
    skip_keywords = ['welcome', 'join', 'subscribe', 'disclaimer', 'not financial advice',
                     'follow us', 'admin', 'pinned', 'giveaway', 'airdrop',
                     'vip plan', 'vip pricing']
    if any(kw in text_lower for kw in skip_keywords):
        return None

    # Skip Cornix TP/SL hit notifications (not new signals)
    if re.search(r'take.profit\s+target\s+\d+\s*[✅✓]', text_lower):
        return None
    if re.search(r'stop.loss\s+triggered', text_lower):
        return None

    # Try parsers in order: most structured first
    result = parse_cornix_format(text)
    if result:
        return result

    result = parse_simple_format(text)
    if result:
        return result

    result = parse_sentiment_format(text)
    if result:
        return result

    result = parse_emoji_format(text)
    if result:
        return result

    return None
