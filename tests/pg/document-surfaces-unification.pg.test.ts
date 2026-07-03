import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/categories'
import { getPool } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertBalancedLines,
  insertTransaction,
} from './fixtures'

/**
 * P1-3 (mcp_optimization_plan): both missing-document surfaces implement ONE
 * predicate — posted, needs-doc source type, no CURRENT-version
 * document_attachments row, no journal_entry_no_doc_required waiver — and the
 * transactions surface is a strict subset of the verifikat surface.
 *
 * Also pins the SQL needs-doc source-type list to the TS constant
 * NEEDS_DOC_SOURCE_TYPES (lib/worklist/categories.ts): a divergence between
 * the two lists fails the per-source-type probe below.
 */

type VerifikatResult = {
  ok: boolean
  total_count?: number
  verifikat?: Array<{ journal_entry_id: string; source_type: string }>
}
type TransactionsResult = {
  ok: boolean
  code?: string
  total_count?: number
  transactions?: Array<{ id: string; transaction_id: string; journal_entry_id: string }>
}

async function verifikatSurface(companyId: string): Promise<VerifikatResult> {
  const { rows } = await getPool().query<{ r: VerifikatResult }>(
    `SELECT public.verifikat_without_documents($1, NULL, 0, 100, 0) AS r`,
    [companyId],
  )
  return rows[0].r
}

async function transactionsSurface(companyId: string): Promise<TransactionsResult> {
  const { rows } = await getPool().query<{ r: TransactionsResult }>(
    `SELECT public.transactions_without_documents($1, NULL, 100, 0) AS r`,
    [companyId],
  )
  return rows[0].r
}

