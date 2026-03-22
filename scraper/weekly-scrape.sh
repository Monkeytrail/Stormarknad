#!/usr/bin/env bash
set -o pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRAPER_DIR="$PROJECT_DIR/scraper"
WEB_DIR="$PROJECT_DIR/web"
LOG_DIR="$PROJECT_DIR/logs"
BUN="$HOME/.bun/bin/bun"

mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/weekly-scrape-$(date +%Y-%m-%d).log"

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOGFILE"; }

log "=== Stormarknad weekly scrape ==="

FAILED=0

for script in \
  "$SCRAPER_DIR/ah-recipes.ts" \
  "$SCRAPER_DIR/ah-discover.ts" \
  "$SCRAPER_DIR/ah-bonuses.ts" \
  "$SCRAPER_DIR/demorgen-recipes.ts" \
  "$SCRAPER_DIR/demorgen-discover.ts" \
  "$SCRAPER_DIR/15gram-recipes.ts"; do

  name="$(basename "$script" .ts)"
  log "Starting $name..."
  if "$BUN" run "$script" >> "$LOGFILE" 2>&1; then
    log "$name done"
  else
    log "ERROR: $name failed (exit $?)"
    FAILED=$((FAILED + 1))
  fi
done

log "Starting seed..."
if (cd "$WEB_DIR" && "$BUN" run seed) >> "$LOGFILE" 2>&1; then
  log "Seed done"
else
  log "ERROR: seed failed (exit $?)"
  FAILED=$((FAILED + 1))
fi

if [ "$FAILED" -gt 0 ]; then
  log "=== Finished with $FAILED error(s) ==="
  exit 1
else
  log "=== All done ==="
  exit 0
fi
