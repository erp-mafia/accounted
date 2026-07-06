import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertAuthUser,
  insertDraftJournalEntry,
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
      const id = await insertDraftJournalEntry({
        userId,
        companyId,
        fiscalPeriodId,
        status: 'posted',
        voucherNumber: i,
        entryDate: `2026-06-0${i}`,
        description: `no-doc ${i}`,
      })
      await insertBalancedLines(id, i * 100)
      seeded.set(i, { id, amount: i * 100 })
    }

    // Posted entry WITH a document: must never appear
    const withDoc = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      voucherNumber: 7,
      entryDate: '2026-06-07',
      description: 'has doc',
    })
    await insertBalancedLines(withDoc, 700)
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
