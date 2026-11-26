import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { planCreditNoteRefund, refundLedgerAmount } from '@/lib/invoices/credit-note-refund-plan'
import { readCreditNoteBookedOre } from '@/lib/invoices/credit-note-booked-ore'
import { buildCreditNoteRefundLines } from '@/lib/invoices/refund-credit-note'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * The refund of a kreditfaktura whose own verifikat booked the
 * öresavrundning, on books Postgres holds: an original of 999,75 issued at
 * the rounded "Att betala" (Dr 1510 1 000, Cr 3740 0,25), paid 1 000, and
 * its credit note mirroring that (Cr 1510 1 000, Dr 3740 0,25). The refund
 * is planned from the credit note's verifikat as the ledger holds it
 * (live_journal_entry and its lines, read through the same calls the door
 * makes) and posted. Afterwards 1510 and 3740 carry nothing for the pair and
 * the bank is back where it started: the customer paid 1 000 and got 1 000.
 */

/**
 * The two reads readCreditNoteBookedOre makes, answered by Postgres: the
 * live_journal_entry RPC and the verifikat with its lines, inside the company.
 */
function pgReader(): Pick<SupabaseClient, 'rpc' | 'from'> {
  const rpc = async (fn: string, args: { p_company_id: string; p_entry_id: string }) => {
    if (fn !== 'live_journal_entry') throw new Error(`unexpected rpc ${fn}`)
    const { rows } = await getPool().query('SELECT entry_id, exhausted FROM public.live_journal_entry($1, $2)', [
      args.p_company_id,
      args.p_entry_id,
    ])
    return { data: rows[0] ?? null, error: null }
  }
  const from = (table: string) => {
    if (table !== 'journal_entries') throw new Error(`unexpected table ${table}`)
    const filters: Record<string, string> = {}
    const chain = {
      select: () => chain,
      eq: (column: string, value: string) => {
        filters[column] = value
        return chain
      },
      maybeSingle: async () => {
        const { rows } = await getPool().query(
          `SELECT je.id, je.status,
                  COALESCE((SELECT json_agg(json_build_object(
                             'account_number', l.account_number,
                             'debit_amount', l.debit_amount,
                             'credit_amount', l.credit_amount))
                            FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id), '[]'::json) AS lines
             FROM public.journal_entries je
            WHERE je.company_id = $1 AND je.id = $2`,
          [filters.company_id, filters.id],
        )
        return { data: rows[0] ?? null, error: null }
      },
    }
    return chain
  }
  return { rpc, from } as unknown as Pick<SupabaseClient, 'rpc' | 'from'>
}

async function accountSum(entryIds: string[], account: string): Promise<number> {
  const { rows } = await getPool().query<{ sum: string }>(
    `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::text AS sum
       FROM public.journal_entry_lines WHERE journal_entry_id = ANY($1::uuid[]) AND account_number = $2`,
    [entryIds, account],
  )
  return Number(rows[0]!.sum)
}

describe('refund of a credit note whose verifikat booked the öresavrundning', () => {
  it('pays back what 1510 carries, so 1510, 3740 and the bank net to zero', async () => {
    const s = await seedCompany()
    const post = (entryDate: string, description: string, lines: Array<[string, number, number]>, sourceType?: string) =>
      insertPostedJournalEntry({
        userId: s.userId,
        companyId: s.companyId,
        fiscalPeriodId: s.fiscalPeriodId,
        entryDate,
        description,
        ...(sourceType ? { sourceType } : {}),
        lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
      })

    const issueId = await post('2026-01-15', 'Faktura', [
      ['1510', 1000, 0],
      ['3001', 0, 799.8],
      ['2611', 0, 199.95],
      ['3740', 0, 0.25],
    ])
    const paymentId = await post('2026-02-01', 'Inbetalning', [
      ['1930', 1000, 0],
      ['1510', 0, 1000],
    ], 'invoice_paid')
    const creditId = await post('2026-03-01', 'Kreditfaktura', [
      ['1510', 0, 1000],
      ['3001', 799.8, 0],
      ['2611', 199.95, 0],
      ['3740', 0.25, 0],
    ])

    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
      [customerId, s.userId, s.companyId],
    )
    const originalId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
          currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
          paid_amount, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, '2026-01-15', '2026-02-14', 'SEK',
               799.80, 199.95, 999.75, 'standard_25', 25, 'paid', 999.75, $6)`,
      [originalId, s.userId, s.companyId, customerId, `F-${originalId.slice(0, 8)}`, issueId],
    )
    const creditNoteId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
          currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
          credited_invoice_id, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, '2026-03-01', '2026-03-01', 'SEK',
               -799.80, -199.95, -999.75, 'standard_25', 25, 'sent', $6, $7)`,
      [creditNoteId, s.userId, s.companyId, customerId, `K-${creditNoteId.slice(0, 8)}`, originalId, creditId],
    )

    const { rows } = await getPool().query<{
      status: string
      total: string
      paid_amount: string | null
      currency: string
      journal_entry_id: string
      deduction_total: string | null
    }>('SELECT status, total, paid_amount, currency, journal_entry_id, deduction_total FROM public.invoices WHERE id = $1', [
      creditNoteId,
    ])
    const creditNote = rows[0]!
    const { rows: originalRows } = await getPool().query<{ total: string; paid_amount: string }>(
      'SELECT total, paid_amount FROM public.invoices WHERE id = $1',
      [originalId],
    )

    const bookedOre = await readCreditNoteBookedOre(pgReader(), s.companyId, creditNote)
    expect(bookedOre).toBe(0.25)

    const plan = planCreditNoteRefund(creditNote, originalRows[0]!)
    expect(plan).toMatchObject({ ok: true, owed: 999.75, settlesCredit: true })
    if (!plan.ok) return
    // The figure the door used to refund leaves the öre on 1510.
    const before = [issueId, paymentId, creditId]
    expect(await accountSum(before, '1510')).toBe(-1000)
    expect(plan.owed + (await accountSum(before, '1510'))).toBeCloseTo(-0.25, 2)

    const built = buildCreditNoteRefundLines(
      { invoice_number: 'K-1', customer: { name: 'Kund AB' }, default_dimensions: {} },
      refundLedgerAmount(plan, bookedOre),
      '1930',
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const refundId = await post(
      '2026-03-05',
      built.description,
      built.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount] as [string, number, number]),
      'invoice_paid',
    )

    const all = [...before, refundId]
    expect(await accountSum(all, '1510')).toBe(0)
    expect(await accountSum(all, '3740')).toBe(0)
    expect(await accountSum(all, '1930')).toBe(0)
  })

  it('reads no öre off a credit note booked at its exact total', async () => {
    const s = await seedCompany()
    const creditId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-03-01',
      description: 'Kreditfaktura',
      lines: [
        { accountNumber: '1510', debitAmount: 0, creditAmount: 999.75 },
        { accountNumber: '3001', debitAmount: 799.8, creditAmount: 0 },
        { accountNumber: '2611', debitAmount: 199.95, creditAmount: 0 },
      ],
    })
    expect(await readCreditNoteBookedOre(pgReader(), s.companyId, { total: -999.75, currency: 'SEK', journal_entry_id: creditId })).toBe(0)
    // Another company's id finds no verifikat: nothing is read across tenants.
    const other = await seedCompany()
    expect(await readCreditNoteBookedOre(pgReader(), other.companyId, { total: -999.75, currency: 'SEK', journal_entry_id: creditId })).toBe(0)
  })
})
