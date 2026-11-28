/**
 * The invoice a payment verifikat settles, when its underlag already sits on
 * the invoice's verifikat. Built from crm#1584: migrated Bokio payments name
 * their invoice verifikat only in the text ("... (V299)"), the invoice was
 * booked in the previous year, and a voucher number recurs every year.
 */
import { describe, it, expect } from 'vitest'
import { resolveUnderlagElsewhere } from '../underlag-elsewhere'

type Row = Record<string, unknown>

/** A Supabase stand-in that honours eq/in/is, so a wrong filter shows up as a wrong answer. */
function mockSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = []
      let from = 0
      let to = Number.MAX_SAFE_INTEGER
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.order = () => chain
      chain.eq = (column: string, value: unknown) => {
        filters.push((row) => row[column] === value)
        return chain
      }
      chain.in = (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]))
        return chain
      }
      chain.is = (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value)
        return chain
      }
      chain.range = (f: number, t: number) => {
        from = f
        to = t
        return chain
      }
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row))).slice(from, to + 1),
          error: null,
        }).then(resolve)
      return chain
    },
  } as never
}

const CO = 'co-1'

function entry(id: string, series: string, number: number, date: string, extra: Row = {}): Row {
  return {
    id,
    company_id: CO,
    status: 'posted',
    entry_date: date,
    voucher_series: series,
    voucher_number: number,
    source_voucher_series: series,
    source_voucher_number: number,
    ...extra,
  }
}

let lineSeq = 0
type Line = { id: string; journal_entry_id: string; account_number: string; debit_amount: number; credit_amount: number }

function line(journal_entry_id: string, account_number: string, debit: number, credit: number): Line {
  lineSeq += 1
  return { id: `l-${lineSeq}`, journal_entry_id, account_number, debit_amount: debit, credit_amount: credit }
}

/** The candidates' own lines, grouped the way the worklist hands them over. */
function byEntry(lines: Line[]): Map<string, Line[]> {
  const map = new Map<string, Line[]>()
  for (const l of lines) map.set(l.journal_entry_id, [...(map.get(l.journal_entry_id) ?? []), l])
  return map
}

function doc(id: string, journal_entry_id: string, created_at = '2026-10-31T21:12:00Z'): Row {
  return { id, company_id: CO, journal_entry_id, is_current_version: true, created_at }
}

