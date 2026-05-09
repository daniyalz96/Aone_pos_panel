# Full POS Implementation Plan (Phased)

## 1) Product Vision

Build a **real-time POS + accounting platform** where:

- POS is the operational UI layer (billing, payments, inventory actions).
- Ledger is the source of truth (double-entry postings for every financial event).
- Reports, tax, P/L, and audit are derived from ledger + inventory events.

Stack:

- **Backend:** Node.js, Express, PostgreSQL
- **Frontend:** Nuxt 3, Nuxt UI, Tailwind CSS

---

## 2) High-Level Architecture

## Core Services (single backend initially, modular boundaries)

1. **Auth & User Service**
   - Login/logout
   - RBAC (cashier, manager, admin)
   - Shift and session control

2. **Catalog & Pricing Service**
   - Products, variants, barcodes/SKU
   - Price lists, discounts, tax profile mapping

3. **Billing & Order Service**
   - Cart, hold/resume, split/merge bills
   - Invoice posting, cancel/void/refund flows

4. **Payment Service**
   - Multi-method and split payments
   - Partial/pending states, refunds

5. **Inventory Service**
   - Real-time stock movement
   - Batch/expiry, stock in/out, transfers

6. **Ledger/Accounting Service**
   - Double-entry journal postings
   - Receivable, cash, bank, sales, tax, expense, inventory ledgers

7. **Reporting & Analytics Service**
   - Sales, tax, margin, cash drawer, cashier reports
   - Daily/monthly/yearly dashboards

8. **Sync/Offline Service**
   - Local queue + retry
   - Conflict resolution policy

9. **Notification Service**
   - Low stock, sync fail, pending bills, day-close reminder

## Frontend Apps/Screens

- Billing screen (fast cashier workflow)
- Admin dashboard (charts, KPIs)
- Product/inventory screens
- User/role management
- Customer management
- Reports and day-close screens
- Settings (tax, branch, payment config)

---

## 3) Phase-by-Phase Implementation

## Phase 0: Foundation & Planning (1-2 weeks)

**Goals**

- Finalize scope and data model.
- Set coding standards and repository structure.
- Prepare infra and CI/CD.

**Deliverables**

- Monorepo or dual repo setup (`backend`, `frontend`).
- PostgreSQL initialized with migration tooling (Prisma/Knex/TypeORM).
- Environment config (`dev`, `staging`, `prod`).
- Base CI pipeline: lint, test, build.
- API versioning strategy (`/api/v1`).

**Output**

- Technical Design Document (TDD)
- ERD and ledger posting matrix approved

---

## Phase 1: Identity, RBAC, Branch & Shift Core (1-2 weeks)

**Backend**

- User model: admin, manager, cashier
- JWT auth + refresh/session strategy
- Permission matrix:
  - Price override
  - Discount override
  - Void/refund approval
  - Cash drawer operations
- Branch/store setup
- Shift open/close endpoints with cash drawer opening amount

**Frontend**

- Login screen
- Admin user management screen (add/edit/deactivate users)
- Role/permission assignment UI
- Shift open/close modal for cashier

**Acceptance**

- Admin can create users and assign roles.
- Every action stores `performed_by` in audit logs.

---

## Phase 2: Product Catalog + Inventory Base (2-3 weeks)

**Backend**

- Product, category, variant, unit, barcode tables
- Inventory stock ledger tables:
  - stock_in, stock_out, sale_deduction, return_in, adjustment
- Low-stock thresholds
- Batch + expiry tracking
- Multi-branch inventory quantities

**Frontend**

- Product CRUD with barcode/SKU and variants
- Stock in/out screens
- Inventory movement history
- Low stock alert widget

**Acceptance**

- Product search by barcode/SKU works in < 200ms (indexed).
- Stock movement is append-only and auditable.

---

## Phase 3: Billing Engine (Core POS) (3-4 weeks)

**Backend**

- Cart APIs: add/remove/update item quantity
- Price override (permission-gated)
- Discounts:
  - item-level
  - bill-level
- Tax engine:
  - inclusive/exclusive
  - multiple slabs (GST/VAT)
- Hold/park and resume order
- Split/merge bill APIs
- Invoice finalization endpoint

**Frontend (Billing Screen)**

- Fast keypad/cart UI
- Barcode scan input
- Line item editing with permission checks
- Hold/resume and split/merge actions
- Bill summary (subtotal, discount, tax, total)

**Acceptance**

- Complete billing flow from scan to post.
- Recalculate totals consistently on each line change.

