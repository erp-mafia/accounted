import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { syncDraftVatHeadersForChangedCustomers, syncDraftVatHeadersForCustomer } from '../sync-draft-vat-headers'
import {
  deriveInvoiceVatHeader as derive,
  getVatRules,
  EU_GOODS_SUPPLY_NOTICE,
  EU_REVERSE_CHARGE_NOTICE,
  EXPORT_NOTICE_SV,
} from '../vat-rules'

const deriveInvoiceVatHeader = (
  customer: { customer_type: 'eu_business' | 'non_eu_business'; vat_number_validated?: boolean; country: string },
  rates: number[],
  options: { vatRegistered: boolean },
) => derive(getVatRules(customer.customer_type, customer.vat_number_validated ?? false, customer.country), rates, options)

const validatedFr = { customer_type: 'eu_business' as const, vat_number_validated: true, country: 'FR' }
const unvalidatedFr = { ...validatedFr, vat_number_validated: false }

describe('deriveInvoiceVatHeader', () => {
  it('reverse charge for a validated EU business with a 0 % line', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [0], { vatRegistered: true })).toEqual({
      vat_treatment: 'reverse_charge',
      moms_ruta: '39',
      reverse_charge_text: EU_REVERSE_CHARGE_NOTICE,
    })
  })

  it('Swedish VAT while the number is not validated', () => {
    expect(deriveInvoiceVatHeader(unvalidatedFr, [0], { vatRegistered: true })).toEqual({
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      reverse_charge_text: null,
    })
  })

  it('no reverse-charge notice when only Swedish rates are charged', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [12], { vatRegistered: true }).vat_treatment).toBe('standard_25')
  })

  it('keeps the notice on a mixed invoice and on a text-only document', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [0, 12], { vatRegistered: true }).vat_treatment).toBe('reverse_charge')
    expect(deriveInvoiceVatHeader(validatedFr, [], { vatRegistered: true }).vat_treatment).toBe('reverse_charge')
  })

  it('export for a non-EU business', () => {
    expect(
      deriveInvoiceVatHeader({ customer_type: 'non_eu_business', country: 'US' }, [0], { vatRegistered: true }),
    ).toEqual({ vat_treatment: 'export', moms_ruta: '40', reverse_charge_text: EXPORT_NOTICE_SV })
  })

  it('momsfri for a seller that is not VAT registered', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [0], { vatRegistered: false })).toEqual({
      vat_treatment: 'exempt',
      moms_ruta: null,
      reverse_charge_text: null,
    })
  })
})