describe('resolveUnderlagElsewhere', () => {
  it('finds the invoice a migrated payment names, booked the year before (crm#1584)', async () => {
    const paymentLines = [line('pay-27', '2440', 45475, 0), line('pay-27', '1932', 0, 45475)]
    const supabase = mockSupabase({
      journal_entries: [
        // V299 of 2025 is the invoice; V299 of 2026 does not exist yet when V27 pays.
        entry('inv-299', 'V', 299, '2025-12-28'),
        entry('pay-27', 'V', 27, '2026-01-26'),
      ],
      journal_entry_lines: [
        line('inv-299', '2440', 0, 45475),
        line('inv-299', '2641', 9095, 0),
        line('inv-299', '6550', 36380, 0),
        ...paymentLines,
      ],
      document_attachments: [doc('doc-v299', 'inv-299')],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-27', entry_date: '2026-01-26', description: 'Leverantörsfaktura #1001 betald till Konsultbolaget AB (V299)' }],
      byEntry(paymentLines),
    )

    expect(result.get('pay-27')).toEqual({
      voucher: 'V299',
      journal_entry_id: 'inv-299',
      entry_date: '2025-12-28',
      document_id: 'doc-v299',
    })
  })

  it('takes the latest verifikat with that number dated before the payment', async () => {
    const paymentLines = [line('pay-230', '2440', 5898, 0), line('pay-230', '1932', 0, 5898)]
    const supabase = mockSupabase({
      journal_entries: [
        entry('old-229', 'V', 229, '2025-10-29'),
        entry('new-229', 'V', 229, '2026-06-22'),
        // A third V229 dated after the payment cannot be the invoice it paid.
        entry('later-229', 'V', 229, '2027-06-01'),
      ],
      journal_entry_lines: [
        line('old-229', '2440', 0, 18750),
        line('new-229', '2440', 0, 5898),
        line('later-229', '2440', 0, 100),
        ...paymentLines,
      ],
      document_attachments: [doc('doc-old', 'old-229'), doc('doc-new', 'new-229'), doc('doc-later', 'later-229')],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-230', entry_date: '2026-09-07', description: 'Leverantörsfaktura #2002 betald till Mässbolaget AB (V229)' }],
      byEntry(paymentLines),
    )

    expect(result.get('pay-230')?.document_id).toBe('doc-new')
  })

  it('ignores a reference that lands on a verifikat registering no invoice', async () => {
    const paymentLines = [line('pay-1', '1930', 1000, 0), line('pay-1', '1510', 0, 1000)]
    const supabase = mockSupabase({
      journal_entries: [entry('card-103', 'V', 103, '2026-02-01')],
      // A card purchase: no kundfordran, so not the customer invoice paid here.
      journal_entry_lines: [line('card-103', '6540', 200, 0), line('card-103', '1932', 0, 200), ...paymentLines],
      document_attachments: [doc('doc-card', 'card-103')],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-1', entry_date: '2026-03-01', description: 'Faktura #3003 betalad av Kund AB (V103)' }],
      byEntry(paymentLines),
    )

    expect(result.size).toBe(0)
  })

  it('finds a customer invoice paid in, and leaves a purchase with a reference alone', async () => {
    const paymentLines = [
      line('in-77', '1930', 40200, 0),
      line('in-77', '1510', 0, 40200),
      // A purchase whose text happens to end in a voucher reference is not a settlement.
      line('buy-5', '6540', 100, 0),
      line('buy-5', '1932', 0, 100),
    ]
    const supabase = mockSupabase({
      journal_entries: [entry('inv-60', 'V', 60, '2024-09-14'), entry('other-4', 'V', 4, '2024-01-01')],
      journal_entry_lines: [
        line('inv-60', '1510', 40200, 0),
        line('inv-60', '3001', 0, 40200),
        line('other-4', '2440', 0, 100),
        ...paymentLines,
      ],
      document_attachments: [doc('doc-60', 'inv-60'), doc('doc-4', 'other-4')],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [
        { journal_entry_id: 'in-77', entry_date: '2024-10-14', description: 'Faktura #1012 betalad av Kunden ApS (V60)' },
        { journal_entry_id: 'buy-5', entry_date: '2024-02-01', description: 'Kortköp (V4)' },
      ],
      byEntry(paymentLines),
    )

    expect([...result.keys()]).toEqual(['in-77'])
    expect(result.get('in-77')?.document_id).toBe('doc-60')
  })

  it('follows an Accounted payment link to the registration verifikat holding the invoice', async () => {
    const paymentLines = [line('pay-x', '2440', 500, 0), line('pay-x', '1930', 0, 500)]
    const supabase = mockSupabase({
      supplier_invoices: [
        { company_id: CO, payment_journal_entry_id: 'pay-x', registration_journal_entry_id: 'reg-x', document_id: null },
      ],
      journal_entries: [entry('reg-x', 'A', 12, '2026-04-01')],
      document_attachments: [doc('doc-x', 'reg-x')],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-x', entry_date: '2026-04-30', description: 'Betalning' }],
      byEntry(paymentLines),
    )

    expect(result.get('pay-x')).toEqual({ voucher: 'A12', journal_entry_id: 'reg-x', entry_date: '2026-04-01', document_id: 'doc-x' })
  })

  it('says nothing when the invoice verifikat has no document either', async () => {
    const paymentLines = [line('pay-9', '2440', 300, 0), line('pay-9', '1932', 0, 300)]
    const supabase = mockSupabase({
      journal_entries: [entry('inv-8', 'V', 8, '2026-01-02')],
      journal_entry_lines: [line('inv-8', '2440', 0, 300), ...paymentLines],
      document_attachments: [],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-9', entry_date: '2026-02-01', description: 'Leverantörsfaktura betald till Teleoperatören (V8)' }],
      byEntry(paymentLines),
    )

    expect(result.size).toBe(0)
  })

  it('does not offer a document whose link was struck on the invoice verifikat', async () => {
    const paymentLines = [line('pay-9', '2440', 300, 0), line('pay-9', '1932', 0, 300)]
    const supabase = mockSupabase({
      journal_entries: [entry('inv-8', 'V', 8, '2026-01-02')],
      journal_entry_lines: [line('inv-8', '2440', 0, 300), ...paymentLines],
      document_attachments: [{ ...doc('doc-struck', 'inv-8'), link_struck_at: '2026-11-27T10:00:00Z' }],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-9', entry_date: '2026-02-01', description: 'Leverantörsfaktura betald till Teleoperatören (V8)' }],
      byEntry(paymentLines),
    )

    expect(result.size).toBe(0)
  })

  it('reads only the company it was asked about', async () => {
    const paymentLines = [line('pay-2', '2440', 300, 0), line('pay-2', '1932', 0, 300)]
    const supabase = mockSupabase({
      journal_entries: [entry('foreign-8', 'V', 8, '2026-01-02', { company_id: 'co-2' })],
      journal_entry_lines: [line('foreign-8', '2440', 0, 300), ...paymentLines],
      document_attachments: [{ ...doc('doc-foreign', 'foreign-8'), company_id: 'co-2' }],
    })

    const result = await resolveUnderlagElsewhere(
      supabase,
      CO,
      [{ journal_entry_id: 'pay-2', entry_date: '2026-02-01', description: 'Leverantörsfaktura betald till Teleoperatören (V8)' }],
      byEntry(paymentLines),
    )

    expect(result.size).toBe(0)
  })
})
