import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260901140000_targeted_fk_indexes.sql.
 *
 * These indexes exist to serve referential-integrity probes
 * (`SELECT 1 FROM <child> WHERE <fk> = $1 FOR KEY SHARE`) that Postgres runs
 * once per deleted parent row. What has to hold for that to work is a catalog
 * property, so that is what this asserts:
 *
 *   - the index exists on the expected table,
 *   - its LEADING key column is the fk column (a trailing position does not
 *     give the RI check a probe),
 *   - a partial index's predicate is exactly `<col> IS NOT NULL`, which the RI
 *     qual `<col> = $1` implies, so the planner may still use it.
 *
 * Deliberately NOT asserted: that EXPLAIN of the probe contains no "Seq Scan".
 * Against a fresh fixture these tables hold a handful of rows in a single heap
 * page, where the planner correctly prefers a seq scan whatever indexes exist,
 * so such an assertion fails regardless of the migration. Making it pass would
 * mean seeding thousands of rows and running ANALYZE inside the test, which
 * buys nothing over checking the shape the planner actually needs.
 */

type IndexSpec = {
  table: string
  index: string
  column: string
  /** null for a plain index, otherwise the expected pg_get_expr predicate */
  predicate: string | null
}

const EXPECTED: IndexSpec[] = [
  {
    table: 'event_log',
    index: 'idx_event_log_company_sequence',
    column: 'company_id',
    predicate: null,
  },
  {
    table: 'sie_imports',
    index: 'idx_sie_imports_opening_balance_entry',
    column: 'opening_balance_entry_id',
    predicate: '(opening_balance_entry_id IS NOT NULL)',
  },
  {
    table: 'skattekonto_transactions',
    index: 'idx_skattekonto_transactions_je',
    column: 'journal_entry_id',
    predicate: '(journal_entry_id IS NOT NULL)',
  },
  {
    table: 'skattekonto_transactions',
    index: 'idx_skattekonto_transactions_suggested_je',
    column: 'suggested_journal_entry_id',
    predicate: '(suggested_journal_entry_id IS NOT NULL)',
  },
  {
    table: 'supplier_invoices',
    index: 'idx_supplier_invoices_payment_je',
    column: 'payment_journal_entry_id',
    predicate: '(payment_journal_entry_id IS NOT NULL)',
  },
  {
    table: 'supplier_invoices',
    index: 'idx_supplier_invoices_registration_je',
    column: 'registration_journal_entry_id',
    predicate: '(registration_journal_entry_id IS NOT NULL)',
  },
  {
    table: 'supplier_invoices',
    index: 'idx_supplier_invoices_transaction_id',
    column: 'transaction_id',
    predicate: '(transaction_id IS NOT NULL)',
  },
  {
    table: 'transactions',
    index: 'idx_transactions_potential_journal_entry',
    column: 'potential_journal_entry_id',
    predicate: '(potential_journal_entry_id IS NOT NULL)',
  },
  {
    table: 'transactions',
    index: 'idx_transactions_invoice_id',
    column: 'invoice_id',
    predicate: '(invoice_id IS NOT NULL)',
  },
  {
    table: 'transactions',
    index: 'idx_transactions_potential_invoice_id',
    column: 'potential_invoice_id',
    predicate: '(potential_invoice_id IS NOT NULL)',
  },
  {
    table: 'invoices',
    index: 'idx_invoices_credited_invoice_id',
    column: 'credited_invoice_id',
    predicate: '(credited_invoice_id IS NOT NULL)',
  },
  {
    table: 'document_attachments',
    index: 'idx_document_attachments_superseded_by_id',
    column: 'superseded_by_id',
    predicate: '(superseded_by_id IS NOT NULL)',
  },
  {
    table: 'document_attachments',
    index: 'idx_document_attachments_uploaded_by',
    column: 'uploaded_by',
    predicate: null,
  },
  {
    table: 'invoice_inbox_items',
    index: 'idx_inbox_items_created_supplier_invoice',
    column: 'created_supplier_invoice_id',
    predicate: '(created_supplier_invoice_id IS NOT NULL)',
  },
  {
    table: 'invoice_inbox_items',
    index: 'idx_inbox_items_matched_supplier',
    column: 'matched_supplier_id',
    predicate: '(matched_supplier_id IS NOT NULL)',
  },
  {
    table: 'invoice_inbox_items',
    index: 'idx_inbox_items_document_id',
    column: 'document_id',
    predicate: null,
  },
  {
    table: 'deadlines',
    index: 'idx_deadlines_customer_id',
    column: 'customer_id',
    predicate: '(customer_id IS NOT NULL)',
  },
  {
    table: 'journal_entry_no_doc_required',
    index: 'idx_jenodoc_user',
    column: 'user_id',
    predicate: null,
  },
]

type IndexRow = {
  index_name: string
  table_name: string
  leading_column: string
  predicate: string | null
}

async function loadIndexes(): Promise<Map<string, IndexRow>> {
  const { rows } = await getPool().query<IndexRow>(
    `SELECT ci.relname AS index_name,
            ct.relname AS table_name,
            a.attname AS leading_column,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       JOIN pg_class ci ON ci.oid = i.indexrelid
       JOIN pg_class ct ON ct.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = ct.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE ci.relname = ANY($1::text[])`,
    [EXPECTED.map((spec) => spec.index)],
  )
  return new Map(rows.map((row) => [row.index_name, row]))
}

describe('targeted fk indexes.pg', () => {
  it('creates every index from 20260901140000 on the expected table', async () => {
    const found = await loadIndexes()
    const missing = EXPECTED.filter((spec) => !found.has(spec.index)).map((spec) => spec.index)
    expect(missing).toEqual([])

    for (const spec of EXPECTED) {
      expect(found.get(spec.index)!.table_name).toBe(spec.table)
    }
  })

  it('puts the foreign-key column first so the RI check gets a probe', async () => {
    const found = await loadIndexes()
    for (const spec of EXPECTED) {
      expect(`${spec.index}:${found.get(spec.index)!.leading_column}`).toBe(
        `${spec.index}:${spec.column}`,
      )
    }
  })

  it('restricts partial indexes to a predicate the RI qual implies', async () => {
    const found = await loadIndexes()
    for (const spec of EXPECTED) {
      expect(`${spec.index}:${found.get(spec.index)!.predicate ?? 'none'}`).toBe(
        `${spec.index}:${spec.predicate ?? 'none'}`,
      )
    }
  })

  it('leaves already-covered foreign keys with a single leading index', async () => {
    // These three plan as Index Cond probes on prod because their existing
    // partial index leads on the fk column and its predicate is implied by
    // `col = $1`. Adding a second index would be a pure duplicate, which is the
    // mistake migration 20260710101000 already had to undo on
    // journal_entry_lines, so guard against it here.
    const covered: Array<[string, string, string]> = [
      ['transactions', 'document_id', 'idx_transactions_document_id'],
      ['invoices', 'journal_entry_id', 'idx_invoices_journal_entry_id'],
      ['invoice_payments', 'journal_entry_id', 'idx_invoice_payments_je_inv_unique'],
    ]

    for (const [table, column, expectedIndex] of covered) {
      const { rows } = await getPool().query<{ index_name: string }>(
        `SELECT ci.relname AS index_name
           FROM pg_index i
           JOIN pg_class ci ON ci.oid = i.indexrelid
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = $1::regclass
            AND a.attname = $2
          ORDER BY ci.relname`,
        [`public.${table}`, column],
      )
      expect(rows.map((row) => row.index_name)).toEqual([expectedIndex])
    }
  })
})
