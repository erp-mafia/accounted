import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertAuthUser,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  insertBalancedLines,
} from './fixtures'

/**
 * Invariants for the verifikat_without_documents RPC (mcp_optimization_plan
 * P0-2). The predecessor applied min_amount in memory after the DB page:
 * total_count ignored the filter and consecutive pages overlapped. These
 * tests pin the SQL-side behavior: filter-respecting total, disjoint and
 * complete pages, since filter, doc/draft exclusion, tenant guard.
 */

type RpcRow = {
  journal_entry_id: string
  voucher_number: number
  gross_amount: number
}
type RpcResult = {
  ok: boolean
  code?: string
  total_count?: number
  verifikat?: RpcRow[]
}

async function callRpc(params: {
  companyId: string
  since?: string | null
  minAmount?: number
  limit?: number
  offset?: number
}): Promise<RpcResult> {
  const { rows } = await getPool().query<{ result: RpcResult }>(
    `SELECT public.verifikat_without_documents($1, $2, $3, $4, $5) AS result`,
    [
      params.companyId,
      params.since ?? null,
      params.minAmount ?? 0,
      params.limit ?? 20,
      params.offset ?? 0,
    ],
  )
  return rows[0].result
}

async function attachDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, journal_entry_id, file_name, mime_type,
        file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, $4, 'underlag.pdf', 'application/pdf', 1024, $5, $6, 'file_upload')`,
    [
      randomUUID(),
      params.userId,
      params.companyId,
      params.journalEntryId,
      `documents/${params.companyId}/underlag.pdf`,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
    ],
  )
}

describe('verifikat_without_documents RPC', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string
  // voucher_number → { id, amount }; amounts chosen so min_amount splits the set
  const seeded = new Map<number, { id: string; amount: number }>()

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    fiscalPeriodId = s.fiscalPeriodId

    // 6 posted entries without documents: amounts 100..600, dates ascending
    for (let i = 1; i <= 6; i++) {
      const id = await insertPostedJournalEntry({
        userId,
        companyId,
        fiscalPeriodId,
        voucherNumber: i,
        entryDate: `2026-06-0${i}`,
        description: `no-doc ${i}`,
        lines: [
          { accountNumber: '1930', debitAmount: i * 100, creditAmount: 0 },
          { accountNumber: '3001', debitAmount: 0, creditAmount: i * 100 },
        ],
      })
      seeded.set(i, { id, amount: i * 100 })
    }

    // Posted entry WITH a document: must never appear
    const withDoc = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 7,
      entryDate: '2026-06-07',
      description: 'has doc',
      lines: [
        { accountNumber: '1930', debitAmount: 700, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 700 },
      ],
    })
    await attachDocument({ userId, companyId, journalEntryId: withDoc })

    // Draft entry: must never appear
    const draft = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'draft',
      voucherNumber: 8,
      entryDate: '2026-06-08',
      description: 'draft',
    })
    await insertBalancedLines(draft, 800)
  })

  it('lists posted no-doc entries only, newest first, with gross amounts', async () => {
    const res = await callRpc({ companyId })
    expect(res.ok).toBe(true)
    expect(res.total_count).toBe(6)
    const rows = res.verifikat ?? []
    expect(rows.map((r) => r.voucher_number)).toEqual([6, 5, 4, 3, 2, 1])
    expect(rows[0].gross_amount).toBe(600)
  })

  it('total_count respects min_amount', async () => {
    const res = await callRpc({ companyId, minAmount: 350 })
    expect(res.ok).toBe(true)
    // amounts 400, 500, 600 pass the filter
    expect(res.total_count).toBe(3)
    expect((res.verifikat ?? []).map((r) => r.voucher_number)).toEqual([6, 5, 4])
  })

  it('paginates a filtered set with disjoint, complete pages', async () => {
    const collected: string[] = []
    let offset = 0
    for (;;) {
      const res = await callRpc({ companyId, minAmount: 250, limit: 2, offset })
      expect(res.ok).toBe(true)
      expect(res.total_count).toBe(4) // amounts 300..600
      const rows = res.verifikat ?? []
      if (rows.length === 0) break
      collected.push(...rows.map((r) => r.journal_entry_id))
      offset += rows.length
      if (offset >= (res.total_count ?? 0)) break
    }
    // No duplicates (the old in-memory filter overlapped pages) …
    expect(new Set(collected).size).toBe(collected.length)
    // … and no gaps: exactly the 4 entries ≥ 250.
    const expected = [3, 4, 5, 6].map((n) => seeded.get(n)!.id).sort()
    expect([...collected].sort()).toEqual(expected)
  })

  it('respects the since filter', async () => {
    const res = await callRpc({ companyId, since: '2026-06-04' })
    expect(res.ok).toBe(true)
    expect(res.total_count).toBe(3)
    expect((res.verifikat ?? []).map((r) => r.voucher_number)).toEqual([6, 5, 4])
  })

  it('offset past the end returns an empty page with a truthful total', async () => {
    const res = await callRpc({ companyId, minAmount: 250, limit: 2, offset: 10 })
    expect(res.ok).toBe(true)
    expect(res.total_count).toBe(4)
    expect(res.verifikat).toEqual([])
  })

  it('blocks an authenticated caller from another tenant', async () => {
    const strangerId = await insertAuthUser()
    const res = await withUserContext(strangerId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.verifikat_without_documents($1, NULL, 0, 20, 0) AS result`,
        [companyId],
      )
      return rows[0].result
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN')
  })

  it('rejects a NULL company id for authenticated callers (NOT IN → UNKNOWN bypass)', async () => {
    const res = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.verifikat_without_documents(NULL, NULL, 0, 20, 0) AS result`,
      )
      return rows[0].result
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN')
  })

  it('allows an authenticated member of the company', async () => {
    const res = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.verifikat_without_documents($1, NULL, 0, 20, 0) AS result`,
        [companyId],
      )
      return rows[0].result
    })
    expect(res.ok).toBe(true)
    expect(res.total_count).toBe(6)
  })
})

