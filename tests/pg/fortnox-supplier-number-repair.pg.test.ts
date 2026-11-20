import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261013133930_repair_fortnox_supplier_invoice_numbers (crm#1157).
 *
 * The Fortnox import stored the löpnummer (GivenNumber) as the supplier's
 * invoice number. The repair matches each Fortnox record to its invoice (by
 * fortnox_number, or for an import from before that column by the löpnummer
 * in its supplier number on the same header), corrects a number that still is
 * the löpnummer, and leaves every other case alone with a reason.
 */

interface PgError extends Error {
  code?: string
}

interface RepairRow {
  given_number: string | null
  invoice_id: string | null
  outcome: string
  old_number: string | null
  new_number: string | null
  stamped: boolean
  old_reference_used: { source: string; status: string; date: string }[]
}

interface RepairReport {
  company_id: string
  dry_run: boolean
  correlation_id: string | null
  counts: Record<string, number>
  rows: RepairRow[]
}

interface FortnoxRecord {
  given_number: string
  invoice_number: string | null
  invoice_date?: string
  total?: number
  currency?: string
  is_credit_note?: boolean
  source?: string
}

const ACTOR = { type: 'user', id: randomUUID(), label: 'pg-real' }
const HEADER = { invoice_date: '2026-06-01', total: 1250, currency: 'SEK', is_credit_note: false }

let arrival = 1

async function supplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör AB')`,
    [id, userId, companyId],
  )
  return id
}

async function invoice(params: {
  companyId: string
  userId: string
  supplierId: string
  number: string | null
  fortnoxNumber?: string | null
  total?: number
  invoiceDate?: string
  status?: string
  paymentReference?: string | null
}): Promise<string> {
  const id = randomUUID()
  const total = params.total ?? HEADER.total
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, fortnox_number,
        invoice_date, due_date, status, currency, subtotal, vat_amount, total, remaining_amount, is_credit_note,
        payment_reference)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-06-30', $9, 'SEK', $10, 0, $10, $10, false, $11)`,
    [
      id, params.userId, params.companyId, params.supplierId, arrival++, params.number,
      params.fortnoxNumber ?? null, params.invoiceDate ?? HEADER.invoice_date, params.status ?? 'registered', total,
      params.paymentReference ?? null,
    ],
  )
  return id
}

