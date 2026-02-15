
import os
import sys
import subprocess
import json
import psycopg2
from datetime import datetime, timedelta
from dotenv import load_dotenv

# Load .env file
load_dotenv()

# Configuration
# Fetch DB URL from ENV or default to localhost
DB_URL = os.environ.get("POSTGRES_URL", "postgresql://postgres:password@localhost:5432/cryonix")
CLAUDE_CLI = "claude" # Assumes 'claude' is in PATH. on Windows might need full path if not in global env.
PROMPT_FILE = "scripts/prompts/evolution_prompt.txt"
# These scripts guard the logic. If any fails, mutation is rejected.
VERIFY_SCRIPTS = [
    "scripts/verify_deep_value.py", 
    "scripts/verify_grid.py"
]

def get_performance_data():
    """Fetch trading performance from the last 24 hours."""
    try:
        conn = psycopg2.connect(DB_URL)
        cur = conn.cursor()
        
        # Query: Aggregate PnL by pattern to find weak spots
        query = """
            SELECT 
                pattern, 
                COUNT(*) as trade_count, 
                SUM(pnl_usd) as total_pnl, 
                AVG(pnl_pct) as avg_roi 
            FROM trades 
            WHERE status = 'CLOSED' 
            AND closed_at > NOW() - INTERVAL '24 hours'
            GROUP BY pattern
            ORDER BY total_pnl ASC; 
        """
        cur.execute(query)
        rows = cur.fetchall()
        conn.close()
        
        report = "Performance Report (Last 24h):\n"
        if not rows:
            report += "No closed trades found."
        else:
            for row in rows:
                report += f"Pattern: {row[0]} | Trades: {row[1]} | PnL: ${row[2]:.2f} | Avg ROI: {row[3]:.2f}%\n"
            
        return report
    except Exception as e:
        print(f"Database error: {e}")
        # Fallback for testing/dry-run without DB connectivity
        return "Performance Report: [DB CONNECTION FAILED] Simulated data: DEEP_VALUE lost 4% yesterday."

def run_evolution_cycle(dry_run=False):
    print("[INFO] Starting Evolution Cycle...")
    
    # 1. Analyze
    perf_data = get_performance_data()
    print(f"[INFO] Analysis:\n{perf_data}")
    
    # Simple Heuristic: If we don't have losses, maybe don't evolve?
    # For now, let's always proceed if data exists.
    
    # 2. Construct Prompt
    # Read the template
    try:
        with open(PROMPT_FILE, "r") as f:
            template = f.read()
    except FileNotFoundError:
        print(f"Prompt file not found: {PROMPT_FILE}")
        return

    prompt = template.replace("{performance_data}", perf_data)
    
    # 3. Mutate (Call Claude)
    print("[INFO] Calling Claude Code for mutation...")
    
    if dry_run:
        print(f"\n[Dry Run] Would send the following prompt to Claude:\n{'-'*40}\n{prompt[:300]}...\n{'-'*40}")
        # Simulate a successful edit by doing nothing
    else:
        # Construct the command. 
        # Using -p for prompt. Claude Code 2.x CLI usually supports this.
        # "claude" command must be available in the shell path.
        cmd = [CLAUDE_CLI, "-p", prompt]
        
        try:
            # We use shell=True on Windows to find the executable easier if it's a batch file/cmd
            # But subprocess.run with list is safer. Let's try shell=True for 'claude'.
            print(f"Executing: {' '.join(cmd)}")
            # Note: Interactive tools like Claude might hang if they wait for confirmation.
            # We assume Claude CLI is configured to run non-interactively or we might need to pipe 'y'
            # For now, let's assume it runs.
            result = subprocess.run(cmd, capture_output=True, text=True, shell=True) 
            
            print(f"Claude Output: {result.stdout}")
            if result.returncode != 0:
                print(f"Claude failed: {result.stderr}")
                return
        except Exception as e:
            print(f"Failed to run Claude CLI: {e}")
            return

    # 4. Verify
    print("[INFO] Verifying mutation...")
    all_passed = True
    
    # 4a. Logic Tests (Python)
    for script in VERIFY_SCRIPTS:
        print(f"   Running {script}...")
        # Use simple os.system or subprocess
        if not dry_run:
             # Use the same python interpreter
            res = subprocess.run([sys.executable, script], capture_output=True, text=True)
            if res.returncode != 0:
                print(f"[FAIL] {script} FAILED.\nOutput:\n{res.stdout}\n{res.stderr}")
                all_passed = False
            else:
                print(f"[PASS] {script} PASSED.")
        else:
            print(f"   [Dry Run] would run {script}")

    # 4b. Build (TypeScript)
    # This is heavy, maybe skip if Python tests failed? 
    if all_passed:
        print("   Running Web Build (pnpm build)...")
        if not dry_run:
            # Use shell=True for pnpm on Windows
            build_res = subprocess.run("cd apps/web && pnpm build", shell=True, capture_output=True, text=True)
            if build_res.returncode != 0:
                print(f"[FAIL] Build FAILED.\nOutput:\n{build_res.stdout}\n{build_res.stderr}")
                all_passed = False
            else:
                print("[PASS] Build PASSED.")
        else:
            print("   [Dry Run] would run 'pnpm build'")
        
    # 5. Selection
    if all_passed:
        print("[SUCCESS] Mutation SURVIVED selection.")
        if not dry_run:
            subprocess.run(["git", "add", "."])
            subprocess.run(["git", "commit", "-m", "[Auto-Evolution] logic improvement"])
            print("git commit executed.")
            # Optional: Restart services
            # subprocess.run(["pm2", "restart", "all"], shell=True)
    else:
        print("[FAIL] Mutation DIED. Reverting...")
        if not dry_run:
            subprocess.run(["git", "reset", "--hard"])
            print("git reset executed.")

if __name__ == "__main__":
    # Simple argument parsing
    is_dry = "--dry-run" in sys.argv
    run_evolution_cycle(dry_run=is_dry)