/**
 * gross_amount is the amount of the affärshändelse as its underlag and bank
 * row show it (crm#1062). Self-assessed reverse-charge and import moms
 * (2614/2624/2634, 2615/2625/2635) is owed by the buyer to Skatteverket and
 * is on neither, so it must not inflate the figure an agent matches against
 * the bank, the receipt hunt ranks on, or min_amount filters on.
 */
describe('verifikat_without_documents gross_amount under reverse charge and import', () => {
  let companyId: string
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    const s = await seedCompany()
    companyId = s.companyId
    const post = async (key: string, voucherNumber: number, lines: { accountNumber: string; debitAmount: number; creditAmount: number }[]) => {
      ids[key] = await insertPostedJournalEntry({
        userId: s.userId,
        companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        voucherNumber,
        entryDate: `2026-06-${String(voucherNumber).padStart(2, '0')}`,
        description: key,
        lines,
      })
    }

    // EU service under omvänd betalningsskyldighet, paid from the bank.
    await post('rc_purchase', 1, [
      { accountNumber: '4535', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2645', debitAmount: 250, creditAmount: 0 },
      { accountNumber: '2614', debitAmount: 0, creditAmount: 250 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
    ])
    // No deduction right: the self-assessed moms lands on the cost account.
    await post('rc_not_deductible', 2, [
      { accountNumber: '6540', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2614', debitAmount: 0, creditAmount: 250 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
    ])
    // Credit note on a reverse-charge purchase: the legs flip sides.
    await post('rc_credit_note', 3, [
      { accountNumber: '1930', debitAmount: 400, creditAmount: 0 },
      { accountNumber: '2614', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '4535', debitAmount: 0, creditAmount: 400 },
      { accountNumber: '2645', debitAmount: 0, creditAmount: 100 },
    ])
    // Import of goods at 12 %, self-assessed import moms.
    await post('import_goods', 4, [
      { accountNumber: '4000', debitAmount: 2000, creditAmount: 0 },
      { accountNumber: '2645', debitAmount: 240, creditAmount: 0 },
      { accountNumber: '2625', debitAmount: 0, creditAmount: 240 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: 2000 },
    ])
    // Only the self-assessment pair: no money changed hands.
    await post('rc_pair_only', 5, [
      { accountNumber: '2645', debitAmount: 250, creditAmount: 0 },
      { accountNumber: '2614', debitAmount: 0, creditAmount: 250 },
    ])
    // Domestic purchase: debited moms is on the invoice and the bank row.
    await post('domestic', 6, [
      { accountNumber: '6110', debitAmount: 800, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: 200, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
    ])
    // Reverse charge below 4 000 kr whose debit total reaches it.
    await post('rc_below_floor', 7, [
      { accountNumber: '4535', debitAmount: 3500, creditAmount: 0 },
      { accountNumber: '2645', debitAmount: 875, creditAmount: 0 },
      { accountNumber: '2614', debitAmount: 0, creditAmount: 875 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 3500 },
    ])
  })

  const amounts = async (minAmount = 0) => {
    const res = await callRpc({ companyId, minAmount, limit: 100 })
    expect(res.ok).toBe(true)
    const byId = new Map((res.verifikat ?? []).map((r) => [r.journal_entry_id, r.gross_amount]))
    return { res, byId }
  }

  it('reports the amount that left the bank for a reverse-charge purchase', async () => {
    const { byId } = await amounts()
    expect(byId.get(ids.rc_purchase)).toBe(1000)
  })

  it('leaves out the self-assessed moms whichever side and account it is on', async () => {
    const { byId } = await amounts()
    expect(byId.get(ids.rc_not_deductible)).toBe(1000)
    expect(byId.get(ids.rc_credit_note)).toBe(400)
    expect(byId.get(ids.import_goods)).toBe(2000)
    expect(byId.get(ids.rc_pair_only)).toBe(0)
    expect(byId.get(ids.domestic)).toBe(1000)
  })

  it('min_amount and total_count use the same amount', async () => {
    const { res, byId } = await amounts(1000)
    // 1000, 1000, 2000 and 3500 pass; the credit note (400) and the pair (0) do not.
    expect(res.total_count).toBe(5)
    expect(byId.has(ids.rc_credit_note)).toBe(false)
    expect(byId.has(ids.rc_pair_only)).toBe(false)

    const floor = await callRpc({ companyId, minAmount: 4000 })
    expect(floor.total_count).toBe(0)
    expect(floor.verifikat).toEqual([])
  })
})
