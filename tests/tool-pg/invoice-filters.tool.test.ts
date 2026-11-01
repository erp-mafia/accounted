/**
 * The filters behind every "what is owed" read, over a real PostgREST: the
 * `or` arms are PostgREST's grammar and `total` a numeric column, which no
 * mock can vouch for. Each query must return exactly the rows the predicate
 * of the same rule accepts, or a list and a count come to disagree.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { excludeCreditNotes, HAS_ISSUE_STEP_OR_ARMS, isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { effectiveInvoiceStatus, filterInvoicesByReportedStatus, filterOwedInvoices, isInvoiceOverdue } from '@/lib/invoices/overdue'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

const TODAY = '2026-10-13'
const COLUMNS = 'id, status, document_type, credited_invoice_id, total, due_date, remaining_amount'

type Row = { name: string; status: string; total: number; due: string; paid?: number; link?: boolean; type?: string }

const ROWS: Row[] = [
  { name: 'sent, not due', status: 'sent', total: 1000, due: '2026-12-01' },
  { name: 'sent, past due', status: 'sent', total: 1000, due: '2026-09-01' },
  { name: 'stored overdue, due date moved', status: 'overdue', total: 1000, due: '2026-12-01' },
  { name: 'part paid, not due', status: 'partially_paid', total: 1000, paid: 400, due: '2026-12-01' },
  { name: 'part paid, past due', status: 'partially_paid', total: 1000, paid: 400, due: '2026-09-01' },
  { name: 'paid', status: 'paid', total: 1000, paid: 1000, due: '2026-09-01' },
  { name: 'draft', status: 'draft', total: 1000, due: '2026-09-01' },
  { name: 'proforma', status: 'sent', total: 1000, due: '2026-09-01', type: 'proforma' },
  { name: 'linked credit note', status: 'sent', total: -1000, due: '2026-09-01', link: true },
  { name: 'imported credit note, sent', status: 'sent', total: -500, due: '2026-09-01' },
  { name: 'imported credit note, overdue', status: 'overdue', total: -500, due: '2026-09-01' },
  { name: 'imported credit note, paid', status: 'paid', total: -500, paid: -500, due: '2026-09-01' },
]

describe('the invoice filters over a real PostgREST', () => {
  const supabase = createToolPgClient()
  let companyId: string
  const nameOf = new Map<string, string>()

  beforeAll(async () => {
    const seed = await seedCompany()
    companyId = seed.companyId
    const pool = getPool()
    const customerId = randomUUID()
    await pool.query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
      [customerId, seed.userId, companyId],
    )
    const ids = ROWS.map(() => randomUUID())
    for (const [index, row] of ROWS.entries()) {
      nameOf.set(ids[index], row.name)
      await pool.query(
        `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status,
           document_type, currency, subtotal, vat_amount, total, vat_treatment, paid_amount, remaining_amount)
         VALUES ($1, $2, $3, $4, $5, '2026-08-01', $6, $7, $8, 'SEK', $9, 0, $9, 'standard_25', $10, $11)`,
        [
          ids[index], seed.userId, companyId, customerId, `T-${index}`, row.due, row.status, row.type ?? 'invoice', row.total,
          row.paid ?? 0, row.total < 0 ? 0 : row.total - (row.paid ?? 0),
        ],
      )
    }
    await pool.query(`UPDATE public.invoices SET credited_invoice_id = $1 WHERE id = $2`, [
      ids[ROWS.findIndex((row) => row.name === 'paid')],
      ids[ROWS.findIndex((row) => row.link)],
    ])
  })

  const read = async (narrow: (query: never) => unknown) => {
    const { data, error } = await (narrow(
      supabase.from('invoices').select(COLUMNS).eq('company_id', companyId) as never,
    ) as PromiseLike<{ data: Array<{ id: string }> | null; error: unknown }>)
    expect(error).toBeNull()
    return (data ?? []).map((row) => nameOf.get(row.id) as string).sort()
  }

  const all = async () => {
    const { data, error } = await supabase.from('invoices').select(COLUMNS).eq('company_id', companyId)
    expect(error).toBeNull()
    return (data ?? []).map((row) => ({ ...row, name: nameOf.get(row.id) as string }))
  }

  it('excludeCreditNotes returns what isCreditNoteDocument calls no credit note', async () => {
    const rows = await all()
    expect(rows).toHaveLength(ROWS.length)
    expect(await read(excludeCreditNotes as never)).toEqual(
      rows.filter((row) => !isCreditNoteDocument(row)).map((row) => row.name).sort(),
    )
  })

  it('HAS_ISSUE_STEP_OR_ARMS leaves out exactly the credit notes with no link', async () => {
    const rows = await all()
    const noOriginal = rows.filter((row) => isCreditNoteDocument(row) && row.credited_invoice_id === null).map((row) => row.name)
    expect(noOriginal.sort()).toEqual(['imported credit note, overdue', 'imported credit note, paid', 'imported credit note, sent'])
    expect(await read(((query: { or: (arms: string) => unknown }) => query.or(HAS_ISSUE_STEP_OR_ARMS)) as never)).toEqual(
      rows.filter((row) => !noOriginal.includes(row.name)).map((row) => row.name).sort(),
    )
  })

  it('filterOwedInvoices returns a real faktura in an owed status with something remaining', async () => {
    expect(await read(filterOwedInvoices as never)).toEqual(
      ['part paid, not due', 'part paid, past due', 'sent, not due', 'sent, past due', 'stored overdue, due date moved'].sort(),
    )
  })

  it('status=overdue returns what isInvoiceOverdue accepts', async () => {
    const rows = await all()
    expect(await read(((query: never) => filterInvoicesByReportedStatus(query, 'overdue', TODAY)) as never)).toEqual(
      rows.filter((row) => isInvoiceOverdue(row, TODAY)).map((row) => row.name).sort(),
    )
  })

  it('status=sent returns what effectiveInvoiceStatus reports as sent, the imported credit notes included', async () => {
    const rows = await all()
    const reported = rows.filter((row) => effectiveInvoiceStatus(row, TODAY) === 'sent').map((row) => row.name).sort()
    expect(reported).toContain('imported credit note, overdue')
    expect(await read(((query: never) => filterInvoicesByReportedStatus(query, 'sent', TODAY)) as never)).toEqual(reported)
  })
})
