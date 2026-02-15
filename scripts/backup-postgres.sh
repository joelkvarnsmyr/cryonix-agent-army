#!/bin/bash
# Daily Postgres backup — keeps 7 days of rotating backups
BACKUP_DIR="/home/azureuser/cryonix/backups"
CONTAINER="cryonix-postgres-1"
DATE=$(date +%Y-%m-%d)

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Starting Postgres backup..."

docker exec "$CONTAINER" pg_dump -U postgres cryonix --no-owner --no-acl | gzip > "$BACKUP_DIR/cryonix-$DATE.sql.gz"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "$BACKUP_DIR/cryonix-$DATE.sql.gz" | cut -f1)
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Backup OK: cryonix-$DATE.sql.gz ($SIZE)"

  # Remove backups older than 7 days
  find "$BACKUP_DIR" -name "cryonix-*.sql.gz" -mtime +7 -delete
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Old backups cleaned."
else
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] ERROR: Backup failed!"
  exit 1
fi
