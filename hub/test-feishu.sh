#!/usr/bin/env bash
set -eu

# Run the Hub with credentials from the caller's environment.
: "${FEISHU_APP_ID:?Set FEISHU_APP_ID}"
: "${FEISHU_APP_SECRET:?Set FEISHU_APP_SECRET}"
export FEISHU_ENABLED=true
cd "$(dirname "$0")"
exec bun run start
