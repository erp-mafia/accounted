/**
 * Link-basis coverage ratchet: every NEW link records why it exists
 * (src/lib/links/link-basis.ts). Coverage can only grow.
 *
 * The scan (./link-writer-scan.ts) finds every application writer of a link
 * and every SQL function that writes one. A writer that does not stamp
 * link_basis must be listed below, as a move or restore of an existing link
 * (no new link, nothing to say) or as a writer not stamped yet. The counts
 * are exact: a new unstamped writer fails here until it stamps, and a listed
 * writer that starts stamping fails here until its entry is removed, so the
 * list only ever shrinks.
 *
 * Stamping a SQL writer means restating its newest definition in a new
 * migration with link_basis / link_evidence in its inserts and updates (the
 * functiondef-patch guard forbids patching), with a pg-real test. A SQL
 * writer resolves its basis through public.resolve_link_basis
 * (20261016180100), the twin of ./stamp.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LINK_BASES } from '../link-basis'
import { ROOT, scanApplicationWriters, scanSqlWriters, unstampedByFile } from './link-writer-scan'

/** Application writes that move or restore an existing link: no new link, so no basis to record. */
const APP_MOVES_AND_RESTORES: Record<string, { count: number; why: string }> = {
  'src/lib/invoices/book-customer-bank-match.ts': {
    count: 1,
    why: 'the unwind puts the row back as it was read after a failed invoice or payment write.',
  },
  'src/lib/core/bookkeeping/storno-service.ts': {
    count: 2,
    why: 'relinkTransactionsToEntry moves the pointer and the voucher links to the correction; the basis follows (20261016160100 keeps it on transactions, the voucher-link update leaves it alone).',
  },
  'src/lib/reconciliation/bank-reconciliation.ts': {
    count: 1,
    why: 'linkTransactionToVouchers puts the pointer back to its previous value after a failed junction insert.',
  },
  'src/lib/transactions/link-journal-entry.ts': {
    count: 1,
    why: 'rollbackTxLink restores the row as it was read before a failed settlement.',
  },
}

/** Application writers of a new link that do not stamp a basis yet. Empty: shrink-only, never add. */
const APP_NOT_YET_STAMPED: Record<string, { count: number; why: string }> = {}

/** SQL functions whose link writes move or restore an existing link. */
const SQL_MOVES_AND_RESTORES: Record<string, string> = {
  delete_last_voucher: 'points bank rows and voucher links back at the original when the correction is deleted, and clears the rest.',
  relink_documents_to_correction: 'moves underlag onto the correction; the update leaves link_basis as it was.',
}

/** SQL functions that write a new link without a basis yet. Empty: shrink-only, never add. */
const SQL_NOT_YET_STAMPED: Record<string, string> = {}

describe('link-basis coverage ratchet', () => {
  const app = scanApplicationWriters()
  const sql = scanSqlWriters()

  it('finds the link writers it is meant to watch (the scan works)', () => {
    // A scan that silently stopped seeing the code would pass the ratchet
    // vacuously. These writers are known to exist and to stamp.
    const files = new Set(app.filter((s) => s.stamped).map((s) => s.file))
    for (const known of [
      'src/lib/invoices/invoice-payment-row.ts',
      'src/lib/transactions/bank-link.ts',
      'src/lib/transactions/categorize-core.ts',
      'src/lib/core/documents/document-service.ts',
      'src/lib/reconciliation/ledger-settlement-store.ts',
      'src/lib/invoices/book-supplier-bank-match.ts',
    ]) {
      expect(files, known).toContain(known)
    }
    expect(app.length).toBeGreaterThanOrEqual(40)
    expect(sql.map((s) => s.name)).toContain('bulk_book_transactions')
  })

  it('every unstamped application writer is listed, with its exact count', () => {
    const actual = unstampedByFile(app)
    const expected: Record<string, number> = {}
    for (const [file, { count }] of Object.entries({ ...APP_MOVES_AND_RESTORES })) expected[file] = count
    for (const [file, { count }] of Object.entries(APP_NOT_YET_STAMPED)) expected[file] = (expected[file] ?? 0) + count
    const unstampedSites = app
      .filter((s) => !s.stamped)
      .map((s) => `${s.file}:${s.line} ${s.op} ${s.table}`)
    expect(
      actual,
      `Unstamped link writers:\n  ${unstampedSites.join('\n  ')}\n` +
        'A new link writer stamps its basis: spread linkBasisColumns(...) into the payload (src/lib/links/stamp.ts). ' +
        'A listed file that now stamps more sites lowers or drops its entry.',
    ).toEqual(expected)
  })

  it('every unstamped SQL writer is listed, and a listed one that now stamps is removed', () => {
    const unstamped = sql.filter((s) => !s.stamped).map((s) => s.name).sort()
    const listed = [...Object.keys(SQL_MOVES_AND_RESTORES), ...Object.keys(SQL_NOT_YET_STAMPED)].sort()
    expect(
      unstamped,
      'A SQL function that writes a link without link_basis. Stamp it in its restated definition, or, if it only moves or restores an existing link, list it in SQL_MOVES_AND_RESTORES with why.',
    ).toEqual(listed)
  })

  it('the vocabulary in code is the one every CHECK constraint enforces', () => {
    const sqlText = fs.readFileSync(
      path.join(ROOT, 'supabase', 'migrations', '20261016160000_link_basis_columns.sql'),
      'utf8',
    )
    const checks = [...sqlText.matchAll(/ADD CONSTRAINT (\w+)_link_basis_check CHECK \(link_basis IN \(([^)]*)\)\)/g)]
    expect(checks.map((m) => m[1]).sort()).toEqual(
      [
        'account_reconciliation_settlements',
        'document_attachments',
        'invoice_payments',
        'supplier_invoice_payments',
        'transaction_voucher_links',
        'transactions',
      ].sort(),
    )
    for (const m of checks) {
      const values = [...m[2].matchAll(/'([a-z_]+)'/g)].map((v) => v[1])
      expect(values, m[1]).toEqual([...LINK_BASES])
    }
  })
})