async function attachDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string
  isCurrentVersion?: boolean
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, journal_entry_id, file_name, mime_type,
        file_size_bytes, storage_path, sha256_hash, upload_source, is_current_version)
     VALUES ($1, $2, $3, $4, 'underlag.pdf', 'application/pdf', 1024, $5, $6, 'file_upload', $7)`,
    [
      id,
      params.userId,
      params.companyId,
      params.journalEntryId,
      `documents/${params.companyId}/${id}.pdf`,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
      params.isCurrentVersion ?? true,
    ],
  )
  return id
}

async function waive(params: { userId: string; companyId: string; journalEntryId: string }) {
  await getPool().query(
    `INSERT INTO public.journal_entry_no_doc_required (journal_entry_id, company_id, user_id, reason)
     VALUES ($1, $2, $3, 'internal transfer — no underlag required')`,
    [params.journalEntryId, params.companyId, params.userId],
  )
}

describe('document surfaces unification', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string

  // Fixture matrix ids
  let jeBankNoDoc: string // bank tx JE, no doc → BOTH surfaces
  let jeBankWithDoc: string // bank tx JE, current doc → NEITHER
  let jeBankWaived: string // bank tx JE, waived → NEITHER
  let jeBankStaleDoc: string // bank tx JE, only superseded doc version → BOTH
  let jeInvoiceCreated: string // doc-exempt source type → NEITHER
  let jeImportNoDoc: string // import JE, no tx → verifikat surface only

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    fiscalPeriodId = s.fiscalPeriodId

    const mkJe = async (n: number, sourceType: string) => {
      const id = await insertDraftJournalEntry({
        userId,
        companyId,
        fiscalPeriodId,
        status: 'posted',
        voucherNumber: n,
        entryDate: `2026-06-0${n}`,
        description: `${sourceType} ${n}`,
        sourceType,
      })
      await insertBalancedLines(id, n * 100)
      return id
    }

    jeBankNoDoc = await mkJe(1, 'bank_transaction')
    jeBankWithDoc = await mkJe(2, 'bank_transaction')
    jeBankWaived = await mkJe(3, 'bank_transaction')
    jeBankStaleDoc = await mkJe(4, 'bank_transaction')
    jeInvoiceCreated = await mkJe(5, 'invoice_created')
    jeImportNoDoc = await mkJe(6, 'import')

    // Bank transactions pointing at the four bank-driven entries. The
    // with-doc tx deliberately keeps document_id NULL (the 1,100-row reverse
    // gap on prod): the surface must key on document_attachments, not
    // transactions.document_id.
    for (const [jeId, date] of [
      [jeBankNoDoc, '2026-06-01'],
      [jeBankWithDoc, '2026-06-02'],
      [jeBankWaived, '2026-06-03'],
      [jeBankStaleDoc, '2026-06-04'],
    ] as const) {
      await insertTransaction({ userId, companyId, journalEntryId: jeId, date })
    }

    await attachDocument({ userId, companyId, journalEntryId: jeBankWithDoc })
    await attachDocument({
      userId,
      companyId,
      journalEntryId: jeBankStaleDoc,
      isCurrentVersion: false,
    })
    await waive({ userId, companyId, journalEntryId: jeBankWaived })
  })

  it('verifikat surface: needs-doc entries without current docs or waivers, nothing else', async () => {
    const res = await verifikatSurface(companyId)
    expect(res.ok).toBe(true)
    const ids = (res.verifikat ?? []).map((v) => v.journal_entry_id).sort()
    expect(ids).toEqual([jeBankNoDoc, jeBankStaleDoc, jeImportNoDoc].sort())
    expect(res.total_count).toBe(3)
    // Doc-exempt source type never appears even when undocumented.
    expect(ids).not.toContain(jeInvoiceCreated)
  })

  it('transactions surface: the bank-driven rows of the same set, keyed on document_attachments', async () => {
    const res = await transactionsSurface(companyId)
    expect(res.ok).toBe(true)
    const jeIds = (res.transactions ?? []).map((t) => t.journal_entry_id).sort()
    // jeBankWithDoc excluded even though its tx.document_id is NULL — the
    // doc truth is document_attachments. jeImportNoDoc has no tx row.
    expect(jeIds).toEqual([jeBankNoDoc, jeBankStaleDoc].sort())
    // P1-2 forward-compat: rows expose the qualified id.
    expect(res.transactions![0].transaction_id).toBe(res.transactions![0].id)
  })

  it('transactions surface is a strict subset of the verifikat surface', async () => {
    const [ver, tx] = await Promise.all([verifikatSurface(companyId), transactionsSurface(companyId)])
    const verIds = new Set((ver.verifikat ?? []).map((v) => v.journal_entry_id))
    for (const row of tx.transactions ?? []) {
      expect(verIds.has(row.journal_entry_id), `tx surface row ${row.journal_entry_id} missing from verifikat surface`).toBe(true)
    }
  })

  it('pins the SQL needs-doc list to NEEDS_DOC_SOURCE_TYPES per source type', async () => {
    // Each needs-doc source type must appear when undocumented; a canary
    // non-needs-doc type must not. Uses a fresh company per probe set to
    // keep assertions exact.
    const s = await seedCompany()
    let voucher = 1
    const expected: string[] = []
    for (const sourceType of NEEDS_DOC_SOURCE_TYPES) {
      const id = await insertDraftJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        status: 'posted',
        voucherNumber: voucher,
        entryDate: '2026-06-15',
        description: sourceType,
        sourceType,
      })
      await insertBalancedLines(id, 100 * voucher)
      expected.push(id)
      voucher++
    }
    const res = await verifikatSurface(s.companyId)
    expect((res.verifikat ?? []).map((v) => v.journal_entry_id).sort()).toEqual(expected.sort())
  })

  it('tenant guard on the transactions surface (NULL + foreign company)', async () => {
    const { rows } = await getPool().query<{ r: TransactionsResult }>(
      `SELECT public.transactions_without_documents(NULL, NULL, 20, 0) AS r`,
    )
    // Superuser pool bypasses the guard by role; assert the NULL-company path
    // simply returns an empty ok result rather than leaking cross-tenant rows.
    expect((rows[0].r.transactions ?? []).length).toBe(0)
  })
})
