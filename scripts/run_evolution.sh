#!/bin/bash

# Navigate to project directory
cd /opt/cryonix-agent-army || exit 1

# Logging
LOG_FILE="evolution.log"
echo "[INFO] Starting Evolution Cycle at $(date)" >> "$LOG_FILE"

# Load environment variables (if stored in .env)
if [ -f .env ]; then
  export $(cat .env | xargs)
fi

# Run the evolver
# Assumes 'python3' and 'claude' are in the PATH
# If claude is installed via npm globally:
export PATH=$PATH:/usr/local/bin:/root/.npm-global/bin

python3 scripts/evolve.py >> "$LOG_FILE" 2>&1

echo "[INFO] Completed at $(date)" >> "$LOG_FILE"
echo "--------------------------------------------" >> "$LOG_FILE"
