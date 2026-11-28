import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Guards migrations 20261127170000 / 20261127170100: invoices.credit_undone_at,
 * the mark of a credit note whose credit was undone (Ångra kreditering,
 * lib/invoices/uncredit-invoice.ts).
 *
 * Only a cancelled credit note carries it, and while it does the row cannot
 * leave 'cancelled': the credit flow reopens a cancelled, unissued draft with
 * its KR number, and an undone credit note was issued, so its number must
 * never be issued a second time (ML 17 kap 24 § p. 2). Cancelled, it frees
 * the credit cap like any cancelled credit note.
 */

async function insertInvoice(input: {
  userId: string
  companyId: string
  number: string
  total: number
  status?: string
  creditedInvoiceId?: string
  creditUndoneAt?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        status, currency, total, credited_invoice_id, credit_undone_at)
     VALUES ($1, $2, $3, $4, '2026-11-06', '2026-11-06', $5, 'SEK', $6, $7, $8)`,
    [
      id,
      input.userId,
      input.companyId,
      input.number,
      input.status ?? 'sent',
      input.total,
      input.creditedInvoiceId ?? null,
      input.creditUndoneAt ?? null,
    ],
  )
  return id
}

async function originalWithCreditNote() {
  const { userId, companyId } = await seedCompany()
  const originalId = await insertInvoice({ userId, companyId, number: `F-${randomUUID()}`, total: 42975 })
  const creditNoteId = await insertInvoice({
    userId,
    companyId,
    number: `KR-${randomUUID()}`,
    total: -42975,
    creditedInvoiceId: originalId,
  })
  return { userId, companyId, originalId, creditNoteId }
}

describe('invoices.credit_undone_at', () => {
  it('is validated, not left NOT VALID', async () => {
    const constraint = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
       WHERE conrelid = 'public.invoices'::regclass
         AND conname = 'invoices_credit_undone_is_cancelled_credit_note'`,
    )
    expect(constraint.rows).toEqual([{ convalidated: true }])
  })

  it('marks a cancelled credit note as undone', async () => {
    const { creditNoteId } = await originalWithCreditNote()
    await getPool().query(
      `UPDATE public.invoices SET status = 'cancelled', credit_undone_at = now() WHERE id = $1`,
      [creditNoteId],
    )
    const row = await getPool().query<{ status: string; undone: boolean }>(
      `SELECT status, credit_undone_at IS NOT NULL AS undone FROM public.invoices WHERE id = $1`,
      [creditNoteId],
    )
    expect(row.rows).toEqual([{ status: 'cancelled', undone: true }])
  })

  it('refuses the mark on an issued credit note and on an invoice that credits nothing', async () => {
    const { userId, companyId, originalId, creditNoteId } = await originalWithCreditNote()
    await expect(
      getPool().query(`UPDATE public.invoices SET credit_undone_at = now() WHERE id = $1`, [creditNoteId]),
    ).rejects.toThrow(/invoices_credit_undone_is_cancelled_credit_note/)
    await expect(
      getPool().query(
        `UPDATE public.invoices SET status = 'cancelled', credit_undone_at = now() WHERE id = $1`,
        [originalId],
      ),
    ).rejects.toThrow(/invoices_credit_undone_is_cancelled_credit_note/)
    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `F-${randomUUID()}`,
        total: 100,
        status: 'cancelled',
        creditUndoneAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/invoices_credit_undone_is_cancelled_credit_note/)
  })

  it('keeps an undone credit note cancelled: it is never reopened as a draft', async () => {
    const { creditNoteId } = await originalWithCreditNote()
    await getPool().query(
      `UPDATE public.invoices SET status = 'cancelled', credit_undone_at = now() WHERE id = $1`,
      [creditNoteId],
    )
    await expect(
      getPool().query(`UPDATE public.invoices SET status = 'draft' WHERE id = $1`, [creditNoteId]),
    ).rejects.toThrow(/invoices_credit_undone_is_cancelled_credit_note/)
  })

  it('frees the credit cap: the original takes a full credit again once the credit is undone', async () => {
    const { userId, companyId, originalId, creditNoteId } = await originalWithCreditNote()
    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -42975,
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/exceeds the invoice total/i)

    await getPool().query(
      `UPDATE public.invoices SET status = 'cancelled', credit_undone_at = now() WHERE id = $1`,
      [creditNoteId],
    )

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -42975,
        creditedInvoiceId: originalId,
      }),
    ).resolves.toEqual(expect.any(String))
  })
})
