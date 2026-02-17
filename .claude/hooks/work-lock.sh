#\!/bin/bash
# Keep work lock alive whenever Claude Code uses any tool.
# Prevents auto-deploy.sh from deploying while we're working.
touch /tmp/cryonix-work.lock
exit 0
