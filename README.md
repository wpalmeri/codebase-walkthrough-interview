# Meridian — Billing & Receivables

This codebase includes the basics of an ERP system designed by a junior engineer. You’re coming in as the technical leader overseeing this ERP system. It’s in use by hundreds of customers that are each doing hundreds of orders a day through the system. The CEO told you the business was going great during the hiring process, but as you joined you clearly realize that the technical maturity is significantly lagging commercials. The first priority is the integrity of the system. The CEO has gotten many escalations from customers on financial issues, and since this is an ERP the bar is that finances must be 100% right. Escalations the CEO has gotten include customers claiming that prices are incorrect. Pressed for specifics, the customers mention issues like mismatch between the table and the individual order on what was displayed, customers getting invoices with prices that are different from what the orders says, and other issues. 

You recently sold your first enterprise customer and they are now recording their revenue for the month based on what your report says. After they close a month, they will no longer make invoices dated within that month, and move invoice dates to future months so the revenue for a month never changes. They have strict accounting controls, so it’s important to them revenue never changes. They have reported that revenue occasionally changes for a month despite the fact that they did not add any invoices. This throws off their accounting. 

Additionally, there have been reports of customers never receiving invoices that were supposedly sent. This is a major pain, since the office does not find out that they were not sent until 30 days after it was sent when they’re supposed to be due. 
The CEO has tasked your top priority to be fixing these issues. He’s open to systemic refactors, improvements, and as much engineering time as you need. In addition to fixing the isolated issue, he wants you to harden the system so that you can ensure that these issues never happen. You should create solutions appropriate for the size and scale, but he’s deemed the issues as unacceptable and wants to make sure even if engineers make mistakes, junior engineers are hired, or other big mistakes happen and are not caught by code review, we have the safeguards and fundamental infrastructure in place to ensure that either issues won’t impact customers or worst case we can detect and recover before they notice. 

Your task is to implement as many fixes as you can, prioritized by impact, in the codebase within 3 hours.For any you can’t get to, or system improvements that are not realistic to implement in the mock environment, please write a report on what issues you see and how you would prioritize them. In the report, ensure to address the CEO’s concern of broader system hardening and being able to guarantee that even if mistakes are made he won’t get phone calls from customers, or at least he could answer the call and say we’re aware and already fixed the issue. 

You’re encouraged to use AI in the interview. You are responsible, though, for prioritizing properly, coming up with strong controls, and making the highest impact changes. AI will detect many of the issues, but will not give you everything and can be especially bad at the best engineering solutions for the size and scale. You’ll have to understand the codebase well enough to talk through the issues and stress the tradeoffs of different solutions. 

For clarity, here are core requirements on how different sections should work: 

**Full lifecycle**
Orders are created and have products associated with them. Products have both general pricing and customer specific pricing. They can have a variety of discounts, and we’ll continue making the prices products can have more robust. Once the order is fulfilled, they are converted to an invoice. The invoice is initially created as a draft. When the invoice is finalized, it is posted and posted invoices can not be changed. The invoices are sent to the client through a variety of mechanisms and we’ll add more over time. Until the invoice is posted, changes in the source order should propagate to the invoice. Payments are applied to invoices. Payments can be associated with many invoices. 

**Posting an invoice:**
Once an invoice is posted, the associated order should no longer be editable including any core fields or pricing associated with it. 

**Monthly close:**
This is a process done outside of the system but supported by the system. It is supported by no longer dating invoices for a previous month after you have closed it. If no invoice is added to a previous month, the revenue for that month should never change under any circumstances.

Note this uses sqllite for development simplicity, but you should assume that in practices it uses modern Postgres. 


# System information and documentation

A billing system for invoices and accounts receivable. It prices customer orders,
generates and transmits invoices (email, portal upload via an external job service,
or API submission through a clearinghouse connection), and applies cash payments.

## Domain

