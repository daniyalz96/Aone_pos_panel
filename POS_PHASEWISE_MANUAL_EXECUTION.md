# Modern Retail POS - Phase-Wise Manual Execution Guide

This guide is the practical execution playbook for building your POS system step by step with:

- **Backend:** Node.js + Express + PostgreSQL
- **Frontend:** Nuxt 3 + Nuxt UI + Tailwind CSS

It is written as a manual checklist so you (or your team) can execute phase by phase without confusion.

---

## 1) Build Principles (Follow Throughout)

1. **Ledger-first architecture**
   - Do not trust report numbers from invoice tables directly.
   - Every finance-impacting action must post journal entries.

2. **Audit everything**
   - Track `who`, `when`, `what`, `before`, `after` for critical actions.

3. **Fast billing UX**
   - Billing screen must be keyboard/scanner friendly.
   - Target: common cashier action in <= 2 clicks.

4. **Mobile responsive admin**
   - Admin dashboard and management screens must work on tablet/mobile.
   - POS terminal screen can remain desktop-first but still adaptive.

5. **Offline-safe**
   - Billing and sync are designed with idempotency and retry.

---

## 2) Suggested Repository Structure (Create Manually)

Create this structure first:

```text
pos-system/
  backend/
  frontend/
  docs/
    architecture/
    api/
    ui/
```

Then place planning docs:

- `docs/architecture/POS_IMPLEMENTATION_PLAN.md`
- `docs/architecture/POS_PHASEWISE_MANUAL_EXECUTION.md`

---

## 3) UI/UX Design System (Modern Retail, User-Friendly)

## Design goals

- Clear, high-contrast POS interface for fast operations.
- Touch-friendly on tablets.
- Consistent components across desktop/mobile admin.

## Color and typography

- Primary: neutral dark + retail blue accent
- Success: green, Warning: amber, Danger: red
- Font: `Inter` or `Nunito Sans`
- Base size: 14-16px, line-height 1.4-1.5

## Spacing and components

- 8px spacing grid
- Large touch targets (min 44px)
- Fixed action footer on mobile for important actions
- Reusable component set:
  - Product tile/card
  - Cart line row
  - Payment chip
  - Status badge
  - KPI card
  - Filter panel

## Responsive breakpoints

- Mobile: `< 640px`
- Tablet: `640px - 1024px`
- Desktop: `> 1024px`

## POS screen layout guidance

- Left: product search/categories/grid
- Right: cart + totals + payment action
- Sticky totals and checkout actions
- Barcode input always visible/focused

## Admin dashboard layout guidance

- Top KPIs (sales, profit, tax, orders)
- Middle charts (sales trend, payment split)
- Bottom tables (top items, low stock, cashier sales)
- Mobile: convert multi-column widgets into stacked cards

---

## 4) Phase-Wise Manual Steps

## Phase 0 - Environment, Standards, Bootstrapping (Week 1)

**Manual tasks**

1. Install prerequisites:
   - Node LTS
   - PostgreSQL 15+
   - pnpm/npm
2. Initialize backend and frontend projects.
3. Add lint/format rules (ESLint + Prettier).
4. Configure env files:
   - `backend/.env`
   - `frontend/.env`
5. Setup migration tool (Prisma recommended).
6. Setup base CI (lint, test, build).

**Definition of done**

- Both apps run locally.
- Health check endpoint works.
- Nuxt app renders home page.

---

## Phase 1 - Auth, RBAC, Admin User Management, Shift (Week 2)

**Manual backend steps**

1. Create tables:
   - users, roles, permissions, user_roles, role_permissions, sessions, shifts
2. Seed default roles:
   - admin, manager, cashier
3. Implement auth APIs:
   - login, logout, refresh
4. Implement permission middleware.
5. Implement shift open/close APIs.

**Manual frontend steps**

1. Build login page.
2. Build user management page for admin:
   - add/edit/deactivate users
3. Build role-permission matrix UI.
4. Build shift open/close modal for cashier.

**Test checklist**

- Admin can create cashier.
- Cashier cannot access admin-only routes.
- Shift cannot close without summary payload.

---

## Phase 2 - Product, Barcode, Variants, Inventory Base (Week 3-4)

**Manual backend steps**

1. Create tables:
   - products, product_variants, barcodes, categories, inventory_balances, inventory_movements, batches
2. Add indexes:
   - barcode, sku, product_name
3. Implement product CRUD APIs.
4. Implement stock in/out and adjustment APIs.
5. Add low-stock threshold logic.

**Manual frontend steps**

1. Build product listing and form pages.
2. Add barcode/SKU search UI.
3. Build stock-in/stock-out forms.
4. Build low stock panel (dashboard widget).

**Test checklist**

- Barcode search latency acceptable.
- Inventory movement logs are immutable.

---

## Phase 3 - Billing Engine (Retail Core) (Week 5-6)

**Manual backend steps**

1. Create order/invoice models:
   - orders, order_items, held_orders, invoices, invoice_items
2. Implement cart endpoints:
   - add/remove/update qty
3. Add permission-gated price override.
4. Implement discount engine:
   - item-level, bill-level
5. Implement tax engine:
   - inclusive/exclusive and multi slab
6. Implement hold/resume, split/merge bill.

**Manual frontend steps**

1. Build POS billing screen with 2-pane layout.
2. Add barcode scanner input and quick product search.
3. Add cart line edit actions:
   - qty, discount, override (with permission prompt)
4. Add hold/resume and split/merge actions.
5. Add bill summary panel (subtotal/discount/tax/grand total).

**UX checklist**

- Cashier completes standard bill in < 30 seconds.
- Keyboard shortcuts added (F2 search, F4 payment, etc.).

---

