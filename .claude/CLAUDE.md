# Session Preferences

- Commit messages: conventional commits (feat/fix/docs/refactor), English
- Code comments: English only
- User communication: Swedish (user's preferred language)
- Always read CLAUDE.md in repo root for full project context
- Before changing cryonix.toml: check current values, make small incremental changes
- Before deploying: `docker compose -f docker-compose.prod.yml build <service> && docker compose -f docker-compose.prod.yml up -d <service>`
- Database changes: update schema.ts + run SQL directly on prod via `docker exec cryonix-postgres-1 psql -U postgres -d cryonix`
- Redis inspection: `docker exec cryonix-redis-1 redis-cli`
- Production logs: `docker logs cryonix-<service>-1 --tail 50`