describe('syncDraftVatHeadersForCustomer', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient

  beforeEach(() => {
    mock.reset()
  })

  it('moves a stale 25 % draft to reverse charge once the customer is validated', async () => {
    mock.enqueueMany([
      { data: validatedFr },
      {
        data: [
          {
            id: 'draft-1',
            vat_treatment: 'standard_25',
            moms_ruta: '05',
            reverse_charge_text: null,
            items: [
              { vat_rate: 0, line_type: 'product' },
              { vat_rate: null, line_type: 'text' },
            ],
          },
        ],
      },
      { data: { vat_registered: true } },
      { data: null, error: null },
    ])

    const updated = await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')

    expect(updated).toBe(1)
    expect(mock.findCall('invoices', 'update')).toEqual([
      { vat_treatment: 'reverse_charge', moms_ruta: '39', reverse_charge_text: EU_REVERSE_CHARGE_NOTICE },
    ])
    // Only open drafts of this customer, never credit notes or self-billed rows,
    // and the write re-checks draft status.
    const eqs = mock.findCalls('invoices', 'eq')
    expect(eqs).toContainEqual(['status', 'draft'])
    expect(eqs).toContainEqual(['customer_id', 'customer-1'])
    expect(eqs).toContainEqual(['is_self_billed', false])
    expect(mock.findCall('invoices', 'is')).toEqual(['credited_invoice_id', null])
    expect(eqs.filter((args) => args[0] === 'status')).toHaveLength(2)
  })

  it('writes nothing when the header already matches', async () => {
    mock.enqueueMany([
      { data: validatedFr },
      {
        data: [
          {
            id: 'draft-1',
            vat_treatment: 'reverse_charge',
            moms_ruta: '39',
            reverse_charge_text: EU_REVERSE_CHARGE_NOTICE,
            items: [{ vat_rate: 0, line_type: 'product' }],
          },
        ],
      },
      { data: { vat_registered: true } },
    ])

    expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')).toBe(0)
    expect(mock.findCall('invoices', 'update')).toBeUndefined()
  })

  it('leaves the lines alone: a 25 % line keeps a Swedish header', async () => {
    mock.enqueueMany([
      { data: validatedFr },
      {
        data: [
          {
            id: 'draft-1',
            vat_treatment: 'standard_25',
            moms_ruta: '05',
            reverse_charge_text: null,
            items: [{ vat_rate: 25, line_type: 'product' }],
          },
        ],
      },
      { data: { vat_registered: true } },
    ])

    expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')).toBe(0)
    expect(mock.findCall('invoice_items', 'update')).toBeUndefined()
    expect(mock.findCall('invoices', 'update')).toBeUndefined()
  })

  describe('a draft that states its own treatment (#2906)', () => {
    it('keeps a stated goods export whatever the customer turns into', async () => {
      mock.enqueueMany([
        { data: { ...validatedFr, id: 'customer-1', vat_number: 'FR12345678901' } },
        {
          data: [
            {
              id: 'draft-1',
              vat_treatment: 'export',
              moms_ruta: '36',
              reverse_charge_text: EXPORT_NOTICE_SV,
              vat_treatment_override: 'export',
              delivery_country: 'NO',
              items: [{ vat_rate: 0, line_type: 'product' }],
            },
          ],
        },
        { data: { vat_registered: true } },
      ])

      // Re-derived from the statement, not from the (reverse-charge) customer:
      // the header already matches, so nothing is written.
      expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')).toBe(0)
      expect(mock.findCall('invoices', 'update')).toBeUndefined()
    })

    it('falls back to the customer and clears the statement when the buyer VAT number loses its validation', async () => {
      mock.enqueueMany([
        { data: { ...unvalidatedFr, id: 'customer-1', vat_number: 'FR12345678901' } },
        {
          data: [
            {
              id: 'draft-1',
              vat_treatment: 'reverse_charge',
              moms_ruta: '35',
              reverse_charge_text: EU_GOODS_SUPPLY_NOTICE,
              vat_treatment_override: 'reverse_charge',
              delivery_country: 'FR',
              items: [{ vat_rate: 0, line_type: 'product' }],
            },
          ],
        },
        { data: { vat_registered: true } },
        { data: null, error: null },
      ])

      expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')).toBe(1)
      // Never 0 % the facts no longer support, and no delivery_country left
      // behind to route revenue to 3108.
      expect(mock.findCall('invoices', 'update')).toEqual([
        {
          vat_treatment: 'standard_25',
          moms_ruta: '05',
          reverse_charge_text: null,
          vat_treatment_override: null,
          delivery_country: null,
        },
      ])
    })
  })

  it('does nothing for an unknown customer', async () => {
    mock.enqueueMany([{ data: null }])
    expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'missing')).toBe(0)
    expect(mock.findCall('invoices', 'select')).toBeUndefined()
  })

  it('never throws: a failing read reports zero', async () => {
    const broken = {
      from: () => {
        throw new Error('boom')
      },
    } as unknown as SupabaseClient
    expect(await syncDraftVatHeadersForCustomer(broken, 'company-1', 'customer-1')).toBe(0)
  })
})

