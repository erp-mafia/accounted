import { describe, expect, it } from 'vitest'
import type { HouseholdDeductionDto, SalesInvoiceDto, SalesInvoiceLineDto } from '@/lib/providers/dto'
import {
  planMigratedDeduction,
  spreadDeduction,
  type PlanInvoice,
  type PlanItem,
} from '../migrated-deduction-plan'

const TODAY = '2026-10-14'
const NOW = new Date('2026-10-14T10:00:00Z')
// A Luhn-valid test personnummer.
const BUYER = '19121212-1212'

// 8 000 net + 2 000 moms = 10 000. The work row is 6 000 + 1 500 moms, so a
// 50 % RUT deduction is 3 750 and the buyer's share 6 250.
function items(): PlanItem[] {
  return [
    { id: 'item-work', sort_order: 1, line_type: 'product', quantity: 12, unit: 'tim', line_total: 6000, vat_amount: 1500 },
    { id: 'item-material', sort_order: 2, line_type: 'product', quantity: 1, unit: 'st', line_total: 2000, vat_amount: 500 },
    { id: 'item-text', sort_order: 3, line_type: 'text', quantity: 0, unit: 'st', line_total: 0, vat_amount: 0 },
  ]
}

function invoice(overrides: Partial<PlanInvoice> = {}): PlanInvoice {
  return {
    id: 'inv-1',
    invoice_number: '1042',
    status: 'sent',
    currency: 'SEK',
    total: 10000,
    paid_amount: 0,
    deduction_total: 0,
    items: items(),
    payment_count: 0,
    reclassification_voucher_id: null,
    ...overrides,
  }
}

function line(id: string, amount: number, extra: Partial<SalesInvoiceLineDto> = {}): SalesInvoiceLineDto {
  return { id, lineExtensionAmount: { value: amount, currencyCode: 'SEK' }, ...extra }
}

function dto(opts: {
  deduction?: Partial<HouseholdDeductionDto> | null
  lines?: SalesInvoiceLineDto[]
  remaining?: number
  paymentDate?: string
} = {}): SalesInvoiceDto {
  const deduction: HouseholdDeductionDto | undefined =
    opts.deduction === null
      ? undefined
      : { kind: 'rut', amount: 3750, buyers: [{ personnummer: BUYER, amount: 3750 }], providerState: 'open', ...opts.deduction }
  return {
    id: 'visma-1',
    invoiceNumber: '1042',
    issueDate: '2026-08-28',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: '', identifications: [] },
    customer: { name: 'Privatkund', identifications: [] },
    lines: opts.lines ?? [
      line('1', 6000, { householdWork: { workType: 'STAD', providerWorkType: '9', hours: 12 } }),
      line('2', 2000),
      line('3', 0),
    ],
    legalMonetaryTotal: { payableAmount: { value: 10000, currencyCode: 'SEK' } },
    paymentStatus: {
      paid: false,
      balance: { value: opts.remaining ?? 10000, currencyCode: 'SEK' },
      lastPaymentDate: opts.paymentDate,
      source: 'enum',
    },
    householdDeduction: deduction,
  }
}

const plan = (inv: PlanInvoice, source: SalesInvoiceDto) => planMigratedDeduction(inv, source, { today: TODAY, now: NOW })

describe('planMigratedDeduction: not yet requested at the provider', () => {
  it('buyer paid nothing: apply, status unchanged', () => {
    const result = plan(invoice(), dto())
    expect(result).toMatchObject({
      outcome: 'apply',
      deductionType: 'rut',
      deductionTotal: 3750,
      personnummer: '191212121212',
      paidOn: null,
      resultingStatus: 'sent',
      reuseVoucherId: null,
      expected: { status: 'sent', total: 10000, paid_amount: 0, payment_count: 0, item_count: 3 },
    })
    if (result.outcome !== 'apply') throw new Error('expected apply')
    expect(result.items).toEqual([
      {
        id: 'item-work',
        line_total: 6000,
        vat_amount: 1500,
        deduction_amount: 3750,
        labor_hours: 12,
        work_type: 'STAD',
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
      },
    ])

    expect(plan(invoice({ status: 'overdue' }), dto())).toMatchObject({ outcome: 'apply', resultingStatus: 'overdue' })
  })

  it('buyer paid part of their share: apply, partially_paid, no payment date', () => {
    expect(plan(invoice({ paid_amount: 1000 }), dto({ remaining: 9000 }))).toMatchObject({
      outcome: 'apply',
      resultingStatus: 'partially_paid',
      paidOn: null,
      expected: { paid_amount: 1000 },
    })
  })

  it('buyer paid their whole share: apply, paid on the provider payment date', () => {
    expect(
      plan(invoice({ paid_amount: 6250 }), dto({ remaining: 3750, paymentDate: '2026-09-01T00:00:00' })),
    ).toMatchObject({ outcome: 'apply', resultingStatus: 'paid', paidOn: '2026-09-01' })
  })

  it('whole share paid but the provider remaining differs: review', () => {
    expect(
      plan(invoice({ paid_amount: 6250 }), dto({ remaining: 3000, paymentDate: '2026-09-01' })),
    ).toMatchObject({ outcome: 'review', reason: 'provider_remaining_differs', deductionTotal: 3750 })
  })

  it('whole share paid in a year whose begäran deadline has passed: review with the date', () => {
    expect(
      plan(invoice({ paid_amount: 6250 }), dto({ remaining: 3750, paymentDate: '2025-06-01' })),
    ).toMatchObject({ outcome: 'review', reason: 'past_deadline', paidOn: '2025-06-01' })
    // 31 January the year after is still in time.
    expect(
      planMigratedDeduction(invoice({ paid_amount: 6250 }), dto({ remaining: 3750, paymentDate: '2025-06-01' }), {
        today: '2026-01-31',
        now: NOW,
      }),
    ).toMatchObject({ outcome: 'apply', resultingStatus: 'paid' })
  })

  it('whole share paid without a payment date: review', () => {
    expect(plan(invoice({ paid_amount: 6250 }), dto({ remaining: 3750 }))).toMatchObject({
      outcome: 'review',
      reason: 'payment_date_missing',
    })
  })
})

