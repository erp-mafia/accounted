import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  bookedOreOnLedger,
  openVatByAccount,
  reachedLedgerAsReceivable,
  receivableBasis,
  recoveryLines,
  type LedgerLine,
} from '@/lib/customer-loss/amounts'
import { planConfirmed } from '@/lib/customer-loss/confirmed'
import { planRecovery } from '@/lib/customer-loss/recovered'
import { invoiceToPayRounding, type CustomerLossState, type WriteOffRow } from '@/lib/customer-loss/state'
import { roundOre } from '@/lib/money'
import { customerLossVatAdjustment } from '@/lib/reports/vat-declaration'
import { getPool, runAsServiceRole } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Återvunnen kundförlust on an öre-rounded invoice whose öre was left for the
 * payment: the konstaterad write-off took the exact total off 1510, and the
 * customer (or the agency, which is handed the printed amount) then pays what
 * the invoice asked for, "Att betala". The recovery closes the claim: the
 * voucher comes from planRecovery and recoveryLines on the decisions as
 * Postgres holds them, record_invoice_write_off checks it, and afterwards
 * 1510 carries nothing, the output VAT is the invoice's own again (ML 7 kap
 * 43 §: the VAT the loss took off is reported again as payment comes), and
 * the öre is on 3740.
 */
const cases = [
  // 799.80 + 199.95 = 999.75, to pay 1 000.
  { name: 'rounded up', net: 799.8, vat: 199.95, total: 999.75, received: 1000, ore: { debit: 0, credit: 0.25 } },
  // 800.32 + 200.08 = 1 000.40, to pay 1 000.
  { name: 'rounded down', net: 800.32, vat: 200.08, total: 1000.4, received: 1000, ore: { debit: 0.4, credit: 0 } },
]

async function recordDecision(params: {
  id: string
  companyId: string
  invoiceId: string
  kind: 'confirmed' | 'recovered'
  entryDate: string
  amount: number
  net: number
  vat: number
  shares: unknown
  journalEntryId: string
  evidenceId: string | null
  userId: string
}): Promise<{ invoice_status: string }> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: { invoice_status: string } }>(
      `SELECT public.record_invoice_write_off(
         $1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, 0, $10, $11, 'Konkurs', NULL, NULL, $12
       ) AS result`,
      [
        params.id,
        params.companyId,
        params.invoiceId,
        params.kind,
        params.entryDate,
        params.amount,
        params.net,
        params.vat,
        JSON.stringify(params.shares),
        params.journalEntryId,
        params.evidenceId,
        params.userId,
      ],
    )
    return rows[0]!.result
  })
}

