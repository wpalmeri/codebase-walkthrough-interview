# Worklog

- Fixed revenue reporting to recognize only posted/sent/paid invoices and aggregate the materialized invoice total instead of mutable order/product data. Added focused tests for status filtering, invoice-level adjustments, deleted-live-data independence, and quarterly/customer/annual grouping.
- Replaced duplicated server/client response interfaces with a shared Zod contract package whose TypeScript models are inferred from runtime schemas. Server DTO mappers and report aggregators now validate their output, while Prisma remains the generated source for internal database record types.
