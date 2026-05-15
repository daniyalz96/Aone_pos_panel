import type { PoolClient } from "pg";
import { postJournalEntry } from "./ledger.js";

export async function insertSupplierLedger(
  client: PoolClient,
  params: {
    supplierId: string;
    entryKind: "opening_balance" | "purchase_post" | "supplier_payment" | "purchase_return" | "full_reversal";
    amount: number;
    referenceType?: string | null;
    referenceId?: string | null;
    memo?: string | null;
    userId: string | null;
  },
) {
  await client.query(
    `
      INSERT INTO supplier_ledger_entries
        (supplier_id, entry_kind, amount, reference_type, reference_id, memo, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      params.supplierId,
      params.entryKind,
      params.amount,
      params.referenceType ?? null,
      params.referenceId ?? null,
      params.memo ?? null,
      params.userId,
    ],
  );
}

/** Opening payable (amount > 0): DR clearing, CR AP. */
export async function postSupplierOpeningBalance(
  client: PoolClient,
  params: { supplierId: string; amount: number; userId: string | null },
) {
  if (params.amount <= 0) return;
  await postJournalEntry({
    client,
    sourceType: "supplier_opening_balance",
    sourceId: params.supplierId,
    memo: "Supplier opening balance (payable)",
    createdBy: params.userId,
    lines: [
      { accountCode: "3100", debit: params.amount, credit: 0 },
      { accountCode: "2200", debit: 0, credit: params.amount },
    ],
  });
  await insertSupplierLedger(client, {
    supplierId: params.supplierId,
    entryKind: "opening_balance",
    amount: params.amount,
    referenceType: "supplier",
    referenceId: params.supplierId,
    memo: "Opening balance",
    userId: params.userId,
  });
}
