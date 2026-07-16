#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

command -v node >/dev/null || { printf 'Node.js 20 or later is required.\n' >&2; exit 1; }
command -v npm >/dev/null || { printf 'npm is required.\n' >&2; exit 1; }
command -v docker >/dev/null || { printf 'Docker is required for the automatic setup. See README.md for an existing PostgreSQL option.\n' >&2; exit 1; }

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

docker compose up -d postgres
npm ci
npm run setup
npm run check

printf '\nSetup complete. Start the API with: npm start\n'
