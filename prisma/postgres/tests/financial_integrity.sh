#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at a disposable PostgreSQL database}"

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
migration_file="$root_dir/prisma/postgres/migrations/0001_financial_integrity.sql"
assertion_file="$root_dir/prisma/postgres/tests/financial_integrity.sql"
holder_log="$(mktemp)"
serializable_log="$(mktemp)"
trap 'rm -f "$holder_log" "$serializable_log"' EXIT

psql_cmd=(psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$DATABASE_URL")
"${psql_cmd[@]}" --file="$migration_file"
"${psql_cmd[@]}" --file="$assertion_file"

expect_failure() {
  local description="$1"
  local statement="$2"
  local expected="$3"
  local output
  output="$(mktemp)"
  if "${psql_cmd[@]}" --command="$statement" >"$output" 2>&1; then
    echo "expected PostgreSQL failure: $description" >&2
    rm -f "$output"
    return 1
  fi
  if ! grep -Fq "$expected" "$output"; then
    echo "unexpected PostgreSQL failure for: $description" >&2
    cat "$output" >&2
    rm -f "$output"
    return 1
  fi
  rm -f "$output"
}

# A direct overpayment fails at the database function boundary before it creates
# an application or changes the invoice balance.
expect_failure \
  "overpayment" \
  "SELECT apply_payment('payment-1', 'invoice-1', 'application-over', 100.0001);" \
  "invoice would be overpaid"
expect_failure \
  "payment capacity" \
  "SELECT apply_payment('payment-capacity', 'invoice-1', 'application-capacity', 50.0001);" \
  "payment would be over-applied"
"${psql_cmd[@]}" --tuples-only --no-align --command="
  SELECT CASE WHEN (SELECT count(*) FROM \"PaymentApplication\" WHERE \"invoiceId\" = 'invoice-1') = 0
    AND (SELECT \"amountPaidDecimal\" FROM \"Invoice\" WHERE \"id\" = 'invoice-1') = 0.0000
    THEN 'ok' ELSE 'payment failure was not atomic' END;" | grep -Fxq ok

# Two independent sessions attempt to apply 60.0000 to the same 100.0000
# invoice. The first holds the row lock. The second must wait, then reject the
# now-overpaying request; it must not create a second application.
PGAPPNAME=meridian_lock_holder "${psql_cmd[@]}" --command="
  BEGIN;
  SELECT pg_advisory_xact_lock(901001);
  SELECT apply_payment('payment-1', 'invoice-1', 'application-lock-one', 60.0000);
  SELECT pg_sleep(1.5);
  COMMIT;" >"$holder_log" 2>&1 &
holder_pid=$!

holder_waiting=false
for _ in $(seq 1 30); do
  if "${psql_cmd[@]}" --tuples-only --no-align --command="
    SELECT pg_try_advisory_lock(901001);" | grep -Fxq f; then
    holder_waiting=true
    break
  fi
  sleep 0.1
done
if [[ "$holder_waiting" != true ]]; then
  cat "$holder_log" >&2
  echo "lock holder did not reach its synchronization point" >&2
  exit 1
fi

SECONDS=0
expect_failure \
  "interleaved locked overpayment" \
  "BEGIN; SELECT apply_payment('payment-1', 'invoice-1', 'application-lock-two', 60.0000); COMMIT;" \
  "invoice would be overpaid"
elapsed_seconds="$SECONDS"
wait "$holder_pid"

if (( elapsed_seconds < 1 )); then
  echo "competing payment did not wait on the invoice row lock (${elapsed_seconds}s)" >&2
  exit 1
fi
"${psql_cmd[@]}" --tuples-only --no-align --command="
  SELECT CASE WHEN
    (SELECT count(*) FROM \"PaymentApplication\" WHERE \"invoiceId\" = 'invoice-1') = 1
    AND (SELECT \"amountPaidDecimal\" FROM \"Invoice\" WHERE \"id\" = 'invoice-1') = 60.0000
    THEN 'ok' ELSE 'interleaved payment corrupted the ledger' END;" | grep -Fxq ok

# A stale serializable transaction must abort rather than overwrite the payment
# balance written by a concurrent session.
PGAPPNAME=meridian_serializable_reader "${psql_cmd[@]}" --command="
  BEGIN ISOLATION LEVEL SERIALIZABLE;
  SELECT \"amountPaidDecimal\" FROM \"Invoice\" WHERE \"id\" = 'invoice-1';
  SELECT pg_advisory_xact_lock(901002);
  SELECT pg_sleep(1.5);
  UPDATE \"Invoice\" SET \"amountPaidDecimal\" = 70.0000 WHERE \"id\" = 'invoice-1';
  COMMIT;" >"$serializable_log" 2>&1 &
serializable_pid=$!

serializable_waiting=false
for _ in $(seq 1 30); do
  if "${psql_cmd[@]}" --tuples-only --no-align --command="
    SELECT pg_try_advisory_lock(901002);" | grep -Fxq f; then
    serializable_waiting=true
    break
  fi
  sleep 0.1
done
if [[ "$serializable_waiting" != true ]]; then
  cat "$serializable_log" >&2
  echo "serializable transaction did not reach its synchronization point" >&2
  exit 1
fi

"${psql_cmd[@]}" --command="
  BEGIN;
  UPDATE \"Invoice\" SET \"amountPaidDecimal\" = 60.0000 WHERE \"id\" = 'invoice-1';
  COMMIT;"
if wait "$serializable_pid"; then
  echo "stale serializable write unexpectedly committed" >&2
  exit 1
fi
if ! grep -Eq 'could not serialize access|serialization failure' "$serializable_log"; then
  cat "$serializable_log" >&2
  echo "serializable transaction failed for an unexpected reason" >&2
  exit 1
fi
"${psql_cmd[@]}" --tuples-only --no-align --command="
  SELECT CASE WHEN (SELECT \"amountPaidDecimal\" FROM \"Invoice\" WHERE \"id\" = 'invoice-1') = 60.0000
    THEN 'ok' ELSE 'serializable rollback did not preserve the winner' END;" | grep -Fxq ok

echo "PostgreSQL financial integrity contract passed"
