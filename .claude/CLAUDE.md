# Session Preferences

- Commit messages: conventional commits (feat/fix/docs/refactor), English
- Code comments: English only
- User communication: Swedish (user's preferred language)
- Always read CLAUDE.md in repo root for full project context
- Before changing cryonix.toml: check current values, make small incremental changes
- **DEPLOY RULE (CRITICAL):** NEVER run `docker compose build` directly via SSH. Always use the safe deploy script: `bash scripts/deploy/safe-deploy.sh <service>`. This script uses flock to prevent concurrent builds on the VM (4GB RAM, 29GB disk). Multiple agents building simultaneously WILL crash the Docker daemon. The script queues builds — if another agent is building, yours will wait up to 10 minutes for the lock.
- For code-only push (no build): `git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"`
- NEVER run `docker system prune`, `docker image prune`, or delete containers on the VM — other agents' services may be affected
- Database changes: update schema.ts + run SQL directly on prod via `docker exec cryonix-postgres-1 psql -U postgres -d cryonix`
- Redis inspection: `docker exec cryonix-redis-1 redis-cli`
- Production logs: `docker logs cryonix-<service>-1 --tail 50`