describe('syncDraftVatHeadersForChangedCustomers', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient

  const typeChange = (id: string) => ({ id, before: { customer_type: 'eu_business' } })
  // A Swedish card the import made a validated EU business: its 25 % draft
  // moves to reverse charge.
  const nowReverseCharge = (id: string) => [
    { data: { ...validatedFr, id, vat_number: 'FR12345678901' } },
    {
      data: [{
        id: `draft-${id}`,
        vat_treatment: 'standard_25',
        moms_ruta: '05',
        reverse_charge_text: null,
        vat_treatment_override: null,
        delivery_country: null,
        items: [{ vat_rate: 0, line_type: 'service' }],
      }],
    },
    { data: { vat_registered: true } },
    { data: null, error: null },
  ]
  const syncedCustomers = () =>
    mock.findCalls('customers', 'eq').filter((args) => args[0] === 'id').map((args) => args[1])

  beforeEach(() => {
    mock.reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('looks the drafts up once per slice of ids and syncs only the customers that have one', async () => {
    const changes = Array.from({ length: 450 }, (_, i) => typeChange(`c${i}`))
    mock.enqueueMany([
      { data: [{ customer_id: 'c5' }] },
      { data: [] },
      // Two drafts of one customer: it is synced once.
      { data: [{ customer_id: 'c420' }, { customer_id: 'c420' }] },
      ...nowReverseCharge('c5'),
      ...nowReverseCharge('c420'),
    ])

    const result = await syncDraftVatHeadersForChangedCustomers(supabase, 'company-1', changes)

    expect(result).toEqual({ updated: 2, unsynced: [] })
    const lookups = mock.findCalls('invoices', 'in')
    expect(lookups.map(([column, ids]) => [column, (ids as string[]).length])).toEqual([
      ['customer_id', 200],
      ['customer_id', 200],
      ['customer_id', 50],
    ])
    // The lookup asks for the drafts the sync re-derives: open, no credit
    // note, not self-billed.
    expect(mock.calls.slice(0, 5).map((c) => [c.table, c.method, ...c.args])).toEqual([
      ['invoices', 'select', 'customer_id'],
      ['invoices', 'eq', 'company_id', 'company-1'],
      ['invoices', 'eq', 'status', 'draft'],
      ['invoices', 'is', 'credited_invoice_id', null],
      ['invoices', 'eq', 'is_self_billed', false],
    ])
    expect(syncedCustomers()).toEqual(['c5', 'c420'])
  })

  it('reads nothing for a change that touched no field the header is derived from', async () => {
    const result = await syncDraftVatHeadersForChangedCustomers(supabase, 'company-1', [
      { id: 'c1', before: { phone: null, name: 'Old name' } },
    ])

    expect(result).toEqual({ updated: 0, unsynced: [] })
    expect(mock.calls).toEqual([])
  })

  it('starts nothing once the deadline has passed and hands back what it did not do', async () => {
    const result = await syncDraftVatHeadersForChangedCustomers(
      supabase,
      'company-1',
      [typeChange('c1'), { id: 'c2', before: { phone: null } }, typeChange('c3')],
      { deadline: Date.now() - 1 },
    )

    expect(result).toEqual({ updated: 0, unsynced: [typeChange('c1'), typeChange('c3')] })
    expect(mock.calls).toEqual([])
  })

  it('stops between two customers when the deadline passes, and the rest syncs when passed again', async () => {
    // Before the lookup and before the first customer: in time. Every check after: past.
    vi.spyOn(Date, 'now').mockReturnValue(2_000).mockReturnValueOnce(0).mockReturnValueOnce(0)
    mock.enqueueMany([
      { data: [{ customer_id: 'c1' }, { customer_id: 'c2' }] },
      ...nowReverseCharge('c1'),
    ])

    const first = await syncDraftVatHeadersForChangedCustomers(
      supabase,
      'company-1',
      [typeChange('c1'), typeChange('c2')],
      { deadline: 1_000 },
    )

    expect(first).toEqual({ updated: 1, unsynced: [typeChange('c2')] })
    expect(syncedCustomers()).toEqual(['c1'])

    mock.reset()
    mock.enqueueMany([{ data: [{ customer_id: 'c2' }] }, ...nowReverseCharge('c2')])
    expect(await syncDraftVatHeadersForChangedCustomers(supabase, 'company-1', first.unsynced))
      .toEqual({ updated: 1, unsynced: [] })
    expect(syncedCustomers()).toEqual(['c2'])
  })

  it('syncs every customer of a slice whose lookup failed: each reads its own drafts', async () => {
    mock.enqueueMany([
      { error: { message: 'boom' } },
      ...nowReverseCharge('c1'),
      // c2 has no draft: its own read finds none and writes nothing.
      { data: { ...validatedFr, id: 'c2', vat_number: 'FR12345678901' } },
      { data: [] },
    ])

    const result = await syncDraftVatHeadersForChangedCustomers(supabase, 'company-1', [typeChange('c1'), typeChange('c2')])

    expect(result).toEqual({ updated: 1, unsynced: [] })
    expect(syncedCustomers()).toEqual(['c1', 'c2'])
  })
})