describe('planMigratedDeduction: requested or refused at the provider, or no deduction', () => {
  it.each([
    ['requested', 'requested_at_provider'],
    ['rejected', 'rejected_at_provider'],
  ] as const)('%s at the provider: never applied, only the status repair', (state, reason) => {
    expect(plan(invoice(), dto({ deduction: { providerState: state } }))).toEqual({
      outcome: 'skip',
      invoiceId: 'inv-1',
      reason,
    })
    expect(plan(invoice({ paid_amount: 6250 }), dto({ deduction: { providerState: state } }))).toMatchObject({
      outcome: 'status_only',
      expected: { status: 'sent', paid_amount: 6250 },
    })
  })

  it('no deduction: a part-paid import is repaired, anything else is left alone', () => {
    expect(plan(invoice({ paid_amount: 500 }), dto({ deduction: null }))).toMatchObject({ outcome: 'status_only' })
    expect(plan(invoice(), dto({ deduction: null }))).toMatchObject({ outcome: 'skip', reason: 'no_deduction' })
    // Already partially_paid needs no repair.
    expect(plan(invoice({ status: 'partially_paid', paid_amount: 500 }), dto({ deduction: null }))).toMatchObject({
      outcome: 'skip',
      reason: 'no_deduction',
    })
  })

  it('a paid or credited invoice is not open: skipped', () => {
    expect(plan(invoice({ status: 'paid', paid_amount: 10000 }), dto())).toMatchObject({
      outcome: 'skip',
      reason: 'not_open',
    })
  })
})

describe('planMigratedDeduction: sent to review', () => {
  it.each([
    ['two buyers', dto({ deduction: { buyers: [{ personnummer: BUYER }, { personnummer: BUYER }] } }), 'several_buyers'],
    ['no buyer', dto({ deduction: { buyers: [] } }), 'personnummer'],
    ['an invalid personnummer', dto({ deduction: { buyers: [{ personnummer: '19121212-1213' }] } }), 'personnummer'],
    [
      'an unmapped work type',
      dto({ lines: [line('1', 6000, { householdWork: { workType: null, providerWorkType: '20', hours: 12 } }), line('2', 2000), line('3', 0)] }),
      'unmapped_work_type',
    ],
    [
      'a work type of the other kind',
      dto({ lines: [line('1', 6000, { householdWork: { workType: 'BYGG', providerWorkType: '1', hours: 12 } }), line('2', 2000), line('3', 0)] }),
      'unmapped_work_type',
    ],
    ['rows that differ in amount', dto({ lines: [line('1', 5000, { householdWork: { workType: 'STAD', providerWorkType: '9', hours: 12 } }), line('2', 2000), line('3', 0)] }), 'rows_differ'],
    ['rows that differ in number', dto({ lines: [line('1', 6000, { householdWork: { workType: 'STAD', providerWorkType: '9', hours: 12 } }), line('2', 2000)] }), 'rows_differ'],
    ['no work row', dto({ lines: [line('1', 6000), line('2', 2000), line('3', 0)] }), 'rows_differ'],
    ['a deduction not in whole kronor', dto({ deduction: { amount: 3750.5 } }), 'deduction_not_whole_kronor'],
  ])('%s', (_label, source, reason) => {
    expect(plan(invoice(), source)).toMatchObject({ outcome: 'review', reason, invoiceId: 'inv-1' })
  })

  it('a deduction larger than what is still open', () => {
    expect(plan(invoice({ paid_amount: 7000 }), dto({ remaining: 3000 }))).toMatchObject({
      outcome: 'review',
      reason: 'deduction_exceeds_remaining',
    })
  })

  it('an invoice not in SEK', () => {
    expect(plan(invoice({ currency: 'EUR' }), dto())).toMatchObject({ outcome: 'review', reason: 'not_sek' })
  })

  it('a work row without hours, unless its unit is hours or its type is a schablon service', () => {
    const noHours = [line('1', 6000, { householdWork: { workType: 'STAD', providerWorkType: '9' } }), line('2', 2000), line('3', 0)]
    const piece = items().map((item) => (item.id === 'item-work' ? { ...item, unit: 'st' } : item))
    expect(plan(invoice({ items: piece }), dto({ lines: noHours }))).toMatchObject({ outcome: 'review', reason: 'missing_hours' })

    // The quantity is the hours when the unit is hours.
    const fromQuantity = plan(invoice(), dto({ lines: noHours }))
    expect(fromQuantity).toMatchObject({ outcome: 'apply' })
    if (fromQuantity.outcome === 'apply') expect(fromQuantity.items[0].labor_hours).toBe(12)

    const schablon = [line('1', 6000, { householdWork: { workType: 'TRANSPORT', providerWorkType: '28' } }), line('2', 2000), line('3', 0)]
    expect(plan(invoice({ items: piece }), dto({ lines: schablon }))).toMatchObject({ outcome: 'apply' })
  })

  it('ROT without a property; ROT on an apartment with the förening named', () => {
    const rotLines = [line('1', 6000, { householdWork: { workType: 'BYGG', providerWorkType: '1', hours: 12 } }), line('2', 2000), line('3', 0)]
    expect(plan(invoice(), dto({ lines: rotLines, deduction: { kind: 'rot', amount: 2250 } }))).toMatchObject({
      outcome: 'review',
      reason: 'missing_property',
    })
    const apartment = plan(
      invoice(),
      dto({
        lines: rotLines,
        deduction: { kind: 'rot', amount: 2250, property: { type: 'apartment', designation: '1102', brfOrgNumber: '769612-3456' } },
      }),
    )
    expect(apartment).toMatchObject({ outcome: 'apply', deductionType: 'rot' })
    if (apartment.outcome === 'apply') {
      expect(apartment.items[0]).toMatchObject({ apartment_number: '1102', brf_org_number: '769612-3456', housing_designation: null })
    }
  })
})

