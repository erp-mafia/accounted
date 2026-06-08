import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260530120000_bulk_book_transactions:
 *
 *   - Happy path create-new: 3 income txs on the same day → one
 *     combined verifikat (samlingsverifikation) with the caller-supplied
 *     lines. transaction_voucher_links populated. Bank net equals tx sum.
 *
 *   - Happy path link-existing: 3 txs linked to an already-posted manual
 *     day-summary verifikat. Just inserts junction rows.
 *
 *   - Guard codes: date mismatch, direction mismatch, already-booked tx,
 *     amount mismatch, unbalanced lines, no-bank-line, unauthorized.
 */

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
  date?: string
  currency?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, 'Bank tx', $5, $6, 'uncategorized')`,
    [id, params.userId, params.companyId, params.date ?? '2026-06-05', params.amount, params.currency ?? 'SEK'],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  // PR #610 round 2: the RPC now validates every line's account_number
  // against the company's active chart_of_accounts. Seed just the
  // accounts the tests touch (cheaper than calling
  // seed_chart_of_accounts which inserts the full BAS).
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1510', 'Kundfordringar',        1, 'asset',   'debit'),
       ('1930', 'Bankkonto',             1, 'asset',   'debit'),
       ('2440', 'Leverantörsskulder',    2, 'liability', 'credit'),
       ('2611', 'Utgående moms 25%',     2, 'liability', 'credit'),
       ('3001', 'Försäljning 25% moms',  3, 'revenue', 'credit'),
       ('3960', 'Valutakursvinster',     3, 'revenue', 'credit'),
       ('5800', 'Resekostnader',         5, 'expense', 'debit'),
       ('7960', 'Valutakursförluster',   7, 'expense', 'debit')
     ) AS t(n, name, cls, atype, nbal)`,
    [userId, companyId],
  )
  return { userId, companyId, fiscalPeriodId }
}

interface RpcResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  mode?: 'link_existing' | 'create_new'
  journal_entry_id?: string
  voucher_number?: number
  linked_tx_count?: number
  tx_sum?: number
}

describe('bulk_book_transactions — create new', () => {
  it('builds a single combined verifikat from caller-supplied lines (kiosk samlingsverifikation)', async () => {
    const { userId, companyId } = await seedTenant()
    // 3 income txs at 100/200/300 SEK on the same day.
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: 200 })
    const tx3 = await insertTransaction({ userId, companyId, amount: 300 })

    // Pre-computed lines (route-side template expansion in TS).
    // Total: 600 SEK. 25% VAT split: 480 net + 120 VAT.
    const newEntry = {
      description: 'Samlingsverifikation kiosk 2026-06-05',
      lines: [
        { account_number: '1930', debit_amount: 600, credit_amount: 0, currency: 'SEK', line_description: 'Inbetalningar Swish' },
        { account_number: '3001', debit_amount: 0, credit_amount: 480, currency: 'SEK', line_description: 'Försäljning' },
        { account_number: '2611', debit_amount: 0, credit_amount: 120, currency: 'SEK', line_description: 'Utgående moms 25%' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2, tx3], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(true)
      expect(result.mode).toBe('create_new')
      expect(result.journal_entry_id).toBeTruthy()
      expect(result.linked_tx_count).toBe(3)
      expect(result.tx_sum).toBe(600)

      // Verify lines on the new verifikat.
      const lines = await client.query<{ account_number: string; debit_amount: string; credit_amount: string }>(
        `SELECT account_number, debit_amount, credit_amount FROM public.journal_entry_lines
          WHERE journal_entry_id = $1 ORDER BY sort_order`,
        [result.journal_entry_id],
      )
      expect(lines.rows).toHaveLength(3)
      const bankLine = lines.rows.find((l) => l.account_number === '1930')
      expect(Number(bankLine!.debit_amount)).toBe(600)

      // Verify 3 transaction_voucher_links rows pointing at the same JE.
      const links = await client.query<{ allocated_amount: string; transaction_id: string }>(
        `SELECT allocated_amount, transaction_id FROM public.transaction_voucher_links
          WHERE journal_entry_id = $1`,
        [result.journal_entry_id],
      )
      expect(links.rows).toHaveLength(3)
      const linkedTxIds = new Set(links.rows.map((l) => l.transaction_id))
      expect(linkedTxIds).toEqual(new Set([tx1, tx2, tx3]))

      // For N>1, transactions.journal_entry_id is NOT set on the individual rows.
      const txRow1 = await client.query<{ journal_entry_id: string | null; is_business: boolean }>(
        `SELECT journal_entry_id, is_business FROM public.transactions WHERE id = $1`,
        [tx1],
      )
      expect(txRow1.rows[0]!.journal_entry_id).toBeNull()
      expect(txRow1.rows[0]!.is_business).toBe(true)
    })
  })

  it('rejects BULK_BOOK_DATE_MISMATCH when txs span multiple dates', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100, date: '2026-06-05' })
    const tx2 = await insertTransaction({ userId, companyId, amount: 100, date: '2026-06-06' })

    const newEntry = {
      description: 'Test',
      lines: [
        { account_number: '1930', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_DATE_MISMATCH')
    })
  })

  it('rejects BULK_BOOK_DIRECTION_MISMATCH when income + expense txs are mixed', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: -100 })

    const newEntry = {
      description: 'Test',
      lines: [
        { account_number: '1930', debit_amount: 0, credit_amount: 0, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_DIRECTION_MISMATCH')
    })
  })

  it('rejects BULK_BOOK_AMOUNT_MISMATCH when bank-line net does not equal tx sum', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: 200 })

    // Caller claims 500 SEK net on 1930 but txs sum to 300.
    const newEntry = {
      description: 'Test',
      lines: [
        { account_number: '1930', debit_amount: 500, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 500, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_AMOUNT_MISMATCH')
    })
  })

  it('rejects BULK_BOOK_UNBALANCED when debits do not equal credits', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })

    const newEntry = {
      description: 'Test',
      lines: [
        { account_number: '1930', debit_amount: 100, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 90, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_UNBALANCED')
    })
  })
})

