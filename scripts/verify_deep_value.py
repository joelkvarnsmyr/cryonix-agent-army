
import sys
import os
import pandas as pd
import numpy as np
from datetime import datetime, timedelta

# Add engine path to sys.path
sys.path.append(os.path.abspath('packages/engine'))

try:
    from src.guilds.quant import QuantGuild
except ImportError:
    # Try alternate path if running from root
    sys.path.append(os.path.abspath('.'))
    from packages.engine.src.guilds.quant import QuantGuild

def generate_crash_data(drop_pct=0.10, volume_mult=4.0):
    """Generate OHLCV data simulating a crash"""
    end_time = datetime.now()
    data = []
    
    # Base price (start high to allow drop)
    price = 1000.0
    
    # Generate 50 normal candles
    # Each candle: [timestamp, open, high, low, close, volume]
    for i in range(50):
        # Timestamp in ms
        timestamp = (end_time - timedelta(minutes=15 * (70 - i))).timestamp() * 1000
        open_p = price
        # Small random walk
        change = np.random.uniform(-0.002, 0.002)
        close_p = price * (1 + change)
        high_p = max(open_p, close_p) * 1.001
        low_p = min(open_p, close_p) * 0.999
        vol = 1000 * np.random.uniform(0.8, 1.2)
        data.append([timestamp, open_p, high_p, low_p, close_p, vol])
        price = close_p

    # Record "high water mark" before crash
    high_water_mark = price
    
    # Generate Crash - straight down
    # Target low price
    target_low = high_water_mark * (1 - drop_pct)
    
    # 3 big red candles
    crash_candles = 3
    drop_per_candle = (high_water_mark - target_low) / crash_candles
    
    for i in range(crash_candles):
        timestamp = (end_time - timedelta(minutes=15 * (20 - 50 - i))).timestamp() * 1000
        open_p = price
        close_p = price - drop_per_candle
        high_p = open_p
        low_p = close_p
        vol = 1000 * volume_mult # Capitulation volume
        data.append([timestamp, open_p, high_p, low_p, close_p, vol])
        price = close_p

    return data

def test_deep_value():
    print("Testing Deep Value Detection...")
    quant = QuantGuild()
    
    # 1. Test Crash (10% drop, 4x volume)
    print("\n--- Scenario 1: 10% Fast Crash with Volume ---")
    data = generate_crash_data(drop_pct=0.10, volume_mult=4.0)
    
    df = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
    
    # Calculate indicators
    indicators = quant._calculate_indicators(df)
    
    # Manually check pre-conditions for debug
    close = df['close']
    high_20 = close.rolling(20).max().iloc[-1]
    current = close.iloc[-1]
    drawdown = (high_20 - current) / high_20
    print(f"  Simulated Drawdown: {drawdown:.2%}")
    print(f"  RSI: {indicators['rsi']:.1f}")

    # Run detection
    result = quant._detect_deep_value(df, indicators, multi_tf_data=None)
    
    if result:
        print("[PASS] Deep Value Detected!")
        print(f"  Confidence: {result['confidence']}")
        print(f"  Reason: {result['reason']}")
        metrics = result['deep_value_metrics']
        print(f"  Metrics: Vel={metrics['drop_velocity']:.1f}%/h, Vol={metrics['volume_ratio']:.1f}x")
    else:
        print("❌ Deep Value NOT Detected")

    # 2. Test Normal Market
    print("\n--- Scenario 2: Normal Market (1% drift) ---")
    data_normal = generate_crash_data(drop_pct=0.01, volume_mult=1.0)
    df_normal = pd.DataFrame(data_normal, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df_normal['timestamp'] = pd.to_datetime(df_normal['timestamp'], unit='ms')
    indicators_normal = quant._calculate_indicators(df_normal)
    
    result_normal = quant._detect_deep_value(df_normal, indicators_normal)
    
    if result_normal is None:
        print("[PASS] Correctly ignored normal market")
    else:
        print(f"[FAIL] False positive detected: {result_normal}")

if __name__ == "__main__":
    test_deep_value()
