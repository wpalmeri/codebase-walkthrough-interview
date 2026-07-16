#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$root_dir/candidate-package"
archive="$root_dir/ehr-engineering-lead-exercise.tar.gz"

rm -rf "$output_dir" "$archive"
mkdir -p "$output_dir"

tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='candidate-package' \
  --exclude='ehr-engineering-lead-exercise.tar.gz' \
  --exclude='INTERNAL_INTERVIEW_GUIDE.md' \
  --exclude='IMPLEMENTATION_PLAN.md' \
  -cf - -C "$root_dir" . | tar -xf - -C "$output_dir"

tar -czf "$archive" -C "$output_dir" .
printf 'Created %s\n' "$archive"