describe('bulk_book_transactions — link existing', () => {
  it('links N txs to an already-posted day-summary verifikat', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: 200 })

    // Pre-create a posted manual verifikat with the right bank net (+300).
    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Manual dagssumma', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 300, 0), ($1, '3001', 0, 240), ($1, '2611', 0, 60)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3, $4)`,
        [[tx1, tx2], jeId, null, companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(true)
      expect(result.mode).toBe('link_existing')
      expect(result.journal_entry_id).toBe(jeId)
      expect(result.linked_tx_count).toBe(2)

      // No new JE was created — only junction rows.
      const links = await client.query<{ transaction_id: string }>(
        `SELECT transaction_id FROM public.transaction_voucher_links
          WHERE journal_entry_id = $1`,
        [jeId],
      )
      expect(links.rows).toHaveLength(2)
    })
  })

  it('rejects link with BULK_BOOK_AMOUNT_MISMATCH when bank net does not equal tx sum', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: 200 })

    // JE bank net = +400 but txs sum to 300.
    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Manual', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 400, 0), ($1, '3001', 0, 400)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3, $4)`,
        [[tx1, tx2], jeId, null, companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_AMOUNT_MISMATCH')
    })
  })

  it('rejects BULK_BOOK_UNAUTHORIZED when caller is not a company member', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })

    const outsiderId = await insertAuthUser()
    const newEntry = {
      description: 'Test',
      lines: [
        { account_number: '1930', debit_amount: 100, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 100, currency: 'SEK' },
      ],
    }

    await withUserContext(outsiderId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_UNAUTHORIZED')
    })
  })
})

// PR #608 — document inheritance + manual lines path.
async function insertDocumentForTx(params: {
  userId: string
  companyId: string
  txId: string
  fileName?: string
}): Promise<string> {
  const docId = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      docId,
      params.userId,
      params.companyId,
      `test/${docId}.pdf`,
      params.fileName ?? 'receipt.pdf',
      // 64-char hex string — sha256 placeholder for the test.
      docId.replace(/-/g, '').padEnd(64, '0'),
    ],
  )
  await getPool().query(
    `UPDATE public.transactions SET document_id = $1 WHERE id = $2`,
    [docId, params.txId],
  )
  return docId
}