---

## Phase 4: Payment + Receipt + Refunds/Returns (2-3 weeks)

**Backend**

- Payment methods: cash, card, QR, wallet, bank
- Split payments (multiple instruments per invoice)
- Payment status: pending, partial, paid
- Change calculation for cash
- Return flow:
  - full return
  - partial item return
- Void/cancel flows with reason capture
- Receipt generation payload + template renderer

**Frontend**

- Payment panel (multi-method split)
- Change display for cash
- Receipt preview + print action
- Refund/return interface referencing original invoice
- Void/cancel dialogs with reason

**Acceptance**

- Partial payment + later completion works.
- Return updates both stock and ledger consistently.

---

## Phase 5: Double-Entry Ledger Integration (3 weeks)

**Core rule:** No financial report is computed from invoice tables directly; use ledger postings.

**Backend**

- Journal tables:
  - journal_entry (header)
  - journal_lines (debit/credit)
- Account chart:
  - Cash
  - Bank
  - Receivable
  - Sales Revenue
  - Tax Payable
  - Inventory
  - COGS
  - Expense
- Posting engine:
  - Invoice post
  - Payment receive
  - Refund
  - Expense from drawer
- Posting idempotency (prevent duplicate journal)
- Link each journal to source transaction (`invoice_id`, `payment_id`, etc.)

**Sample Posting (invoice + cash payment)**

- Debit Cash/Bank/Receivable
- Credit Sales Revenue
- Credit Tax Payable

**Acceptance**

- Trial balance matches (total debits == total credits).
- Every posted invoice has linked journal entries.

---

## Phase 6: Customer, Credit Sales, Loyalty (2 weeks)

**Backend**

- Customer profile (walk-in + registered)
- Credit sales and receivable aging
- Loyalty points earn/redeem rules
- Customer purchase history API

**Frontend**

- Customer selection during billing
- Customer CRUD
- Loyalty balance and redemption UI
- Customer statement screen

**Acceptance**

- Credit sale posts receivable account correctly.
- Loyalty earns/redeems with audit trace.

---

## Phase 7: Dashboard, Reports, Day Closing (2-3 weeks)

**Dashboard (Admin/Manager)**

- Daily, monthly, yearly sales
- Profit/loss monthly and yearly
- Sales by cashier
- Payment method distribution
- Top items and peak hours

**Reports**

- Daily sales report
- Tax report
- Item-wise sales
- Margin/profit report
- Pending/partial payments
- Shift closing report
- Z-report/day close

**Day Closing Flow**

- Total sales summary
- Cash in drawer vs expected cash
- Expense entries from drawer
- Shift closure confirmation

**Acceptance**

- Reports filterable by date, branch, cashier.
- Dashboard charts refresh near real-time (or every 1-5 min polling).

---

## Phase 8: Offline Mode + Auto Sync + Conflict Handling (3-4 weeks)

**Frontend/Client**

- Local storage/indexed DB queue for offline transactions
- Offline billing operations allowed (config-driven)
- Sync status indicator on POS screen

**Backend**

- Sync ingest endpoints with idempotency keys
- Conflict policies:
  - Duplicate invoice IDs -> reject duplicate, preserve first accepted
  - Inventory mismatch -> create reconciliation task
  - Price changed while offline -> keep billed value + audit flag
- Sync failure alerts and retry strategy

**Acceptance**

- Offline invoice can be created and synced later without double posting.
- Sync logs visible to admin.

---

## Phase 9: Alerts, Audit, Security, Hardening (2 weeks)

**Audit Trail (mandatory)**

- Who created invoice
- Who refunded/voided
- When posted
- Linked ledger entry IDs
- Before/after values for sensitive updates (discount/price override)

**Security**

- Rate limiting
- Input validation and SQL injection protection
- Permission middleware on all critical routes
- Optional 2FA for admin

**Alerts**

- Low stock
- Pending bills
- Day close reminder
- Sync failure

---

## Phase 10: UAT, Performance, Deployment, Go-Live (2 weeks)

**Performance**

- DB indexing and query tuning
- Load test billing and posting throughput
- Archive/partition large ledgers

**Quality**

- End-to-end test suite for critical flows
- Reconciliation scripts (sales vs payments vs ledger)
- Backup/restore drill

**Deployment**

- Blue/green or rolling deployment
- Monitoring dashboards (API latency, sync error count, posting failures)
- Production runbook + incident SOP

---

## 4) Recommended PostgreSQL Schema (Core Tables)