describe('återvunnen kundförlust of an öre-rounded invoice', () => {
  it.each(cases)('$name: a payment of "Att betala" closes the claim, its VAT reported again in full', async (c) => {
    const s = await seedCompany()
    const issueId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-01-15',
      description: 'Faktura',
      lines: [
        { accountNumber: '1510', debitAmount: c.total, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: c.net },
        { accountNumber: '2611', debitAmount: 0, creditAmount: c.vat },
      ],
    })
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
      [customerId, s.userId, s.companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
          currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
          paid_amount, remaining_amount, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, '2026-01-15', '2026-02-14', 'SEK',
               $6, $7, $8, 'standard_25', 25, 'overdue', 0, $8, $9)`,
      [invoiceId, s.userId, s.companyId, customerId, `F-${invoiceId.slice(0, 8)}`, c.net, c.vat, c.total, issueId],
    )

    const { rows: issueLines } = await getPool().query<LedgerLine>(
      'SELECT account_number, debit_amount, credit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $1',
      [issueId],
    )
    const { rows: invoiceRows } = await getPool().query<{ total: string; remaining_amount: string; ore_rounding: boolean | null }>(
      'SELECT total, remaining_amount, ore_rounding FROM public.invoices WHERE id = $1',
      [invoiceId],
    )
    const { rows: settingsRows } = await getPool().query<{ ore_rounding: boolean | null }>(
      'SELECT ore_rounding FROM public.company_settings WHERE company_id = $1',
      [s.companyId],
    )
    const invoice = invoiceRows[0]!
    // As loadCustomerLossState reads it, from the rows Postgres holds.
    const toPayRounding = invoiceToPayRounding({
      invoice: { total: Number(invoice.total), currency: 'SEK', ore_rounding: invoice.ore_rounding },
      companyOreRounding: settingsRows[0]?.ore_rounding ?? null,
      credited: false,
    })
    expect(toPayRounding).toBe(roundOre(c.received - c.total))

    const state: CustomerLossState = {
      invoice: {
        id: invoiceId,
        invoice_number: 'F-1',
        status: 'overdue',
        currency: 'SEK',
        total: Number(invoice.total),
        paid_amount: 0,
        remaining_amount: Number(invoice.remaining_amount),
        due_date: '2026-02-14',
        journal_entry_id: issueId,
        deduction_total: 0,
        document_type: 'invoice',
        credited_invoice_id: null,
      },
      accountingMethod: 'accrual',
      booked: reachedLedgerAsReceivable(issueLines),
      receivableAccount: '1510',
      openVat: openVatByAccount(issueLines, []),
      basis: receivableBasis(issueLines, []),
      oreRounding: bookedOreOnLedger(issueLines, []),
      toPayRounding,
      rows: [],
      reserve: 0,
      confirmed: null,
      latestCase: null,
    }

    // The konstaterad write-off takes the exact total off 1510.
    const confirmed = planConfirmed(state)
    expect(confirmed.amount).toBe(c.total)
    const confirmedId = randomUUID()
    const lossId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-06-01',
      description: 'Konstaterad kundförlust',
      sourceType: 'customer_loss',
      sourceId: confirmedId,
      lines: confirmed.lines!.map((l) => ({ accountNumber: l.account_number, debitAmount: l.debit_amount, creditAmount: l.credit_amount })),
    })
    const evidenceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
       VALUES ($1, $2, $3, 'konkursbesked.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
      [evidenceId, s.userId, s.companyId, `documents/${s.companyId}/${evidenceId}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    )
    const written = await recordDecision({
      id: confirmedId,
      companyId: s.companyId,
      invoiceId,
      kind: 'confirmed',
      entryDate: '2026-06-01',
      amount: confirmed.amount,
      net: confirmed.net,
      vat: confirmed.vat,
      shares: confirmed.shares,
      journalEntryId: lossId,
      evidenceId,
      userId: s.userId,
    })
    expect(written.invoice_status).toBe('written_off')

    // The recovery, planned on the decisions as Postgres holds them.
    const decisions = await loadDecisions(invoiceId)
    const confirmedRow = decisions.find((r) => r.kind === 'confirmed')!
    const planned = planRecovery(confirmedRow, { ...state, rows: decisions }, c.received)
    if (!planned.ok) throw new Error(`recovery refused, ${planned.left} left`)
    expect(planned.plan).toMatchObject({ amount: c.total, received: c.received, vat: c.vat, net: c.net })
    const recoveryId = randomUUID()
    const recoveryEntryId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-07-01',
      description: 'Återvunnen kundförlust',
      sourceType: 'customer_loss',
      sourceId: recoveryId,
      lines: recoveryLines({ ...planned.plan, paymentAccount: '1930', tag: 'F-1' }).map((l) => ({
        accountNumber: l.account_number,
        debitAmount: l.debit_amount,
        creditAmount: l.credit_amount,
      })),
    })
    await recordDecision({
      id: recoveryId,
      companyId: s.companyId,
      invoiceId,
      kind: 'recovered',
      entryDate: '2026-07-01',
      amount: planned.plan.amount,
      net: planned.plan.net,
      vat: planned.plan.vat,
      shares: planned.plan.shares,
      journalEntryId: recoveryEntryId,
      evidenceId: null,
      userId: s.userId,
    })

    // Per account over the issue, the write-off and the recovery.
    const { rows: ledger } = await getPool().query<{ account_number: string; debit: string; credit: string }>(
      `SELECT account_number, sum(debit_amount) AS debit, sum(credit_amount) AS credit
         FROM public.journal_entry_lines
        WHERE journal_entry_id = ANY($1::uuid[])
        GROUP BY account_number`,
      [[issueId, lossId, recoveryEntryId]],
    )
    const balance = (account: string) => {
      const row = ledger.find((r) => r.account_number === account)
      return row ? roundOre(Number(row.credit) - Number(row.debit)) : 0
    }
    expect(balance('1510')).toBe(0)
    // The output VAT stands where the invoice put it: the loss took it off, the recovery put it back.
    expect(balance('2611')).toBe(c.vat)
    expect(balance('1930')).toBe(-c.received)
    expect(balance('3740')).toBe(roundOre(c.ore.credit - c.ore.debit))

    // Nothing is left to recover, not even an öre.
    const after = await loadDecisions(invoiceId)
    expect(planRecovery(confirmedRow, { ...state, rows: after }, 0.25)).toEqual({ ok: false, left: 0 })

    // The momsdeklaration: ruta 05 lowered and raised by the same base, and 3950 is the recovery's net.
    const adjustment = customerLossVatAdjustment(after)
    expect(adjustment).toMatchObject({ ruta05: 0, base25: 0, recoveredNet: c.net })
    expect(balance('3950')).toBe(c.net)
  })
})

async function loadDecisions(invoiceId: string): Promise<WriteOffRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, invoice_id, kind, entry_date::text, amount::float8 AS amount, net_amount::float8 AS net_amount,
            vat_amount::float8 AS vat_amount, vat_by_rate, reserve_released::float8 AS reserve_released,
            journal_entry_id, evidence_document_id, reason, case_id, reverses_id, decided_by, decided_at
       FROM public.invoice_write_offs WHERE invoice_id = $1 ORDER BY decided_at`,
    [invoiceId],
  )
  return rows as WriteOffRow[]
}
