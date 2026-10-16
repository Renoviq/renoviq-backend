#!/usr/bin/env bash
# Runs on the server: /opt/renoviq/backup-mongo.sh
# Dumps the database to /opt/renoviq/backups and deletes dumps older than 14 days.
# Restore: docker compose exec -T mongo sh -c 'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' < backups/<file>
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p backups
out="backups/mongo-$(date +%Y%m%d-%H%M%S).archive.gz"
docker compose exec -T mongo sh -c 'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' > "$out"
find backups -name 'mongo-*.archive.gz' -mtime +14 -delete
echo "Wrote $out"
