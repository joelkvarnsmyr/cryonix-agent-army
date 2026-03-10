"""
Timing Utilities - Market-Validated ETA Calculation
Provides logic to estimate time-to-target based on market physics (ATR, ADX, Volume).
"""

def calculate_market_eta(entry_price: float, target_price: float, indicators: dict) -> int:
    """
    Calculates a validated ETA in minutes based on ATR, ADX, and Volume.
    
    Factors:
    - Base: (Distance % / ATR %) * 15 min
    - Trend (ADX): Strong trends accelerate arrival.
    - Volume: High volume increases price velocity.
    - RSI: Momentum direction (slope).
    """
    try:
        atr_pct = indicators.get('atr_percent', indicators.get('atr_pct', 1.0))
        if not entry_price or not target_price or atr_pct <= 0:
            return 60 # Default fallback
            
        distance_pct = abs(target_price - entry_price) / entry_price * 100
        
        # Base minutes (ATR represents 15m volatility)
        base_eta_mins = (distance_pct / max(0.1, atr_pct)) * 15
        
        # Validation Factors
        intensity_multiplier = 1.0
        
        # ADX Factor: Stronger trend = faster arrival
        adx = indicators.get('adx', 0)
        if adx > 30: intensity_multiplier *= 0.75
        elif adx > 25: intensity_multiplier *= 0.85
        elif adx < 15: intensity_multiplier *= 1.30 # Weak trend takes longer
        
        # Volume Factor: High volume = higher velocity
        vol_ratio = indicators.get('volume_ratio', 1.0)
        if vol_ratio > 2.0: intensity_multiplier *= 0.80
        elif vol_ratio > 1.5: intensity_multiplier *= 0.90
        elif vol_ratio < 0.8: intensity_multiplier *= 1.20 # Low interest = slow
        
        # RSI Direction Factor (Slope)
        rsi = indicators.get('rsi', 50)
        if rsi < 45: intensity_multiplier *= 0.90
        
        validated_eta_mins = round(base_eta_mins * intensity_multiplier)
        
        # Ensure sane limits (5 min to 12 hours)
        return max(5, min(720, validated_eta_mins))
        
    except Exception as e:
        print(f"[TimingUtils] Error calculating ETA: {e}")
        return 60