## Phase 4 - Payments, Receipts, Refund/Return, Void/Cancel (Week 7)

**Manual backend steps**

1. Create payment tables:
   - payments, payment_splits, refunds, return_items
2. Implement payment APIs with multi-method support.
3. Implement split payment and partial payment logic.
4. Implement return/refund APIs with invoice linkage.
5. Implement void/cancel with mandatory reason.
6. Add receipt payload and print template endpoint.

**Manual frontend steps**

1. Build payment modal with split options.
2. Show change calculation for cash.
3. Build receipt preview + print.
4. Build return/refund screen by invoice lookup.
5. Add cancel/void dialogs with reason field.

**Test checklist**

- Partial payment status changes correctly.
- Return updates payment/invoice/inventory status consistently.

---

## Phase 5 - Ledger Core (Double Entry) (Week 8-9)

**Manual backend steps**

1. Create accounting tables:
   - chart_of_accounts, journal_entries, journal_lines, ledger_links
2. Seed chart of accounts.
3. Build posting service (idempotent):
   - invoice post
   - payment receive
   - refund
   - expense
4. Ensure transaction atomicity using DB transactions.

**Manual frontend steps**

1. Build ledger view (read-only for manager/admin).
2. Add transaction drill-down:
   - invoice -> journal entries
3. Show posting status badge on invoice detail.

**Validation checklist**

- Debits == credits for each journal.
- No duplicate postings on retries.

---

## Phase 6 - Customer, Credit, Loyalty (Week 10)

**Manual backend steps**

1. Create customer tables:
   - customers, customer_loyalty, customer_transactions
2. Implement customer CRUD and history APIs.
3. Add credit sale logic and receivable posting.
4. Implement loyalty earn/redeem rules.

**Manual frontend steps**

1. Add customer selector on POS screen.
2. Build customer profile and history pages.
3. Add loyalty point display and redeem action.

---

## Phase 7 - Dashboard, Analytics, Reports, P/L (Week 11-12)

**Manual backend steps**

1. Build analytics endpoints:
   - daily/monthly/yearly sales
   - profit/loss monthly and yearly
   - payment method split
   - cashier-wise sales
2. Build report export APIs (CSV/PDF).

**Manual frontend steps**

1. Create admin dashboard with charts:
   - sales trend
   - P/L bars
   - payment split donut
   - top items
2. Add date filters:
   - today, week, month, year, custom
3. Build reports page with table + export.

**Mobile UX checklist**

- Filters remain accessible in sticky header.
- Charts collapse into card stack on small screens.

---

## Phase 8 - Offline Billing + Auto Sync (Week 13)

**Manual backend steps**

1. Create sync tables:
   - sync_jobs, sync_conflicts
2. Implement idempotent sync ingest endpoint.
3. Add conflict resolver workflow.

**Manual frontend steps**

1. Use IndexedDB for offline queue.
2. Queue invoice/payment events offline.
3. Auto retry sync when online event detected.
4. Show sync state in POS header:
   - online, offline, syncing, failed

**Test checklist**

- Offline bill syncs once internet returns.
- Duplicate sync requests do not double-post ledger.

---

## Phase 9 - Day Closing, Expenses, Alerts, Audit Hardening (Week 14)

**Manual backend steps**

1. Build day close APIs:
   - sales summary
   - expected cash vs actual
2. Add expense from drawer API.
3. Implement notification triggers:
   - low stock, pending bills, sync fail, day close reminder
4. Enforce audit logging middleware globally.

**Manual frontend steps**

1. Build day close/Z-report screen.
2. Build cash reconciliation input UI.
3. Build expense entry screen.
4. Build alert center panel.

---

## Phase 10 - QA, Security, UAT, Production Launch (Week 15-16)

**Manual tasks**

1. Run E2E tests for full retail flow.
2. Reconcile ledger vs reports for sample periods.
3. Conduct role-based penetration tests.
4. Tune DB indexes and slow queries.
5. Configure backups + restore drill.
6. Deploy staging -> pilot branch -> production.

**Go-live checklist**

- Pilot branch closes day-end without mismatch.
- No critical sync or posting errors.
- Team training completed.

---

## 5) UI Screen Blueprint (Must Build)

1. Auth/Login
2. POS Billing
3. Hold/Resume Orders
4. Payment + Split Payment
5. Receipt Preview/Print
6. Refund/Return/Void
7. Product + Variants
8. Inventory + Batches
9. Customer + Loyalty
10. User + Role + Permission
11. Dashboard + Charts
12. Reports + Export
13. Shift Open/Close
14. Day Closing / Z-report
15. Alerts + Sync Monitor
16. Settings (tax/payment/branch)

---

## 6) Manual Daily Work Routine (Recommended)

1. Start day with 15-min planning and ticket assignment.
2. Build in small increments with API contract first.
3. QA smoke test every completed feature before merge.
4. Run ledger reconciliation tests daily.
5. Demo progress weekly to stakeholders.

---

## 7) First 7 Days Action Plan (Start Now)

**Day 1**
- Create repo structure, initialize backend/frontend.
- Setup PostgreSQL and migration tooling.

**Day 2**
- Implement auth base + user/role schema.

**Day 3**
- Build login + protected routing frontend.

**Day 4**
- Create admin user management UI and APIs.

**Day 5**
- Add shift open/close and audit logs.

**Day 6**
- Setup product schema + barcode index.

**Day 7**
- Build initial POS billing UI skeleton (responsive 2-pane).

---

## 8) Important Implementation Rules

- Never post to ledger without source transaction reference.
- Never allow price override without explicit permission.
- Never delete inventory movement rows (append-only history).
- Never allow refund without reason + user identity.
- Always include idempotency key for post/sync endpoints.