- **Customers** — who we bill. Each has negotiated rates that can be updated at any time.
- **Products** — what we sell.
- **Rates** — per-customer, per-product pricing. A rate is a flat base price or a
  schedule of **quantity intervals**: units inside each interval bill at that
  interval's price, the interval's charge is clamped between an optional **floor**
  and **ceiling**, and the line's price is the **blended** result. **Combo
  discounts** (linked to products) discount lines when all of their products appear
  together on an order; a combo is scoped to one customer or global.
- **Orders** — products a customer bought, with a reference number, billing party,
  receiver, notes, and a comment thread. An order's total is never stored: it is
  recalculated from the customer's current rates every time orders are viewed.
  Orders are also re-rated (item prices written back) when they are saved and when
  an invoice is generated from them. The customer and order date can be changed
  until the invoice posts.
- **Invoices** — one per order. A **draft** invoice follows its order: if the order
  changes, the draft changes. **Posting** finalizes the invoice; once an invoice is
  posted its order can no longer be edited (comments are still allowed). Posted
  invoices are then sent (EMAIL / PORTAL / API) — each transmission renders and
  attaches the invoice PDF — and paid.
- **Payments** — recorded as received from a customer, then **applied** across one
  or more invoices as a separate step; the difference is unapplied cash.
- **Reports** — revenue per quarter, per customer, and annual, over any date range.

## Stack

TypeScript throughout: Express API + Prisma/SQLite, React (Vite) client. No Docker
or external services — the database is a local SQLite file at `prisma/dev.db`.

```
prisma/schema.prisma   database schema
prisma/seed.ts         deterministic sample data
src/models/            domain types, mapped from Prisma rows
src/controllers/       business logic
src/services/          invoice PDF rendering + external transmission stubs
src/views/             the API (Express routers)
client/                React UI — sidebar ERP shell with list + detail pages:
                       Orders, Invoices, Cash Application, Products & Pricing, Reports
```

## Setup

Requires Node 20+ and nothing else.

```bash
cp .env.example .env
npm run setup                 # install (server + client), create the SQLite db, seed
```

## Run

```bash
npm run dev                   # API on http://localhost:4600
npm run client                # UI on http://localhost:5273
```

`npm run db:seed` wipes and re-seeds the sample data at any time.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/customers | list customers |
| GET | /api/products | list products |
| GET | /api/rates?customerId= | list rates |
| PUT | /api/rates/:id | update rate: `{ unitPrice, tiers?: [{ upTo, unitPrice, floor?, ceiling? }] }` |
| GET | /api/rates/combos?customerId= | combos for the customer plus global ones |
| POST | /api/rates/combos | create combo: `{ name, productIds, percentOff, customerId? }` (null customerId = global) |
| GET | /api/orders | list orders (priced) |
| GET | /api/orders/:id | order detail (items, comments, parties) |
| POST | /api/orders | create order: `{ customerId, items: [{ productId, quantity }] }` |
| PUT | /api/orders/:id | save order: `{ customerId?, orderDate?, notes?, items?: [{ id, quantity }], comment?: { author?, body } }` |
| POST | /api/orders/:id/invoice | generate the invoice for an order (re-rates it) |
| GET | /api/invoices | list invoices |
| GET | /api/invoices/:id | invoice detail (lines, payments, transmissions) |
| PUT | /api/invoices/:id | update dates: `{ issueDate?, dueDate? }` |
| POST | /api/invoices/:id/post | post (finalize) an invoice |
| POST | /api/invoices/:id/send | transmit: `{ method: "EMAIL" \| "PORTAL" \| "API" }` |
| POST | /api/invoices/transmissions/:id/refresh | poll portal job status |
| GET | /api/payments | payments with their applications |
| GET | /api/payments/:id | one payment |
| POST | /api/payments | record a payment: `{ customerId, amount, reference? }` |
| POST | /api/payments/:id/apply | apply across invoices: `{ applications: [{ invoiceId, amount }] }` |
| GET | /api/reports/revenue-by-quarter?from=&to= | quarterly revenue (continuous buckets) |
| GET | /api/reports/revenue-by-customer?from=&to= | revenue per customer |
| GET | /api/reports/annual-revenue?from=&to= | annual revenue |