describe('planMigratedDeduction: invoices the step has already touched', () => {
  it('already carries a deduction: skipped; requested from the provider since: a double request', () => {
    const applied = invoice({ deduction_total: 3750, reclassification_voucher_id: 'je-1' })
    expect(plan(applied, dto())).toMatchObject({ outcome: 'skip', reason: 'already_applied' })
    expect(plan(applied, dto({ deduction: { providerState: 'requested' } }))).toEqual({
      outcome: 'double_request',
      invoiceId: 'inv-1',
      deductionTotal: 3750,
    })
  })

  it('a voucher without the deduction is completed with that voucher, or sent to review', () => {
    expect(plan(invoice({ reclassification_voucher_id: 'je-1' }), dto())).toMatchObject({
      outcome: 'apply',
      reuseVoucherId: 'je-1',
    })
    expect(
      plan(invoice({ reclassification_voucher_id: 'je-1' }), dto({ deduction: { buyers: [] } })),
    ).toMatchObject({ outcome: 'review', reason: 'voucher_without_deduction', deductionTotal: 3750 })
  })
})

describe('spreadDeduction', () => {
  it('spreads in proportion and puts the rounding öre on the largest row', () => {
    const shares = spreadDeduction(1000, [300, 300, 400])
    expect(shares).toEqual([300, 300, 400])
    const odd = spreadDeduction(1001, [1, 1, 1])
    expect(odd.reduce((a, b) => a + b, 0)).toBeCloseTo(1001, 10)
    // 333.67 each would claim 1001.01: the öre comes off the (first) largest row.
    expect(odd).toEqual([333.66, 333.67, 333.67])
  })

  it('spreads over two work rows in the planner and sums to the deduction exactly', () => {
    const twoWork: PlanItem[] = [
      { id: 'a', sort_order: 1, line_type: 'product', quantity: 3, unit: 'tim', line_total: 1000, vat_amount: 250 },
      { id: 'b', sort_order: 2, line_type: 'product', quantity: 5, unit: 'tim', line_total: 2000, vat_amount: 500 },
    ]
    const result = plan(
      invoice({ total: 3750, items: twoWork }),
      dto({
        remaining: 3750,
        deduction: { amount: 1875 },
        lines: [
          line('1', 1000, { householdWork: { workType: 'STAD', providerWorkType: '9', hours: 3 } }),
          line('2', 2000, { householdWork: { workType: 'TRADGARD', providerWorkType: '13', hours: 5 } }),
        ],
      }),
    )
    expect(result).toMatchObject({ outcome: 'apply' })
    if (result.outcome === 'apply') {
      expect(result.items.map((item) => item.deduction_amount)).toEqual([625, 1250])
      expect(result.items.map((item) => item.work_type)).toEqual(['STAD', 'TRADGARD'])
    }
  })
})