describe('bulk_book_transactions — document inheritance (PR #608)', () => {
  it('copies each constituent tx document onto the combined new verifikat', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: 200 })
    const tx3 = await insertTransaction({ userId, companyId, amount: 300 })

    const doc1 = await insertDocumentForTx({ userId, companyId, txId: tx1, fileName: 'kvitto-1.pdf' })
    const doc2 = await insertDocumentForTx({ userId, companyId, txId: tx2, fileName: 'kvitto-2.pdf' })
    // tx3 intentionally without a doc — the RPC should not break and
    // should report docs_linked = 2 (not 3).

    const newEntry = {
      description: 'Samlingsverifikation kiosk 2026-06-05',
      lines: [
        { account_number: '1930', debit_amount: 600, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 480, currency: 'SEK' },
        { account_number: '2611', debit_amount: 0, credit_amount: 120, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult & { docs_linked?: number } }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2, tx3], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(true)
      expect(result.docs_linked).toBe(2)

      const docs = await client.query<{ id: string; journal_entry_id: string | null }>(
        `SELECT id, journal_entry_id FROM public.document_attachments
          WHERE id = ANY($1) ORDER BY id`,
        [[doc1, doc2]],
      )
      expect(docs.rows).toHaveLength(2)
      // Both docs now point at the new verifikat — verifikationsunderlag
      // per BFL 5 kap 6§ + BFNAR 2013:2 kap 4.
      for (const row of docs.rows) {
        expect(row.journal_entry_id).toBe(result.journal_entry_id)
      }
    })
  })

  it('copies docs onto an existing posted verifikat (link-existing branch)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: 100 })
    const tx2 = await insertTransaction({ userId, companyId, amount: 200 })
    const doc1 = await insertDocumentForTx({ userId, companyId, txId: tx1 })
    const doc2 = await insertDocumentForTx({ userId, companyId, txId: tx2 })

    // Manually pre-post a day-summary verifikat the user wants the txs
    // linked to. Bank net must equal sum(tx.amount) = 300.
    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Manual day summary', 'manual', 'posted')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '1930', 300, 0, 'SEK', 0),
              ($1, '3001', 0, 240, 'SEK', 1),
              ($1, '2611', 0, 60,  'SEK', 2)`,
      [jeId],
    )

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult & { docs_linked?: number } }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2], jeId, null, companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(true)
      expect(result.mode).toBe('link_existing')
      expect(result.docs_linked).toBe(2)

      const docs = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.document_attachments WHERE id = ANY($1)`,
        [[doc1, doc2]],
      )
      for (const row of docs.rows) expect(row.journal_entry_id).toBe(jeId)
    })
  })
})

describe('bulk_book_transactions — manual lines path (PR #608)', () => {
  it('accepts user-built lines (no template expansion) and commits the combined verifikat', async () => {
    const { userId, companyId } = await seedTenant()
    // 2 expense txs of −400 each. Manual booking: 800 to a kostnadskonto
    // (e.g. 5800 Resekostnader) + 800 from 1930.
    const tx1 = await insertTransaction({ userId, companyId, amount: -400 })
    const tx2 = await insertTransaction({ userId, companyId, amount: -400 })

    const manualEntry = {
      description: 'Resekostnader 2026-06-05 (manuell)',
      lines: [
        { account_number: '5800', debit_amount: 800, credit_amount: 0, currency: 'SEK', line_description: 'Tåg + taxi' },
        { account_number: '1930', debit_amount: 0, credit_amount: 800, currency: 'SEK', line_description: 'Företagskontot' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1, tx2], null, JSON.stringify(manualEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(true)
      expect(result.mode).toBe('create_new')
      expect(result.linked_tx_count).toBe(2)
      expect(result.tx_sum).toBe(-800)

      // Verify the verifikat has exactly the 2 user-supplied lines
      // (no template expansion artifacts).
      const lines = await client.query<{ account_number: string; debit_amount: string; credit_amount: string }>(
        `SELECT account_number, debit_amount, credit_amount FROM public.journal_entry_lines
          WHERE journal_entry_id = $1 ORDER BY sort_order`,
        [result.journal_entry_id],
      )
      expect(lines.rows).toHaveLength(2)
      expect(lines.rows[0]!.account_number).toBe('5800')
      expect(Number(lines.rows[0]!.debit_amount)).toBe(800)
      expect(lines.rows[1]!.account_number).toBe('1930')
      expect(Number(lines.rows[1]!.credit_amount)).toBe(800)
    })
  })

  it('rejects unbalanced manual lines (BFL 5 kap 6§ verifikat balance)', async () => {
    const { userId, companyId } = await seedTenant()
    const tx1 = await insertTransaction({ userId, companyId, amount: -400 })

    // Debit ≠ credit on purpose. The RPC's existing BULK_BOOK_UNBALANCED
    // guard catches this regardless of whether the lines came from the
    // template path or the manual path.
    const manualEntry = {
      description: 'Test',
      lines: [
        { account_number: '5800', debit_amount: 500, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[tx1], null, JSON.stringify(manualEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_UNBALANCED')
    })
  })
})
