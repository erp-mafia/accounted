import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany, insertPostedJournalEntry, insertTransaction } from './fixtures'

/**
 * An imported verifikat (source_type 'import', an SIE file or a migration
 * from another program) keeps its underlag where the earlier books were kept,
 * so without an underlag in Accounted it is "Importerat, underlag i tidigare
 * system", not missing (BFL 5 kap 7 §: the verifikation says where the
 * documents behind it are available). Migration 20261127194500: the three
 * missing-underlag surfaces leave it out unless p_include_imported, and keep
 * every other rule (a current document, a waiver) as before.
 */

type VerifikatResult = { ok: boolean; total_count: number; verifikat: Array<{ journal_entry_id: string }> }
type ListResult = { ok: boolean; total_count: number; ids: string[] }
type TransactionsResult = { ok: boolean; total_count: number; transactions: Array<{ journal_entry_id: string }> }

describe('missing-underlag surfaces: imported verifikat are in the earlier system', () => {
  let companyId: string
  let importedAlone: string
  let importedWithRow: string
  let importedWithDoc: string
  let manualAlone: string
  let manualWithRow: string

  beforeAll(async () => {
    const s = await seedCompany()
    companyId = s.companyId
    const entry = (n: number, sourceType: string) =>
      insertPostedJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        voucherNumber: n,
        entryDate: `2026-05-${String(n).padStart(2, '0')}`,
        description: `${sourceType} ${n}`,
        sourceType,
        lines: [
          { accountNumber: '5010', debitAmount: 100 * n, creditAmount: 0 },
          { accountNumber: '1930', debitAmount: 0, creditAmount: 100 * n },
        ],
      })
    importedAlone = await entry(1, 'import')
    importedWithRow = await entry(2, 'import')
    importedWithDoc = await entry(3, 'import')
    manualAlone = await entry(4, 'manual')
    manualWithRow = await entry(5, 'manual')
    // Bank rows reconciled onto the verifikat, as a migration's rows are.
    await insertTransaction({ userId: s.userId, companyId, journalEntryId: importedWithRow, date: '2026-05-02', amount: -200 })
    await insertTransaction({ userId: s.userId, companyId, journalEntryId: manualWithRow, date: '2026-05-05', amount: -500 })
    const docId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, journal_entry_id, file_name, mime_type,
          file_size_bytes, storage_path, sha256_hash, upload_source, is_current_version)
       VALUES ($1, $2, $3, $4, 'kvitto.pdf', 'application/pdf', 1024, $5, $6, 'file_upload', true)`,
      [docId, s.userId, companyId, importedWithDoc, `documents/${companyId}/${docId}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    )
  })

  async function verifikat(includeImported?: boolean): Promise<string[]> {
    const { rows } = await getPool().query<{ r: VerifikatResult }>(
      includeImported === undefined
        ? `SELECT public.verifikat_without_documents($1, NULL, 0, 100, 0) AS r`
        : `SELECT public.verifikat_without_documents($1, NULL, 0, 100, 0, p_include_imported => $2) AS r`,
      includeImported === undefined ? [companyId] : [companyId, includeImported],
    )
    expect(rows[0].r.ok).toBe(true)
    expect(rows[0].r.total_count).toBe(rows[0].r.verifikat.length)
    return rows[0].r.verifikat.map((v) => v.journal_entry_id).sort()
  }

  async function list(includeImported?: boolean): Promise<string[]> {
    const { rows } = await getPool().query<{ r: ListResult }>(
      includeImported === undefined
        ? `SELECT public.list_verifikat_missing_underlag($1, p_limit => 1000) AS r`
        : `SELECT public.list_verifikat_missing_underlag($1, p_limit => 1000, p_include_imported => $2) AS r`,
      includeImported === undefined ? [companyId] : [companyId, includeImported],
    )
    expect(rows[0].r.ok).toBe(true)
    expect(rows[0].r.total_count).toBe(rows[0].r.ids.length)
    return [...rows[0].r.ids].sort()
  }

  async function transactions(includeImported?: boolean): Promise<string[]> {
    const { rows } = await getPool().query<{ r: TransactionsResult }>(
      includeImported === undefined
        ? `SELECT public.transactions_without_documents($1, NULL, 100, 0) AS r`
        : `SELECT public.transactions_without_documents($1, NULL, 100, 0, p_include_imported => $2) AS r`,
      includeImported === undefined ? [companyId] : [companyId, includeImported],
    )
    expect(rows[0].r.ok).toBe(true)
    return rows[0].r.transactions.map((t) => t.journal_entry_id).sort()
  }

  it('leaves imported verifikat out by default, a call that names only the old parameters included', async () => {
    expect(await verifikat()).toEqual([manualAlone, manualWithRow].sort())
    expect(await verifikat(false)).toEqual([manualAlone, manualWithRow].sort())
    expect(await list()).toEqual([manualAlone, manualWithRow].sort())
    expect(await transactions()).toEqual([manualWithRow])
  })

  it('lists them when asked for, every other rule kept: an imported verifikat with a document is never missing', async () => {
    expect(await verifikat(true)).toEqual([importedAlone, importedWithRow, manualAlone, manualWithRow].sort())
    expect(await list(true)).toEqual([importedAlone, importedWithRow, manualAlone, manualWithRow].sort())
    expect(await transactions(true)).toEqual([importedWithRow, manualWithRow].sort())
    expect(await verifikat(true)).not.toContain(importedWithDoc)
  })

  it('keeps the three surfaces agreeing in each mode', async () => {
    for (const includeImported of [false, true]) {
      const ver = await verifikat(includeImported)
      expect(await list(includeImported)).toEqual(ver)
      for (const id of await transactions(includeImported)) expect(ver).toContain(id)
    }
  })

  it('has exactly one signature of each function, so PostgREST resolves a call without ambiguity', async () => {
    const { rows } = await getPool().query<{ proname: string; n: number }>(
      `SELECT proname, count(*)::int AS n FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('verifikat_without_documents', 'list_verifikat_missing_underlag', 'transactions_without_documents')
        GROUP BY proname ORDER BY proname`,
    )
    expect(rows).toEqual([
      { proname: 'list_verifikat_missing_underlag', n: 1 },
      { proname: 'transactions_without_documents', n: 1 },
      { proname: 'verifikat_without_documents', n: 1 },
    ])
  })
})
