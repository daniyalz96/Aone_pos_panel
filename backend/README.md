# POS Backend

Retail POS backend foundation using Express + PostgreSQL with ledger-first design.

## Features Implemented

- Authentication (`/auth/login`, `/auth/me`)
- RBAC + permission checks
- Admin user management
- Shift open/close
- Product management and search
- Inventory management:
  - stock in/out
  - real-time balance
  - branch-wise stock balances
  - stock transfers between branches
  - batch + expiry-aware stock-in
  - near-expiry alert endpoint
  - low stock listing
- Product catalog enhancements:
  - categories
  - variants (size/color etc.)
- Order cart flow:
  - Create order
  - Add line item
  - item discount (amount/percent)
  - bill discount (amount/percent)
  - inclusive/exclusive tax support
  - Hold/resume
  - split bill
  - merge bills
  - Post invoice
- Payment and refund endpoints
- Split payment collection + cash change handling
- Receipt dispatch logging (print/email/WhatsApp)
- Cancel/void approval workflow
- Item-level partial return workflow
- Customer management + loyalty points base
- Expense posting + day-close summary
- Offline sync ingest/status API
- Offline sync hardening APIs (process, retry, conflicts, scheduler, reconciliation)
- Operational alert automation (low stock, sync issues, pending bills, day-close reminders)
- Notification center API
- Double-entry ledger posting
- Basic analytics endpoints (sales summary, monthly P/L)
- Advanced reporting endpoints (tax slabs, cashier sales, payment method split, day close)
- Analytics endpoints for dashboard charts (trend, peak hours, top items, branch comparison, KPI cards)
- Audit logs for critical actions

## Quick Start

1. Copy `.env.example` to `.env` and update values.
2. Create PostgreSQL database.
3. Run migrations and seed:

```bash
npm run migrate
npm run seed
```

4. Start server:

```bash
npm run dev
```

API base URL:

`http://localhost:4000/api/v1`

## Default Admin Credentials

- Email: `admin@pos.local`
- Password: `Admin@123`

Change this password after first login.

## Main Endpoints

- `GET /api/v1/health`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `GET|POST /api/v1/users`
- `PATCH /api/v1/users/:id/active`
- `POST /api/v1/shifts/open`
- `POST /api/v1/shifts/close`
- `GET|POST|PATCH /api/v1/products`
- `GET|POST /api/v1/products/categories`
- `GET|POST /api/v1/products/:id/variants`
- `GET|POST /api/v1/branches`
- `GET|POST /api/v1/procurement/suppliers`
- `GET|POST /api/v1/procurement/grn`
- `POST /api/v1/inventory/stock-in`
- `POST /api/v1/inventory/stock-out`
- `POST /api/v1/inventory/transfer`
- `GET /api/v1/inventory/balances`
- `GET /api/v1/inventory/low-stock`
- `GET /api/v1/inventory/movements`
- `GET /api/v1/inventory/expiry-alerts`
- `GET /api/v1/products/search/billing?q=...`
- `POST /api/v1/orders`
- `POST /api/v1/orders/:id/items`
- `PATCH /api/v1/orders/:id/bill-discount`
- `POST /api/v1/orders/:id/hold`
- `POST /api/v1/orders/:id/resume`
- `POST /api/v1/orders/:id/split`
- `POST /api/v1/orders/merge`
- `POST /api/v1/orders/:id/cancel`
- `POST /api/v1/orders/:id/post`
- `GET /api/v1/receipts/:invoiceId`
- `POST /api/v1/receipts/:invoiceId/send`
- `GET /api/v1/receipts/:invoiceId/dispatches`
- `POST /api/v1/voids/invoices/:id/void`
- `GET /api/v1/approvals`
- `POST /api/v1/approvals/:id/approve`
- `POST /api/v1/approvals/:id/reject`
- `POST /api/v1/returns`
- `GET /api/v1/returns/invoice/:invoiceId`
- `POST /api/v1/payments`
- `POST /api/v1/payments/collect`
- `GET /api/v1/payments/invoice/:id`
- `POST /api/v1/payments/refund`
- `GET|POST /api/v1/customers`
- `PATCH /api/v1/customers/:id/loyalty`
- `POST /api/v1/expenses`
- `GET /api/v1/expenses/day-close-summary?shiftId=...`
- `POST /api/v1/sync/push`
- `GET /api/v1/sync/status`
- `POST /api/v1/sync/process/:id`
- `POST /api/v1/sync/retry/:id`
- `GET /api/v1/sync/conflicts`
- `POST /api/v1/sync/conflicts/:id/resolve`
- `POST /api/v1/sync/scheduler/retry-due`
- `GET /api/v1/sync/reconcile/summary`
- `GET|POST /api/v1/notifications`
- `PATCH /api/v1/notifications/:id/ack`
- `POST /api/v1/notifications/automation/run`
- `GET /api/v1/reports/sales-summary`
- `GET /api/v1/reports/monthly-pl`
- `GET /api/v1/reports/tax-slabs`
- `GET /api/v1/reports/cashier-sales`
- `GET /api/v1/reports/payment-methods`
- `GET /api/v1/reports/profit-margin`
- `GET /api/v1/reports/day-close`
- `GET /api/v1/reports/analytics/sales-trend`
- `GET /api/v1/reports/analytics/peak-hours`
- `GET /api/v1/reports/analytics/top-items`
- `GET /api/v1/reports/analytics/branch-comparison`
- `GET /api/v1/reports/analytics/kpis`
- `GET /api/v1/ledger/entries`
- `GET /api/v1/ledger/entries/:id`
