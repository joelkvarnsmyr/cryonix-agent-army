
import sys
import os
import asyncio
import json
from datetime import datetime, timedelta

# Add engine path
sys.path.append(os.path.abspath('packages/engine'))

try:
    from src.guilds.grid import GridGuild, GridConfig, GridLevel
except ImportError:
    sys.path.append(os.path.abspath('.'))
    from packages.engine.src.guilds.grid import GridGuild, GridConfig, GridLevel

# Mock Redis
class MockRedis:
    def __init__(self):
        self.data = {}
        
    async def get(self, key):
        return self.data.get(key)
        
    async def set(self, key, value):
        self.data[key] = value
        
    async def get_active_grids(self):
        raw = self.data.get('grid:active')
        return json.loads(raw) if raw else []

async def test_grid_logic():
    print("Testing Grid Logic...")
    redis = MockRedis()
    guild = GridGuild(redis)
    
    symbol = "BTC/USDC"
    
    # 1. Setup Grid Config
    config = {
        "symbol": symbol,
        "lowerBound": 90000, # Range 90k-100k
        "upperBound": 100000,
        "buyLevels": [98000, 96000, 94000],
        "tpTargets": [99000, 97000, 95000],
        "orderSizeUsd": 100,
        "status": "active",
        "filledLevels": [],
        "createdAt": datetime.now().isoformat(),
        "expiresAt": (datetime.now() + timedelta(hours=24)).isoformat()
    }
    
    await redis.set(f'grid:config:{symbol}', json.dumps(config))
    await redis.set('grid:active', json.dumps([symbol]))
    
    # 2. Test Trigger (Price hits level #0 at 98000)
    print("\n--- Scenario 1: Price hits Level #0 (98000) ---")
    # Current price 98050 (close enough? 0.15% = 147. 98000+147 = 98147. So 98050 should trigger)
    current_price = 98050 
    
    result = await guild.check_grid_triggers(symbol, current_price)
    
    if result:
        print(f"[PASS] Triggered! Action: {result['action']} @ ${result['entry_price']}")
        print(f"  Reason: {result['reason']}")
        assert result['action'] == 'BUY'
        assert result['is_grid_buy'] == True
        assert result['indicators']['grid_level'] == 0
    else:
        print("[FAIL] Failed to trigger")

    # 3. Test Miss (Price too high)
    print("\n--- Scenario 2: Price too high (99000) ---")
    result_miss = await guild.check_grid_triggers(symbol, 99000)
    if result_miss is None:
        print("[PASS] Correctly ignored high price")
    else:
        print(f"[FAIL] False trigger: {result_miss}")
        
    # 4. Test Stop Loss (Price drops below lower bound 90000)
    print("\n--- Scenario 3: Stop Loss / Cancel (Price 85000) ---")
    result_sl = await guild.check_grid_triggers(symbol, 85000)
    
    # Needs to check if config status changed to cancelled which happens inside check_grid_triggers
    # But check_grid_triggers returns None on cancel
    if result_sl is None:
        # Verify status in redis
        updated_config_raw = await redis.get(f'grid:config:{symbol}')
        updated_config = json.loads(updated_config_raw)
        if updated_config['status'] == 'cancelled':
             print("[PASS] Grid cancelled due to price drop")
        else:
             print(f"[FAIL] Grid NOT cancelled. Status: {updated_config['status']}")
    else:
        print(f"[FAIL] Unexpected signal: {result_sl}")

if __name__ == "__main__":
    asyncio.run(test_grid_logic())
