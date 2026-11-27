import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  bookedOreOnLedger,
  openVatByAccount,
  reachedLedgerAsReceivable,
  receivableBasis,
  type LedgerLine,
} from '@/lib/customer-loss/amounts'
import { planConfirmed } from '@/lib/customer-loss/confirmed'
import { openClaimRefusal } from '@/lib/customer-loss/eligibility'
import type { CustomerLossState } from '@/lib/customer-loss/state'
import { getPool, runAsServiceRole } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * A konstaterad kundförlust on an invoice whose issue verifikat booked its
 * öresavrundning: 1510 carries the rounded "Att betala" (1 000) and the öre is
 * on 3740, while the invoice row keeps the exact 999.75. The voucher comes
 * from planConfirmed on the issue verifikat as Postgres holds it, and
 * record_invoice_write_off checks it against the decision. Afterwards 1510
 * carries nothing for the invoice, and the VAT the decision takes back is the
 * VAT the invoice charged.
 */
describe('konstaterad kundförlust when the issue verifikat booked the öresavrundning', () => {
  it('clears what 1510 carries and takes back exactly the invoice VAT', async () => {
    const s = await seedCompany()
    const issueId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-01-15',
      description: 'Faktura',
      lines: [
        { accountNumber: '1510', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 799.8 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 199.95 },
        { accountNumber: '3740', debitAmount: 0, creditAmount: 0.25 },
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
               799.80, 199.95, 999.75, 'standard_25', 25, 'overdue', 0, 999.75, $6)`,
      [invoiceId, s.userId, s.companyId, customerId, `F-${invoiceId.slice(0, 8)}`, issueId],
    )

    const { rows: issueLines } = await getPool().query<LedgerLine>(
      'SELECT account_number, debit_amount, credit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $1',
      [issueId],
    )
    const { rows: invoiceRows } = await getPool().query<{ total: string; paid_amount: string; remaining_amount: string }>(
      'SELECT total, paid_amount, remaining_amount FROM public.invoices WHERE id = $1',
      [invoiceId],
    )
    const row = invoiceRows[0]!
    const state: CustomerLossState = {
      invoice: {
        id: invoiceId,
        invoice_number: 'F-1',
        status: 'overdue',
        currency: 'SEK',
        total: Number(row.total),
        paid_amount: Number(row.paid_amount),
        remaining_amount: Number(row.remaining_amount),
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
      toPayRounding: 0.25,
      rows: [],
      reserve: 0,
      confirmed: null,
      latestCase: null,
    }
    expect(openClaimRefusal(state)).toBeNull()
    const plan = planConfirmed(state)

    const decisionId = randomUUID()
    const lossId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-06-01',
      description: 'Konstaterad kundförlust',
      sourceType: 'customer_loss',
      sourceId: decisionId,
      lines: plan.lines!.map((l) => ({
        accountNumber: l.account_number,
        debitAmount: l.debit_amount,
        creditAmount: l.credit_amount,
      })),
    })
    const evidenceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
       VALUES ($1, $2, $3, 'konkursbesked.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
      [evidenceId, s.userId, s.companyId, `documents/${s.companyId}/${evidenceId}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    )

    const result = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ result: { invoice_status: string } }>(
        `SELECT public.record_invoice_write_off(
           $1, $2, $3, 'confirmed', '2026-06-01'::date, $4, $5, $6, $7::jsonb, 0, $8, $9, 'Konkurs', NULL, NULL, $10
         ) AS result`,
        [decisionId, s.companyId, invoiceId, plan.amount, plan.net, plan.vat, JSON.stringify(plan.shares), lossId, evidenceId, s.userId],
      )
      return rows[0]!.result
    })
    expect(result.invoice_status).toBe('written_off')

    // 1510 carries nothing for the invoice once the claim is written off.
    const { rows: ledger } = await getPool().query<{ receivable: string }>(
      `SELECT COALESCE(sum(debit_amount - credit_amount), 0) AS receivable
         FROM public.journal_entry_lines
        WHERE journal_entry_id = ANY($1::uuid[]) AND account_number = '1510'`,
      [[issueId, lossId]],
    )
    expect(Number(ledger[0]!.receivable)).toBe(0)

    // The VAT taken back and its ruta 05 base are the invoice's own VAT and net.
    const { rows: recorded } = await getPool().query<{ vat_amount: string; vat_by_rate: Array<{ vat: number; base: number }> }>(
      'SELECT vat_amount, vat_by_rate FROM public.invoice_write_offs WHERE id = $1',
      [decisionId],
    )
    expect(Number(recorded[0]!.vat_amount)).toBe(199.95)
    expect(recorded[0]!.vat_by_rate.map((share) => [Number(share.vat), Number(share.base)])).toEqual([[199.95, 799.8]])
  })
})
