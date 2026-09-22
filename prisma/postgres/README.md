# PostgreSQL financial contract lane

The application currently uses the SQLite datasource in `prisma/schema.prisma` for its local/demo runtime. This directory is deliberately isolated from that runtime: it is a disposable PostgreSQL contract schema used by CI to exercise PostgreSQL `NUMERIC`, foreign-key, enum, trigger, row-lock, and serializable-transaction behavior that SQLite cannot model.

`migrations/0001_financial_integrity.sql` is applied only to an empty CI database; it is not an instruction to run it against an existing production database. When PostgreSQL becomes a supported production datasource, replace this isolated bootstrap with reviewed, additive Prisma/PostgreSQL migrations and keep the behavioral tests below pointed at those migrations.

The test is intentionally database-native. It uses two independent `psql` sessions to prove that a row lock serializes competing payment applications and that a serializable stale write aborts, rather than merely mocking those conditions in TypeScript.

The contract intentionally permits only USD. Additional codes require explicit minor-unit,
rounding, formatting, and settlement semantics before the domain constraint is expanded.
