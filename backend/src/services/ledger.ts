import { PoolClient } from "pg";

type LedgerLine = {
  accountCode: string;
  debit: number;
  credit: number;
  memo?: string;
};

type PostJournalArgs = {
  client: PoolClient;
  sourceType: string;
  sourceId: string;
  memo: string;
  lines: LedgerLine[];
  createdBy: string | null;
};

export async function postJournalEntry(args: PostJournalArgs) {
  const { client, sourceType, sourceId, memo, lines, createdBy } = args;

  const totalDebit = lines.reduce((acc, line) => acc + line.debit, 0);
  const totalCredit = lines.reduce((acc, line) => acc + line.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.0001) {
    throw new Error("Journal is unbalanced");
  }

  const existing = await client.query(
    `SELECT id FROM journal_entries WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    return existing.rows[0].id as string;
  }

  const entry = await client.query(
    `
      INSERT INTO journal_entries (source_type, source_id, memo, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [sourceType, sourceId, memo, createdBy],
  );

  const entryId = entry.rows[0].id as string;

  for (const line of lines) {
    const account = await client.query(
      `SELECT id FROM ledger_accounts WHERE code = $1`,
      [line.accountCode],
    );
    if (account.rowCount === 0) {
      throw new Error(`Ledger account not found: ${line.accountCode}`);
    }

    await client.query(
      `
        INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, memo)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [entryId, account.rows[0].id, line.debit, line.credit, line.memo ?? null],
    );
  }

  return entryId;
}

/** Remove GL entry for a source (e.g. when an expense is deleted or re-posted). */
export async function deleteJournalEntryBySource(
  client: PoolClient,
  sourceType: string,
  sourceId: string,
): Promise<boolean> {
  const existing = await client.query(
    `SELECT id FROM journal_entries WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId],
  );
  if (!existing.rowCount) {
    return false;
  }

  const entryId = existing.rows[0].id as string;
  await client.query(`DELETE FROM journal_lines WHERE journal_entry_id = $1`, [entryId]);
  await client.query(`DELETE FROM journal_entries WHERE id = $1`, [entryId]);
  return true;
}