**Identity & Access**

- users, roles, permissions, user_roles, role_permissions, sessions

**POS & Catalog**

- products, product_variants, barcodes, price_lists, taxes, discount_rules
- orders, order_items, held_orders
- invoices, invoice_items

**Payments**

- payments, payment_splits, refunds, return_items

**Inventory**

- inventory_balances (per branch + variant + batch)
- inventory_movements
- batches (expiry)
- stock_transfers

**Accounting**

- chart_of_accounts
- journal_entries
- journal_lines
- ledger_links (source transaction mapping)

**Customer**

- customers, customer_loyalty, customer_transactions

**Operations**

- shifts, cash_drawer_events, expenses
- notifications, sync_jobs, sync_conflicts
- audit_logs

---

## 5) API Module Plan (Express)

- `POST /auth/login`, `POST /auth/logout`
- `POST /users`, `GET /users`, `PATCH /users/:id`
- `POST /products`, `GET /products/search?barcode=`
- `POST /orders`, `PATCH /orders/:id/items`, `POST /orders/:id/hold`, `POST /orders/:id/resume`
- `POST /invoices/:id/post`
- `POST /payments`, `POST /payments/:id/refund`
- `POST /returns`
- `POST /inventory/stock-in`, `POST /inventory/stock-out`
- `POST /shifts/open`, `POST /shifts/close`
- `POST /expenses`
- `GET /reports/sales`, `GET /reports/tax`, `GET /reports/profit-loss`
- `POST /sync/push`, `GET /sync/status`

---

## 6) Frontend Screen Plan (Nuxt 3)

1. Login
2. Billing/POS
3. Hold/Resume Orders
4. Payment & Receipt
5. Refund/Return/Void
6. Dashboard (sales, P/L, trends)
7. Products & Variants
8. Inventory & Batch/Expiry
9. Users/Roles/Permissions
10. Customers & Loyalty
11. Reports
12. Shift & Day Closing (Z-report)
13. Settings (tax, payment methods, branch config)
14. Sync Monitor & Conflict Resolution

---

## 7) Charting Requirements for Dashboard

Use Nuxt UI chart components (or ECharts/ApexCharts wrapper) for:

- Sales trend: daily/weekly/monthly/yearly line chart
- Profit vs loss by month (bar chart)
- Payment method share (donut chart)
- Cashier-wise performance (bar chart)
- Item-wise/top SKU sales (horizontal bar)
- Peak hour heatmap

---

## 8) Ledger Posting Matrix (Must Implement Early)

1. **Invoice posted (cash sale)**
   - Dr Cash
   - Cr Sales Revenue
   - Cr Tax Payable

2. **Invoice posted (credit sale)**
   - Dr Accounts Receivable
   - Cr Sales Revenue
   - Cr Tax Payable

3. **Customer payment received**
   - Dr Cash/Bank
   - Cr Accounts Receivable

4. **Refund issued**
   - Dr Sales Return
   - Dr Tax Adjustment (if applicable)
   - Cr Cash/Bank

5. **Expense from drawer**
   - Dr Expense
   - Cr Cash

---

## 9) Non-Functional Requirements

- Target billing action latency: < 300ms for key operations
- Support concurrent terminals per branch
- Full auditability for all sensitive actions
- Idempotent transaction posting endpoints
- Graceful offline behavior with eventual consistency
- Daily backup + point-in-time recovery strategy

---

## 10) Suggested Delivery Timeline (MVP -> Full)

- **Month 1:** Phase 0-2 (foundation, RBAC, catalog, inventory base)
- **Month 2:** Phase 3-4 (billing, payment, receipt, refund)
- **Month 3:** Phase 5-6 (ledger core, customer, credit, loyalty)
- **Month 4:** Phase 7-8 (dashboard/reports, offline sync)
- **Month 5:** Phase 9-10 (hardening, UAT, go-live)

---

## 11) Team Structure Recommendation

- 2 Backend engineers (API + ledger + sync)
- 2 Frontend engineers (POS + admin/reporting)
- 1 QA engineer (automation + reconciliation tests)
- 1 DevOps/Infra engineer (CI/CD, monitoring, backups)
- 1 Product/Domain lead (accounting + retail workflow decisions)

---

## 12) Immediate Next Steps

1. Approve this phase plan.
2. Finalize ERD and posting matrix.
3. Start implementation with Phase 0 + Phase 1.
4. Build billing screen and posting engine in parallel.
5. Lock reconciliation tests before production rollout.

