import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildArkivMap } from '../map'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => reset())

describe('buildArkivMap', () => {
  it('draws the company, its documents by group, running agreements with next dates, registered facts and what waits', async () => {
    enqueue({ data: { name: 'Arcim Technology AB', org_number: '559538-6219' } })
    enqueue({
      data: [
        { id: 'd-1', file_name: 'IMG_1.jpg', doc_type: 'supplier_invoice', created_at: '2026-09-15T10:00:00Z' },
        { id: 'd-2', file_name: 'reg.pdf', doc_type: 'registration.bolagsverket', created_at: '2026-09-14T10:00:00Z' },
        { id: 'd-3', file_name: 'lån.pdf', doc_type: 'agreement.loan', created_at: '2026-09-13T10:00:00Z' },
        { id: 'd-4', file_name: 'x.pdf', doc_type: null, created_at: '2026-09-12T10:00:00Z' },
      ],
    })
    enqueue({ data: [{ id: 'a-1', title: 'Lån 500050956', kind: 'loan', counterparty_name: 'Almi', amount: '10417', period: 'monthly', ends_on: '2031-02-02' }] })
    enqueue({
      data: [
        { predicate: 'vat_period', value_text: 'Helt beskattningsår', valid_from: null },
        { predicate: 'board', value_text: 'b'.repeat(300), valid_from: '2026-05-22' },
        { predicate: 'minutes_decisions', value_text: 'x', valid_from: null },
      ],
    })
    enqueue({ count: 3 })
    enqueue({ count: 2 })
    enqueue({
      data: [
        {
          document_id: 'd-1',
          payload: {
            supplier_name: { value: 'Rollup-Kungen', normalized: 'Rollup-Kungen' },
            invoice_number: { value: '215066768', normalized: '215066768' },
            invoice_date: { value: '2026-04-10', normalized: '2026-04-10' },
          },
        },
      ],
    })
    enqueue({
      data: [
        { agreement_id: 'a-1', due_on: '2026-10-01' },
        { agreement_id: 'a-1', due_on: '2026-11-01' },
      ],
    })

    const map = await buildArkivMap(supabase, 'co-1')

    expect(map.company).toEqual({ name: 'Arcim Technology AB', org_number: '559538-6219', record_ref: 'company:co-1' })
    expect(map.documents.total).toBe(4)
    expect(map.documents.by_group).toEqual({ agreements: 1, authority: 1, corporate: 0, receipts_invoices: 1, statements: 0, other: 1 })
    expect(map.documents.latest[0]).toEqual({ record_ref: 'document:d-1', title: 'Faktura Rollup-Kungen 215066768', type: 'supplier_invoice', date: '2026-04-10' })
    expect(map.documents.latest[3].date).toBe('2026-09-12')
    expect(map.agreements).toEqual([
      {
        record_ref: 'agreement:a-1',
        title: 'Lån 500050956',
        kind: 'loan',
        counterparty: 'Almi',
        amount: 10417,
        period: 'monthly',
        ends_on: '2031-02-02',
        next_payment: '2026-10-01',
      },
    ])
    expect(map.company_facts.map((f) => f.predicate)).toEqual(['board', 'vat_period'])
    expect(map.company_facts[0].value.length).toBe(200)
    expect(map.waiting).toEqual({ questions: 3, findings: 2 })
    expect(map.how_to.join(' ')).toContain('gnubok_ask_document')
    expect(JSON.stringify(map).length).toBeLessThan(8_000)
  })

  it('throws with the failing read', async () => {
    enqueue({ error: { message: 'timeout' } })
    await expect(buildArkivMap(supabase, 'co-1')).rejects.toThrow('map read failed: timeout')
  })
})