async function numbers(id: string): Promise<{ supplier_invoice_number: string | null; fortnox_number: string | null }> {
  const { rows } = await getPool().query(
    `SELECT supplier_invoice_number, fortnox_number FROM public.supplier_invoices WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function numbersAndReference(id: string): Promise<{
  supplier_invoice_number: string | null
  payment_reference: string | null
  fortnox_number: string | null
}> {
  const { rows } = await getPool().query(
    `SELECT supplier_invoice_number, payment_reference, fortnox_number FROM public.supplier_invoices WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function events(companyId: string): Promise<{
  event_id: string
  aggregate_id: string
  correlation_id: string
  payload: Record<string, unknown>
  actor: Record<string, unknown>
}[]> {
  const { rows } = await getPool().query(
    `SELECT event_id, aggregate_id, correlation_id, payload, actor FROM public.processing_history
      WHERE company_id = $1 AND event_type = 'SupplierInvoiceNumberCorrected' ORDER BY seq`,
    [companyId],
  )
  return rows
}

function repair(
  client: PoolClient,
  params: { companyId: string | null; records: FortnoxRecord[]; dryRun?: boolean; actor?: object | null; correlationId?: string },
): Promise<RepairReport> {
  const rows = params.records.map((r) => ({ ...HEADER, source: 'stored_payload', ...r }))
  return client
    .query<{ report: RepairReport }>(
      `SELECT public.repair_fortnox_supplier_invoice_numbers($1, $2::jsonb, $3::jsonb, $4, $5) AS report`,
      [
        params.companyId,
        JSON.stringify(rows),
        params.actor === undefined ? JSON.stringify(ACTOR) : params.actor === null ? null : JSON.stringify(params.actor),
        params.dryRun ?? true,
        params.correlationId ?? null,
      ],
    )
    .then((r) => r.rows[0].report)
}

interface RevertReport {
  company_id: string
  dry_run: boolean
  reverted_correlation_id: string
  correlation_id: string | null
  counts: Record<string, number>
  rows: { invoice_id: string; fortnox_number: string; outcome: string }[]
}

function revert(
  client: PoolClient,
  params: { companyId: string | null; correlationId: string | null; dryRun?: boolean; actor?: object | null },
): Promise<RevertReport> {
  return client
    .query<{ report: RevertReport }>(
      `SELECT public.revert_fortnox_supplier_invoice_numbers($1, $2, $3::jsonb, $4) AS report`,
      [
        params.companyId,
        params.correlationId,
        params.actor === undefined ? JSON.stringify(ACTOR) : params.actor === null ? null : JSON.stringify(params.actor),
        params.dryRun ?? true,
      ],
    )
    .then((r) => r.rows[0].report)
}

function outcomeOf(report: RepairReport, given: string | null): RepairRow | undefined {
  return report.rows.find((r) => r.given_number === given)
}

async function captureError(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(
    () => null,
    (e: PgError) => e,
  )
}

describe('repair_fortnox_supplier_invoice_numbers', () => {
  it('reports every case in a dry run, corrects only a number that still is the löpnummer, and logs who and when', async () => {
    const { userId, companyId } = await seedCompany()
    const s1 = await supplier(companyId, userId)
    const s2 = await supplier(companyId, userId)

    const byColumn = await invoice({ companyId, userId, supplierId: s1, number: '101', fortnoxNumber: '101' })
    const legacy = await invoice({ companyId, userId, supplierId: s1, number: '102' })
    const sameNumber = await invoice({ companyId, userId, supplierId: s1, number: '103' })
    const noNumber = await invoice({ companyId, userId, supplierId: s1, number: '104' })
    const edited = await invoice({ companyId, userId, supplierId: s1, number: 'EGET-1', fortnoxNumber: '105' })
    const taken = await invoice({ companyId, userId, supplierId: s1, number: '106', fortnoxNumber: '106' })
    const handEntered = await invoice({ companyId, userId, supplierId: s1, number: 'INV-106' })
    const drifted = await invoice({ companyId, userId, supplierId: s1, number: '107', fortnoxNumber: '107', total: 999 })
    const legacyDrifted = await invoice({ companyId, userId, supplierId: s1, number: '117', invoiceDate: '2026-05-01' })
    const twinA = await invoice({ companyId, userId, supplierId: s1, number: '108' })
    const twinB = await invoice({ companyId, userId, supplierId: s2, number: '108' })
    const creditedTaken = await invoice({
      companyId, userId, supplierId: s1, number: '109', fortnoxNumber: '109', status: 'credited',
    })
    await invoice({ companyId, userId, supplierId: s1, number: 'INV-109' })

    // A payment file made from Accounted with the löpnummer as reference.
    const { rows: batchRows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.supplier_payment_batches
         (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
       VALUES ($1, $2, 'bg_lb', 1250, 1, 'MSG-1', '{}'::jsonb) RETURNING id`,
      [companyId, userId],
    )
    await getPool().query(
      `INSERT INTO public.supplier_payment_batch_items
         (batch_id, company_id, supplier_invoice_id, amount, payment_date, payee_type, payee_bankgiro,
          payee_name, reference_type, reference)
       VALUES ($1, $2, $3, 1250, '2026-06-20', 'bankgiro', '123-4567', 'Leverantör AB', 'invoice_number', '101')`,
      [batchRows[0].id, companyId, byColumn],
    )

    // Another company's invoice with the same löpnummer is never reached.
    const other = await seedCompany()
    const otherSupplier = await supplier(other.companyId, other.userId)
    const otherInvoice = await invoice({
      companyId: other.companyId, userId: other.userId, supplierId: otherSupplier, number: '101', fortnoxNumber: '101',
    })

    const records: FortnoxRecord[] = [
      { given_number: '101', invoice_number: 'INV-101' },
      { given_number: '102', invoice_number: 'INV-102' },
      { given_number: '103', invoice_number: '103' },
      { given_number: '104', invoice_number: '   ' },
      { given_number: '105', invoice_number: 'INV-105' },
      { given_number: '106', invoice_number: 'INV-106' },
      { given_number: '107', invoice_number: 'INV-107' },
      { given_number: '117', invoice_number: 'INV-117' },
      { given_number: '108', invoice_number: 'INV-108' },
      { given_number: '109', invoice_number: 'INV-109' },
      { given_number: '999', invoice_number: 'INV-999' },
      { given_number: '', invoice_number: 'INV-0' },
    ]

    const dry = await runAsServiceRole((c) => repair(c, { companyId, records, actor: null }))
    expect(dry.dry_run).toBe(true)
    expect(dry.correlation_id).toBeNull()
    expect(dry.counts).toEqual({
      corrected: 3,
      already_correct: 1,
      no_supplier_number: 1,
      changed_by_user: 1,
      number_taken: 1,
      header_mismatch: 2,
      ambiguous: 1,
      not_found: 1,
      invalid_row: 1,
    })
    expect(outcomeOf(dry, '101')).toMatchObject({
      invoice_id: byColumn, outcome: 'corrected', old_number: '101', new_number: 'INV-101', stamped: false,
      old_reference_used: [{ source: 'payment_file', status: 'created', date: '2026-06-20' }],
    })
    expect(outcomeOf(dry, '102')).toMatchObject({ invoice_id: legacy, outcome: 'corrected', stamped: true })
    expect(outcomeOf(dry, '103')).toMatchObject({ invoice_id: sameNumber, outcome: 'already_correct', stamped: true })
    expect(outcomeOf(dry, '104')).toMatchObject({ invoice_id: noNumber, outcome: 'no_supplier_number', stamped: true })
    expect(outcomeOf(dry, '105')).toMatchObject({ invoice_id: edited, outcome: 'changed_by_user' })
    expect(outcomeOf(dry, '106')).toMatchObject({ invoice_id: taken, outcome: 'number_taken' })
    expect(outcomeOf(dry, '107')).toMatchObject({ invoice_id: drifted, outcome: 'header_mismatch' })
    expect(outcomeOf(dry, '117')).toMatchObject({ invoice_id: null, outcome: 'header_mismatch' })
    expect(outcomeOf(dry, '108')).toMatchObject({ invoice_id: null, outcome: 'ambiguous' })
    // A credited invoice is outside the unique rule: its number can follow
    // the supplier's even where a live invoice already has it.
    expect(outcomeOf(dry, '109')).toMatchObject({ invoice_id: creditedTaken, outcome: 'corrected' })
    expect(outcomeOf(dry, '999')).toMatchObject({ invoice_id: null, outcome: 'not_found' })
    expect(outcomeOf(dry, null)).toMatchObject({ outcome: 'invalid_row' })

    // The dry run wrote nothing.
    expect(await numbers(byColumn)).toEqual({ supplier_invoice_number: '101', fortnox_number: '101' })
    expect(await numbers(legacy)).toEqual({ supplier_invoice_number: '102', fortnox_number: null })
    expect(await numbers(sameNumber)).toEqual({ supplier_invoice_number: '103', fortnox_number: null })
    expect(await events(companyId)).toEqual([])

    const correlationId = randomUUID()
    const written = await runAsServiceRole((c) => repair(c, { companyId, records, dryRun: false, correlationId }))
    expect(written.correlation_id).toBe(correlationId)
    expect(written.counts).toEqual(dry.counts)

    expect(await numbers(byColumn)).toEqual({ supplier_invoice_number: 'INV-101', fortnox_number: '101' })
    expect(await numbers(legacy)).toEqual({ supplier_invoice_number: 'INV-102', fortnox_number: '102' })
    expect(await numbers(sameNumber)).toEqual({ supplier_invoice_number: '103', fortnox_number: '103' })
    expect(await numbers(noNumber)).toEqual({ supplier_invoice_number: '104', fortnox_number: '104' })
    expect(await numbers(creditedTaken)).toEqual({ supplier_invoice_number: 'INV-109', fortnox_number: '109' })
    // Every case that is not a correction stays exactly as it was.
    expect(await numbers(edited)).toEqual({ supplier_invoice_number: 'EGET-1', fortnox_number: '105' })
    expect(await numbers(taken)).toEqual({ supplier_invoice_number: '106', fortnox_number: '106' })
    expect(await numbers(handEntered)).toEqual({ supplier_invoice_number: 'INV-106', fortnox_number: null })
    expect(await numbers(drifted)).toEqual({ supplier_invoice_number: '107', fortnox_number: '107' })
    expect(await numbers(legacyDrifted)).toEqual({ supplier_invoice_number: '117', fortnox_number: null })
    expect(await numbers(twinA)).toEqual({ supplier_invoice_number: '108', fortnox_number: null })
    expect(await numbers(twinB)).toEqual({ supplier_invoice_number: '108', fortnox_number: null })
    expect(await numbers(otherInvoice)).toEqual({ supplier_invoice_number: '101', fortnox_number: '101' })

    // One event per correction, none for a stamp, with who, when and both numbers.
    const logged = await events(companyId)
    expect(logged.map((e) => e.aggregate_id).sort()).toEqual([byColumn, legacy, creditedTaken].sort())
    for (const e of logged) {
      expect(e.correlation_id).toBe(correlationId)
      expect(e.actor).toMatchObject({ type: 'user', id: ACTOR.id })
    }
    expect(logged.find((e) => e.aggregate_id === legacy)?.payload).toMatchObject({
      issue: 'crm#1157',
      fortnox_number: '102',
      source: 'stored_payload',
      before: { supplier_invoice_number: '102', fortnox_number: null },
      after: { supplier_invoice_number: 'INV-102', fortnox_number: '102' },
    })

    // A rerun changes nothing and logs nothing new.
    const rerun = await runAsServiceRole((c) => repair(c, { companyId, records, dryRun: false }))
    expect(rerun.counts.corrected).toBeUndefined()
    expect(outcomeOf(rerun, '101')).toMatchObject({ outcome: 'already_correct', stamped: false })
    expect(outcomeOf(rerun, '102')).toMatchObject({ outcome: 'already_correct', stamped: false })
    expect(await events(companyId)).toHaveLength(3)
  })

  it('applies crm#1039: a number another invoice of the supplier keeps becomes the payment reference, earliest invoice first', async () => {
    const { userId, companyId } = await seedCompany()
    const [sA, sB, sC, sD, sE, sF] = await Promise.all(
      Array.from({ length: 6 }, () => supplier(companyId, userId)),
    )
    const at = (d: string) => ({ invoice_date: d })

    // An invoice entered by hand keeps AG-1 since May: the June one gets it as reference.
    await invoice({ companyId, userId, supplierId: sA, number: 'AG-1', invoiceDate: '2026-05-01' })
    const reused = await invoice({ companyId, userId, supplierId: sA, number: '301' })
    // Two imports with the same reference: the earlier invoice keeps the
    // number although its löpnummer is the higher one.
    const april = await invoice({ companyId, userId, supplierId: sB, number: '402', invoiceDate: '2026-04-01' })
    const may = await invoice({ companyId, userId, supplierId: sB, number: '401', invoiceDate: '2026-05-01' })
    // Another payment reference (an OCR) on the invoice: both cannot be kept.
    await invoice({ companyId, userId, supplierId: sC, number: 'Y-1', invoiceDate: '2026-05-01' })
    const withOcr = await invoice({ companyId, userId, supplierId: sC, number: '601', paymentReference: '7001234' })
    // A number-less invoice keeps Z-1 as reference on the same date: the same invoice.
    await invoice({ companyId, userId, supplierId: sD, number: 'Z-1', invoiceDate: '2026-03-01' })
    await invoice({ companyId, userId, supplierId: sD, number: null, paymentReference: 'Z-1' })
    const sameDay = await invoice({ companyId, userId, supplierId: sD, number: '701' })
    // The supplier's number of one is the löpnummer of another invoice this
    // run moves: it waits for that one and then takes the number.
    const mover = await invoice({ companyId, userId, supplierId: sE, number: '801', fortnoxNumber: '801' })
    const waiter = await invoice({
      companyId, userId, supplierId: sE, number: '802', fortnoxNumber: '802', invoiceDate: '2026-05-01',
    })
    // Two invoices each holding the other's number: left alone.
    const swapA = await invoice({ companyId, userId, supplierId: sF, number: '901', fortnoxNumber: '901' })
    const swapB = await invoice({ companyId, userId, supplierId: sF, number: '902', fortnoxNumber: '902' })

    const records: FortnoxRecord[] = [
      { given_number: '301', invoice_number: 'AG-1' },
      { given_number: '401', invoice_number: 'MONTHLY', ...at('2026-05-01') },
      { given_number: '402', invoice_number: 'MONTHLY', ...at('2026-04-01') },
      { given_number: '601', invoice_number: 'Y-1' },
      { given_number: '701', invoice_number: 'Z-1' },
      { given_number: '801', invoice_number: 'E-REAL' },
      { given_number: '802', invoice_number: '801', ...at('2026-05-01') },
      { given_number: '901', invoice_number: '902' },
      { given_number: '902', invoice_number: '901' },
    ]

    const dry = await runAsServiceRole((c) => repair(c, { companyId, records, actor: null }))
    expect(dry.counts).toEqual({ corrected: 3, reused_number: 2, number_taken: 4 })
    expect(outcomeOf(dry, '301')).toMatchObject({ outcome: 'reused_number', payment_reference: 'AG-1' })
    expect(outcomeOf(dry, '402')).toMatchObject({ outcome: 'corrected', new_number: 'MONTHLY' })
    expect(outcomeOf(dry, '401')).toMatchObject({ outcome: 'reused_number', payment_reference: 'MONTHLY' })
    expect(outcomeOf(dry, '601')).toMatchObject({ outcome: 'number_taken' })
    expect(outcomeOf(dry, '701')).toMatchObject({ outcome: 'number_taken' })
    expect(outcomeOf(dry, '801')).toMatchObject({ outcome: 'corrected' })
    expect(outcomeOf(dry, '802')).toMatchObject({ outcome: 'corrected', new_number: '801' })
    expect(outcomeOf(dry, '901')).toMatchObject({ outcome: 'number_taken' })
    expect(outcomeOf(dry, '902')).toMatchObject({ outcome: 'number_taken' })
    expect(await numbersAndReference(reused)).toEqual({ supplier_invoice_number: '301', payment_reference: null, fortnox_number: null })

    const written = await runAsServiceRole((c) => repair(c, { companyId, records, dryRun: false }))
    expect(written.counts).toEqual(dry.counts)

    expect(await numbersAndReference(reused)).toEqual({ supplier_invoice_number: null, payment_reference: 'AG-1', fortnox_number: '301' })
    expect(await numbersAndReference(april)).toEqual({ supplier_invoice_number: 'MONTHLY', payment_reference: null, fortnox_number: '402' })
    expect(await numbersAndReference(may)).toEqual({ supplier_invoice_number: null, payment_reference: 'MONTHLY', fortnox_number: '401' })
    expect(await numbersAndReference(withOcr)).toEqual({ supplier_invoice_number: '601', payment_reference: '7001234', fortnox_number: null })
    expect(await numbersAndReference(sameDay)).toEqual({ supplier_invoice_number: '701', payment_reference: null, fortnox_number: null })
    expect(await numbers(mover)).toEqual({ supplier_invoice_number: 'E-REAL', fortnox_number: '801' })
    expect(await numbers(waiter)).toEqual({ supplier_invoice_number: '801', fortnox_number: '802' })
    expect(await numbers(swapA)).toEqual({ supplier_invoice_number: '901', fortnox_number: '901' })
    expect(await numbers(swapB)).toEqual({ supplier_invoice_number: '902', fortnox_number: '902' })

    const logged = await events(companyId)
    expect(logged).toHaveLength(5)
    expect(logged.find((e) => e.aggregate_id === reused)?.payload).toMatchObject({
      rule: 'reused_number_as_payment_reference',
      fortnox_number: '301',
      before: { supplier_invoice_number: '301', payment_reference: null, fortnox_number: null },
      after: { supplier_invoice_number: null, payment_reference: 'AG-1', fortnox_number: '301' },
    })

    // A rerun leaves everything as it is.
    const rerun = await runAsServiceRole((c) => repair(c, { companyId, records, dryRun: false }))
    expect(rerun.counts.corrected).toBeUndefined()
    expect(rerun.counts.reused_number).toBeUndefined()
    expect(await events(companyId)).toHaveLength(5)
  })

  it('records its write order, and a revert restores number and payment reference exactly, in reverse order', async () => {
    const { userId, companyId } = await seedCompany()
    const [sA, sE, sP, sQ, sX] = await Promise.all(Array.from({ length: 5 }, () => supplier(companyId, userId)))
    await invoice({ companyId, userId, supplierId: sA, number: 'AG-1', invoiceDate: '2026-05-01' })
    const reused = await invoice({ companyId, userId, supplierId: sA, number: '301' })
    const mover = await invoice({ companyId, userId, supplierId: sE, number: '801', fortnoxNumber: '801' })
    const waiter = await invoice({
      companyId, userId, supplierId: sE, number: '802', fortnoxNumber: '802', invoiceDate: '2026-05-01',
    })
    const withOcr = await invoice({ companyId, userId, supplierId: sP, number: '101', paymentReference: '7001234' })
    const retaken = await invoice({ companyId, userId, supplierId: sQ, number: '121' })
    const edited = await invoice({ companyId, userId, supplierId: sX, number: '111', fortnoxNumber: '111' })
    const ids = [reused, mover, waiter, withOcr, retaken, edited]
    const before = await Promise.all(ids.map(numbersAndReference))

    const records: FortnoxRecord[] = [
      { given_number: '301', invoice_number: 'AG-1' },
      { given_number: '801', invoice_number: 'E-REAL' },
      { given_number: '802', invoice_number: '801', invoice_date: '2026-05-01' },
      { given_number: '101', invoice_number: 'INV-101' },
      { given_number: '121', invoice_number: 'INV-121' },
      { given_number: '111', invoice_number: 'INV-111' },
    ]
    const repairId = randomUUID()
    const repaired = await runAsServiceRole((c) => repair(c, { companyId, records, dryRun: false, correlationId: repairId }))
    expect(repaired.counts).toEqual({ corrected: 5, reused_number: 1 })
    const logged = await events(companyId)
    const seqOf = (id: string) => Number(logged.find((e) => e.aggregate_id === id)?.payload.seq)
    expect(logged.every((e) => Number.isInteger(Number(e.payload.seq)))).toBe(true)
    // The invoice that gave the number up was written before the one that took it.
    expect(seqOf(mover)).toBeLessThan(seqOf(waiter))

    // After the repair: one invoice edited by hand, and the old number of
    // another taken by a new invoice of the same supplier.
    await getPool().query(`UPDATE public.supplier_invoices SET supplier_invoice_number = 'EDITED' WHERE id = $1`, [edited])
    await invoice({ companyId, userId, supplierId: sQ, number: '121', invoiceDate: '2026-07-01' })
    const repairedState = await Promise.all(ids.map(numbersAndReference))

    const dry = await runAsServiceRole((c) => revert(c, { companyId, correlationId: repairId, actor: null }))
    expect(dry).toMatchObject({ dry_run: true, correlation_id: null, reverted_correlation_id: repairId })
    expect(dry.counts).toEqual({ reverted: 4, changed_since: 1, number_taken: 1 })
    expect(await Promise.all(ids.map(numbersAndReference))).toEqual(repairedState)
    const { rows: noReverts } = await getPool().query(
      `SELECT 1 FROM public.processing_history WHERE company_id = $1 AND event_type = 'SupplierInvoiceNumberCorrectionReverted'`,
      [companyId],
    )
    expect(noReverts).toEqual([])

    const reverted = await runAsServiceRole((c) => revert(c, { companyId, correlationId: repairId, dryRun: false }))
    expect(reverted.counts).toEqual(dry.counts)
    const byInvoice = (id: string) => reverted.rows.find((r) => r.invoice_id === id)?.outcome
    expect([reused, mover, waiter, withOcr].map(byInvoice)).toEqual(['reverted', 'reverted', 'reverted', 'reverted'])
    expect(byInvoice(edited)).toBe('changed_since')
    expect(byInvoice(retaken)).toBe('number_taken')

    // Number and payment reference exactly as before the repair; the
    // löpnummer stays stamped.
    const after = await Promise.all(ids.map(numbersAndReference))
    for (const [i, id] of ids.entries()) {
      if (id === edited || id === retaken) continue
      expect({ number: after[i].supplier_invoice_number, reference: after[i].payment_reference })
        .toEqual({ number: before[i].supplier_invoice_number, reference: before[i].payment_reference })
    }
    expect(await numbersAndReference(reused)).toEqual({ supplier_invoice_number: '301', payment_reference: null, fortnox_number: '301' })
    expect(await numbersAndReference(withOcr)).toEqual({ supplier_invoice_number: '101', payment_reference: '7001234', fortnox_number: '101' })
    expect(await numbers(mover)).toEqual({ supplier_invoice_number: '801', fortnox_number: '801' })
    expect(await numbers(waiter)).toEqual({ supplier_invoice_number: '802', fortnox_number: '802' })
    expect(await numbers(edited)).toEqual({ supplier_invoice_number: 'EDITED', fortnox_number: '111' })
    expect(await numbersAndReference(retaken)).toEqual({ supplier_invoice_number: 'INV-121', payment_reference: null, fortnox_number: '121' })

    const { rows: revertEvents } = await getPool().query<{
      aggregate_id: string
      correlation_id: string
      causation_id: string
      payload: Record<string, unknown>
      actor: Record<string, unknown>
    }>(
      `SELECT aggregate_id, correlation_id, causation_id, payload, actor FROM public.processing_history
        WHERE company_id = $1 AND event_type = 'SupplierInvoiceNumberCorrectionReverted'`,
      [companyId],
    )
    expect(revertEvents.map((e) => e.aggregate_id).sort()).toEqual([reused, mover, waiter, withOcr].sort())
    for (const e of revertEvents) {
      expect(e.correlation_id).toBe(reverted.correlation_id)
      expect(e.actor).toMatchObject({ type: 'user', id: ACTOR.id })
      expect(e.payload.reverted_correlation_id).toBe(repairId)
    }
    const reusedRevert = revertEvents.find((e) => e.aggregate_id === reused)
    expect(reusedRevert?.causation_id).toBe(logged.find((e) => e.aggregate_id === reused)?.event_id)
    expect(reusedRevert?.payload).toMatchObject({
      before: { supplier_invoice_number: null, payment_reference: 'AG-1' },
      after: { supplier_invoice_number: '301', payment_reference: null },
    })

    // Reverting again changes nothing.
    const again = await runAsServiceRole((c) => revert(c, { companyId, correlationId: repairId, dryRun: false }))
    expect(again.counts.reverted).toBeUndefined()
    const { rows: stillFour } = await getPool().query(
      `SELECT 1 FROM public.processing_history WHERE company_id = $1 AND event_type = 'SupplierInvoiceNumberCorrectionReverted'`,
      [companyId],
    )
    expect(stillFour).toHaveLength(4)
  })

  it('needs a company, a correlation id and, for a write, an actor to revert, and only service_role may', async () => {
    const { userId, companyId } = await seedCompany()
    const noCorrelation = await captureError(runAsServiceRole((c) => revert(c, { companyId, correlationId: null })))
    expect(noCorrelation?.code).toBe('22023')
    const noActor = await captureError(
      runAsServiceRole((c) => revert(c, { companyId, correlationId: randomUUID(), dryRun: false, actor: null })),
    )
    expect(noActor?.code).toBe('22023')
    const denied = await captureError(
      withUserContext(userId, (c) => revert(c, { companyId, correlationId: randomUUID() })),
    )
    expect(denied?.code).toBe('42501')
    const { rows } = await getPool().query<{ authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
        WHERE p.oid = 'public.revert_fortnox_supplier_invoice_numbers(uuid, uuid, jsonb, boolean)'::regprocedure`,
    )
    expect(rows[0]).toEqual({ authenticated: false, service: true })
  })

  it('needs one company, a json array and, for a write, an actor', async () => {
    const { companyId } = await seedCompany()
    const noCompany = await captureError(runAsServiceRole((c) => repair(c, { companyId: null, records: [] })))
    expect(noCompany?.code).toBe('22023')
    const noActor = await captureError(
      runAsServiceRole((c) => repair(c, { companyId, records: [], dryRun: false, actor: null })),
    )
    expect(noActor?.code).toBe('22023')
    const notArray = await captureError(
      runAsServiceRole((c) =>
        c.query(`SELECT public.repair_fortnox_supplier_invoice_numbers($1, '{}'::jsonb, NULL, true)`, [companyId]),
      ),
    )
    expect(notArray?.code).toBe('22023')
  })

  it('refuses a migration-reset source company, which stays frozen', async () => {
    const source = await seedCompany()
    const replacement = await seedCompany()
    const s = await supplier(source.companyId, source.userId)
    const frozen = await invoice({ companyId: source.companyId, userId: source.userId, supplierId: s, number: '201' })
    await getPool().query(
      `INSERT INTO public.company_migration_resets
         (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'pg-real repair of a reset source', '{}'::jsonb, '{}'::jsonb)`,
      [source.companyId, replacement.companyId],
    )
    const records = [{ given_number: '201', invoice_number: 'INV-201' }]
    for (const dryRun of [true, false]) {
      const refused = await captureError(
        runAsServiceRole((c) => repair(c, { companyId: source.companyId, records, dryRun })),
      )
      expect(refused?.code).toBe('55000')
    }
    const revertRefused = await captureError(
      runAsServiceRole((c) => revert(c, { companyId: source.companyId, correlationId: randomUUID() })),
    )
    expect(revertRefused?.code).toBe('55000')
    expect(await numbers(frozen)).toEqual({ supplier_invoice_number: '201', fortnox_number: null })
  })

  it('is callable by service_role only', async () => {
    const { userId, companyId } = await seedCompany()
    const denied = await captureError(
      withUserContext(userId, (c) => repair(c, { companyId, records: [] })),
    )
    expect(denied?.code).toBe('42501')
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
        WHERE p.oid = 'public.repair_fortnox_supplier_invoice_numbers(uuid, jsonb, jsonb, boolean, uuid)'::regprocedure`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service: true })
  })
})
