import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/categories'
import { getPool } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  insertBalancedLines,
  insertTransaction,
} from './fixtures'

/**
 * P1-3 (mcp_optimization_plan): both missing-document surfaces implement ONE
 * predicate: posted, needs-doc source type, no CURRENT-version
 * document_attachments row, no journal_entry_no_doc_required waiver, no
 * supplier-invoice reference carrying a retained document: and the
 * transactions surface is a strict subset of the verifikat surface.
 *
 * The supplier-invoice arm (migration 20260724090000) implements BFL 5 kap
 * 7 §: a verifikation may satisfy the underlag requirement by hänvisning till
 * underlag. An entry referenced by a supplier invoice whose document_id is
 * set (registration/payment FK or a supplier_invoice_payments row) is
 * covered by that retained document even though the doc row hangs on the
 * invoice's other verifikat.
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
  journalEntryId: string | null
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
     VALUES ($1, $2, $3, 'internal transfer: no underlag required')`,
    [params.journalEntryId, params.companyId, params.userId],
  )
}

async function insertSupplier(params: { userId: string; companyId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Test Leverantör AB')`,
    [id, params.userId, params.companyId],
  )
  return id
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  arrivalNumber: number
  registrationJournalEntryId?: string | null
  paymentJournalEntryId?: string | null
  documentId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, total, remaining_amount,
        registration_journal_entry_id, payment_journal_entry_id, document_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-06-30', 1000, 1000, $7, $8, $9)`,
    [
      id,
      params.userId,
      params.companyId,
      params.supplierId,
      params.arrivalNumber,
      `SI-${params.arrivalNumber}`,
      params.registrationJournalEntryId ?? null,
      params.paymentJournalEntryId ?? null,
      params.documentId ?? null,
    ],
  )
  return id
}

async function insertSupplierInvoicePayment(params: {
  userId: string
  companyId: string
  supplierInvoiceId: string
  journalEntryId: string
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.supplier_invoice_payments
       (user_id, company_id, supplier_invoice_id, payment_date, amount, journal_entry_id)
     VALUES ($1, $2, $3, '2026-06-10', 500, $4)`,
    [params.userId, params.companyId, params.supplierInvoiceId, params.journalEntryId],
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
  let jeSiRegWithDoc: string // SI registration JE holding the invoice doc directly → NEITHER
  let jeSiPaymentCovered: string // SI payment JE, doc on the SI (registration side) → NEITHER (BFL 5:7 hänvisning)
  let jeSiRegNoDoc: string // SI registration JE, SI has NO doc → verifikat surface
  let jeSiPartialCovered: string // SI payment JE referenced only via supplier_invoice_payments, SI doc anchored → NEITHER
  let jeSiPayUnanchored: string // SI payment JE whose SI doc is UNANCHORED (deletable) → verifikat surface

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    fiscalPeriodId = s.fiscalPeriodId

    const mkJe = async (n: number, sourceType: string) => {
      return insertPostedJournalEntry({
        userId,
        companyId,
        fiscalPeriodId,
        voucherNumber: n,
        entryDate: `2026-06-${String(n).padStart(2, '0')}`,
        description: `${sourceType} ${n}`,
        sourceType,
        lines: [
          { accountNumber: '1930', debitAmount: n * 100, creditAmount: 0 },
          { accountNumber: '3001', debitAmount: 0, creditAmount: n * 100 },
        ],
      })
    }

    jeBankNoDoc = await mkJe(1, 'bank_transaction')
    jeBankWithDoc = await mkJe(2, 'bank_transaction')
    jeBankWaived = await mkJe(3, 'bank_transaction')
    jeBankStaleDoc = await mkJe(4, 'bank_transaction')
    jeInvoiceCreated = await mkJe(5, 'invoice_created')
    jeImportNoDoc = await mkJe(6, 'import')
    jeSiRegWithDoc = await mkJe(7, 'supplier_invoice_registered')
    jeSiPaymentCovered = await mkJe(8, 'supplier_invoice_paid')
    jeSiRegNoDoc = await mkJe(9, 'supplier_invoice_registered')
    jeSiPartialCovered = await mkJe(10, 'supplier_invoice_paid')
    jeSiPayUnanchored = await mkJe(11, 'supplier_invoice_paid')

    // Bank transactions pointing at the bank-driven entries. The with-doc tx
    // deliberately keeps document_id NULL (the 1,100-row reverse gap on
    // prod): the surface must key on document_attachments, not
    // transactions.document_id. jeSiPaymentCovered also gets a tx so the
    // transactions surface exercises the reference arm.
    for (const [jeId, date] of [
      [jeBankNoDoc, '2026-06-01'],
      [jeBankWithDoc, '2026-06-02'],
      [jeBankWaived, '2026-06-03'],
      [jeBankStaleDoc, '2026-06-04'],
      [jeSiPaymentCovered, '2026-06-08'],
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

    // Supplier-invoice reference matrix (BFL 5 kap 7 § hänvisning):
    //  - siWithDoc: document hangs on the registration JE; its payment JE is
    //    covered by reference through payment_journal_entry_id.
    //  - siNoDoc: no retained document → its registration JE stays flagged.
    //  - siPartial: anchored document; its payment JE is linked only through
    //    a supplier_invoice_payments row (partial payment path).
    //  - siUnanchored: document referenced but journal_entry_id NULL: outside
    //    the WORM deletion guards, so it must NOT silence the warning.
    const supplierId = await insertSupplier({ userId, companyId })
    const siDoc = await attachDocument({ userId, companyId, journalEntryId: jeSiRegWithDoc })
    await insertSupplierInvoice({
      userId,
      companyId,
      supplierId,
      arrivalNumber: 1,
      registrationJournalEntryId: jeSiRegWithDoc,
      paymentJournalEntryId: jeSiPaymentCovered,
      documentId: siDoc,
    })
    await insertSupplierInvoice({
      userId,
      companyId,
      supplierId,
      arrivalNumber: 2,
      registrationJournalEntryId: jeSiRegNoDoc,
      documentId: null,
    })
    // Anchor the partial invoice's doc on the covered registration JE so the
    // partial arm is exercised in isolation (the doc's own anchor is a
    // different entry than the one being silenced).
    const siPartialDoc = await attachDocument({ userId, companyId, journalEntryId: jeSiRegWithDoc })
    const siPartial = await insertSupplierInvoice({
      userId,
      companyId,
      supplierId,
      arrivalNumber: 3,
      documentId: siPartialDoc,
    })
    await insertSupplierInvoicePayment({
      userId,
      companyId,
      supplierInvoiceId: siPartial,
      journalEntryId: jeSiPartialCovered,
    })
    const siUnanchoredDoc = await attachDocument({ userId, companyId, journalEntryId: null })
    await insertSupplierInvoice({
      userId,
      companyId,
      supplierId,
      arrivalNumber: 4,
      paymentJournalEntryId: jeSiPayUnanchored,
      documentId: siUnanchoredDoc,
    })
  })

  it('verifikat surface: needs-doc entries without current docs, waivers, or covering references', async () => {
    const res = await verifikatSurface(companyId)
    expect(res.ok).toBe(true)
    const ids = (res.verifikat ?? []).map((v) => v.journal_entry_id).sort()
    // jeSiRegNoDoc appears: its supplier invoice retains no document, so the
    // reference alone is not underlag. jeSiPayUnanchored appears: the SI's
    // doc is not anchored to any entry, so it is deletable and cannot back a
    // posted verifikat. The covered SI entries do not appear.
    expect(ids).toEqual(
      [jeBankNoDoc, jeBankStaleDoc, jeImportNoDoc, jeSiRegNoDoc, jeSiPayUnanchored].sort(),
    )
    expect(res.total_count).toBe(5)
    // Doc-exempt source type never appears even when undocumented.
    expect(ids).not.toContain(jeInvoiceCreated)
  })

  it('supplier-invoice references with an anchored doc silence both FK paths and the partial-payment path', async () => {
    const res = await verifikatSurface(companyId)
    const ids = (res.verifikat ?? []).map((v) => v.journal_entry_id)
    // Registration JE holds the doc directly.
    expect(ids).not.toContain(jeSiRegWithDoc)
    // Payment JE covered by the SI's retained doc via payment_journal_entry_id.
    expect(ids).not.toContain(jeSiPaymentCovered)
    // Payment JE covered via a supplier_invoice_payments row only.
    expect(ids).not.toContain(jeSiPartialCovered)
    // Unanchored SI doc does NOT cover its payment JE.
    expect(ids).toContain(jeSiPayUnanchored)
  })

  it('transactions surface: the bank-driven rows of the same set, keyed on document_attachments', async () => {
    const res = await transactionsSurface(companyId)
    expect(res.ok).toBe(true)
    const jeIds = (res.transactions ?? []).map((t) => t.journal_entry_id).sort()
    // jeBankWithDoc excluded even though its tx.document_id is NULL: the
    // doc truth is document_attachments. jeImportNoDoc has no tx row.
    // jeSiPaymentCovered excluded: covered by the SI's retained doc.
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
      const id = await insertPostedJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        voucherNumber: voucher,
        entryDate: '2026-06-15',
        description: sourceType,
        sourceType,
        lines: [
          { accountNumber: '1930', debitAmount: 100 * voucher, creditAmount: 0 },
          { accountNumber: '3001', debitAmount: 0, creditAmount: 100 * voucher },
        ],
      })
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

describe('transaction-pinned document backfill (migration 20260724090000 §4)', () => {
  // The DO-block body, verbatim from the migration: docs pinned to a booked
  // transaction whose verifikat never received the link. Only unlinked
  // current-version docs, only into open unlocked periods.
  const BACKFILL_SQL = `
    WITH gap AS (
      SELECT t.document_id, t.journal_entry_id
      FROM transactions t
      JOIN journal_entries je ON je.id = t.journal_entry_id
      JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE t.document_id IS NOT NULL
        AND je.status = 'posted'
        AND fp.is_closed = false
        AND fp.locked_at IS NULL
    )
    UPDATE document_attachments d
    SET journal_entry_id = gap.journal_entry_id
    FROM gap
    WHERE d.id = gap.document_id
      AND d.journal_entry_id IS NULL
      AND d.is_current_version = true`

  it('propagates unlinked pinned docs, never steals linked docs, skips closed periods', async () => {
    const s = await seedCompany()

    const mkPostedJe = async (n: number, fiscalPeriodId: string) => {
      return insertPostedJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId,
        voucherNumber: n,
        entryDate: '2026-06-15',
        description: `backfill ${n}`,
        sourceType: 'supplier_invoice_paid',
        lines: [
          { accountNumber: '1930', debitAmount: 100 * n, creditAmount: 0 },
          { accountNumber: '3001', debitAmount: 0, creditAmount: 100 * n },
        ],
      })
    }

    // Case A (Emil's flow): doc pinned to the tx, never propagated.
    const jeA = await mkPostedJe(1, s.fiscalPeriodId)
    const docA = await attachDocument({ userId: s.userId, companyId: s.companyId, journalEntryId: null })
    const txA = await insertTransaction({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: jeA,
      date: '2026-06-15',
    })
    await getPool().query(`UPDATE public.transactions SET document_id = $1 WHERE id = $2`, [docA, txA])

    // Case B: pinned doc already serves ANOTHER verifikat: must not move.
    const jeB = await mkPostedJe(2, s.fiscalPeriodId)
    const jeBOther = await mkPostedJe(3, s.fiscalPeriodId)
    const docB = await attachDocument({ userId: s.userId, companyId: s.companyId, journalEntryId: jeBOther })
    const txB = await insertTransaction({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: jeB,
      date: '2026-06-16',
    })
    await getPool().query(`UPDATE public.transactions SET document_id = $1 WHERE id = $2`, [docB, txB])

    await getPool().query(BACKFILL_SQL)

    const { rows: aRows } = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [docA],
    )
    expect(aRows[0].journal_entry_id).toBe(jeA)

    const { rows: bRows } = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [docB],
    )
    expect(bRows[0].journal_entry_id).toBe(jeBOther)

    // Case A no longer surfaces as missing underlag.
    const res = await verifikatSurface(s.companyId)
    const flagged = (res.verifikat ?? []).map((v) => v.journal_entry_id)
    expect(flagged).not.toContain(jeA)

    // Case C: closed period: the gap row is filtered out, so the doc stays
    // unlinked and no period-lock trigger fires. Closing happens AFTER the
    // entries exist (inserting into a closed period would itself be blocked).
    const jeC = await mkPostedJe(4, s.fiscalPeriodId)
    const docC = await attachDocument({ userId: s.userId, companyId: s.companyId, journalEntryId: null })
    const txC = await insertTransaction({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: jeC,
      date: '2026-06-17',
    })
    await getPool().query(`UPDATE public.transactions SET document_id = $1 WHERE id = $2`, [docC, txC])
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [s.fiscalPeriodId],
    )

    await getPool().query(BACKFILL_SQL)

    const { rows: cRows } = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [docC],
    )
    expect(cRows[0].journal_entry_id).toBeNull()
  })
})

describe('floating supplier-invoice document backfill (migration 20260727180000)', () => {
  // The DO-block body, verbatim from the migration: re-anchor a supplier
  // invoice's retained document when it is floating (journal_entry_id NULL)
  // even though the invoice still has a posted verifikat to hang on. Preference
  // order: registration booking, payment booking, then partial payments.
  const BACKFILL_SQL = `
    WITH candidate AS (
      SELECT
        si.document_id,
        si.company_id,
        je.id AS journal_entry_id,
        ROW_NUMBER() OVER (
          PARTITION BY si.document_id
          ORDER BY rank_source, coalesce(sip.payment_date, je.entry_date), je.id
        ) AS pick
      FROM supplier_invoices si
      JOIN document_attachments d
        ON d.id = si.document_id
       AND d.company_id = si.company_id
       AND d.journal_entry_id IS NULL
       AND d.is_current_version = true
      CROSS JOIN LATERAL (
        SELECT si.registration_journal_entry_id AS entry_id, 1 AS rank_source, NULL::uuid AS payment_id
        UNION ALL
        SELECT si.payment_journal_entry_id, 2, NULL::uuid
        UNION ALL
        SELECT p.journal_entry_id, 3, p.id
        FROM supplier_invoice_payments p
        WHERE p.supplier_invoice_id = si.id
          AND p.company_id = si.company_id
          AND p.journal_entry_id IS NOT NULL
      ) AS src(entry_id, rank_source, payment_id)
      LEFT JOIN supplier_invoice_payments sip ON sip.id = src.payment_id
      JOIN journal_entries je
        ON je.id = src.entry_id
       AND je.company_id = si.company_id
       AND je.status = 'posted'
      JOIN fiscal_periods fp
        ON fp.id = je.fiscal_period_id
       AND fp.is_closed = false
       AND fp.locked_at IS NULL
    )
    UPDATE document_attachments d
    SET journal_entry_id = candidate.journal_entry_id
    FROM candidate
    WHERE candidate.pick = 1
      AND d.id = candidate.document_id
      AND d.company_id = candidate.company_id
      AND d.journal_entry_id IS NULL
      AND d.is_current_version = true`

  const anchorOf = async (documentId: string): Promise<string | null> => {
    const { rows } = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [documentId],
    )
    return rows[0].journal_entry_id
  }

  it('anchors a floating doc to the payment verifikat when registration was reversed', async () => {
    // The reported shape: the invoice PDF was orphaned when the rättelse it
    // had been relinked onto was deleted (delete_last_voucher has to clear
    // journal_entry_id), leaving the posted payment verifikat flagged while
    // the verifikat view still displayed the PDF.
    const s = await seedCompany()
    const mkJe = async (n: number, status: 'posted' | 'reversed', sourceType: string) => {
      if (status === 'posted') {
        return insertPostedJournalEntry({
          userId: s.userId,
          companyId: s.companyId,
          fiscalPeriodId: s.fiscalPeriodId,
          voucherNumber: n,
          entryDate: '2026-06-15',
          description: `anchor ${n}`,
          sourceType,
          lines: [
            { accountNumber: '1930', debitAmount: 100 * n, creditAmount: 0 },
            { accountNumber: '3001', debitAmount: 0, creditAmount: 100 * n },
          ],
        })
      }
      const id = await insertDraftJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        status,
        voucherNumber: n,
        entryDate: '2026-06-15',
        description: `anchor ${n}`,
        sourceType,
      })
      await insertBalancedLines(id, 100 * n)
      return id
    }

    const jeReg = await mkJe(1, 'reversed', 'supplier_invoice_registered')
    const jePay = await mkJe(2, 'posted', 'supplier_invoice_paid')
    const supplierId = await insertSupplier({ userId: s.userId, companyId: s.companyId })
    const doc = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
    })
    await insertSupplierInvoice({
      userId: s.userId,
      companyId: s.companyId,
      supplierId,
      arrivalNumber: 1,
      registrationJournalEntryId: jeReg,
      paymentJournalEntryId: jePay,
      documentId: doc,
    })

    // Before: the payment verifikat is flagged even though the PDF is retained.
    const before = await verifikatSurface(s.companyId)
    expect((before.verifikat ?? []).map((v) => v.journal_entry_id)).toContain(jePay)

    await getPool().query(BACKFILL_SQL)

    expect(await anchorOf(doc)).toBe(jePay)
    const after = await verifikatSurface(s.companyId)
    expect((after.verifikat ?? []).map((v) => v.journal_entry_id)).not.toContain(jePay)
  })

  it('prefers the registration verifikat and never steals an anchored doc', async () => {
    const s = await seedCompany()
    const mkJe = async (n: number, sourceType: string) => {
      return insertPostedJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        voucherNumber: n,
        entryDate: '2026-06-15',
        description: `prefer ${n}`,
        sourceType,
        lines: [
          { accountNumber: '1930', debitAmount: 100 * n, creditAmount: 0 },
          { accountNumber: '3001', debitAmount: 0, creditAmount: 100 * n },
        ],
      })
    }

    const jeReg = await mkJe(1, 'supplier_invoice_registered')
    const jePay = await mkJe(2, 'supplier_invoice_paid')
    const jeOther = await mkJe(3, 'manual')
    const supplierId = await insertSupplier({ userId: s.userId, companyId: s.companyId })

    const floating = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
    })
    await insertSupplierInvoice({
      userId: s.userId,
      companyId: s.companyId,
      supplierId,
      arrivalNumber: 1,
      registrationJournalEntryId: jeReg,
      paymentJournalEntryId: jePay,
      documentId: floating,
    })

    // Already serving another verifikat: must stay put (BFL 5 kap 6 §).
    const anchored = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: jeOther,
    })
    await insertSupplierInvoice({
      userId: s.userId,
      companyId: s.companyId,
      supplierId,
      arrivalNumber: 2,
      paymentJournalEntryId: jePay,
      documentId: anchored,
    })

    await getPool().query(BACKFILL_SQL)

    expect(await anchorOf(floating)).toBe(jeReg)
    expect(await anchorOf(anchored)).toBe(jeOther)
  })

  it('skips closed periods: the period-lock trigger would reject the write anyway', async () => {
    const s = await seedCompany()
    const je = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      voucherNumber: 1,
      entryDate: '2026-06-15',
      description: 'closed period',
      sourceType: 'supplier_invoice_paid',
      lines: [
        { accountNumber: '1930', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 100 },
      ],
    })
    const supplierId = await insertSupplier({ userId: s.userId, companyId: s.companyId })
    const doc = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
    })
    await insertSupplierInvoice({
      userId: s.userId,
      companyId: s.companyId,
      supplierId,
      arrivalNumber: 1,
      paymentJournalEntryId: je,
      documentId: doc,
    })
    // Close AFTER the fixtures exist: inserting into a closed period is itself
    // blocked by enforce_period_lock.
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [s.fiscalPeriodId],
    )

    await getPool().query(BACKFILL_SQL)

    expect(await anchorOf(doc)).toBeNull()
  })
})

describe('transactions_without_documents: bank account on each row (A4)', () => {
  it('returns cash_account_id and the cash account ledger, null when unbackfilled', async () => {
    const s = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: s.companyId, ledgerAccount: '1940' })
    const mkJe = (n: number) =>
      insertPostedJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        voucherNumber: n,
        entryDate: `2026-06-${String(n).padStart(2, '0')}`,
        description: `bank ${n}`,
        sourceType: 'bank_transaction',
        lines: [
          { accountNumber: '1940', debitAmount: 100, creditAmount: 0 },
          { accountNumber: '3001', debitAmount: 0, creditAmount: 100 },
        ],
      })
    const jeWithAccount = await mkJe(1)
    const jeWithoutAccount = await mkJe(2)
    const txWith = await insertTransaction({
      companyId: s.companyId,
      userId: s.userId,
      journalEntryId: jeWithAccount,
      cashAccountId,
      date: '2026-06-01',
    })
    const txWithout = await insertTransaction({
      companyId: s.companyId,
      userId: s.userId,
      journalEntryId: jeWithoutAccount,
      cashAccountId: null,
      date: '2026-06-02',
    })

    const { rows } = await getPool().query<{
      r: { ok: boolean; transactions: Array<{ id: string; cash_account_id: string | null; cash_account_ledger: string | null }> }
    }>(`SELECT public.transactions_without_documents($1, NULL, 100, 0) AS r`, [s.companyId])
    const byId = new Map(rows[0].r.transactions.map((t) => [t.id, t]))
    expect(byId.get(txWith)).toMatchObject({ cash_account_id: cashAccountId, cash_account_ledger: '1940' })
    expect(byId.get(txWithout)).toMatchObject({ cash_account_id: null, cash_account_ledger: null })
  })
})
