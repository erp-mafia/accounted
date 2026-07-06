import { describe, it, expect } from 'vitest'
import { applyTemplate, convertLibraryToBookingTemplate, deriveTemplateLinesFromBooking, getTemplateScope, LIBRARY_TEMPLATE_PREFIX, TEMPLATE_CATEGORY_LABELS } from '../template-library'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine } from '@/types'

function makeLibraryTemplate(lines: BookingTemplateLibraryLine[], overrides: Partial<BookingTemplateLibrary> = {}): BookingTemplateLibrary {
  return {
    id: 'tpl-1',
    company_id: 'co-1',
    team_id: null,
    created_by: 'user-1',
    name: 'Test template',
    description: '',
    category: 'other',
    entity_type: 'all',
    lines,
    is_system: false,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('applyTemplate', () => {
  it('creates simple two-line debit/credit entries', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '1630', label: 'Skattekonto', side: 'debit', type: 'business', ratio: 1.0 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1.0 },
    ]
    const result = applyTemplate(lines, 10000)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      account_number: '1630',
      debit_amount: '10000.00',
      credit_amount: '',
      line_description: 'Skattekonto',
    })
    expect(result[1]).toEqual({
      account_number: '1930',
      debit_amount: '',
      credit_amount: '10000.00',
      line_description: 'Företagskonto',
    })
  })

  it('calculates VAT correctly for reverse charge (EU purchase)', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '4010', label: 'Varuinköp', side: 'debit', type: 'business', ratio: 1.0 },
      { account: '2614', label: 'Utgående moms', side: 'credit', type: 'vat', vat_rate: 0.25 },
      { account: '2645', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1.0 },
    ]
    // Total payment is 10000 SEK (no VAT on the payment itself for reverse charge)
    const result = applyTemplate(lines, 10000)
    expect(result).toHaveLength(4)
    // Business line = 10000 * 1.0
    expect(result[0].debit_amount).toBe('10000.00')
    // VAT = 10000 * 0.25 / (1 + 0.25) = 2000
    expect(result[1].credit_amount).toBe('2000.00')
    expect(result[2].debit_amount).toBe('2000.00')
    // Settlement = 10000
    expect(result[3].credit_amount).toBe('10000.00')
  })

  it('handles representation with 25% input VAT', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '6072', label: 'Representation', side: 'debit', type: 'business', ratio: 1.0 },
      { account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1.0 },
    ]
    // Total paid = 1250 (1000 + 250 VAT)
    const result = applyTemplate(lines, 1250)
    expect(result).toHaveLength(3)
    // Business = 1250 (the representation cost at full ratio)
    expect(result[0].debit_amount).toBe('1250.00')
    // VAT = 1250 * 0.25 / 1.25 = 250
    expect(result[1].debit_amount).toBe('250.00')
    // Settlement = 1250
    expect(result[2].credit_amount).toBe('1250.00')
  })

  it('rounds monetary values to 2 decimal places', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '4010', label: 'Varuinköp', side: 'debit', type: 'business', ratio: 1.0 },
      { account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25 },
      { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1.0 },
    ]
    // 333.33 should produce clean rounding
    const result = applyTemplate(lines, 333.33)
    expect(result[0].debit_amount).toBe('333.33')
    // 333.33 * 0.25 / 1.25 = 66.666 → 66.67
    expect(result[1].debit_amount).toBe('66.67')
    expect(result[2].credit_amount).toBe('333.33')
  })
})

describe('deriveTemplateLinesFromBooking', () => {
  it('classifies cost + input VAT + settlement (the Bokför direkt shape)', () => {
    // Mirrors the screenshot: 2641 D 96.40, 5420 D 385.40, 2893 K 481.80.
    const lines = deriveTemplateLinesFromBooking(
      [
        { account_number: '2641', debit_amount: '96.40', credit_amount: '' },
        { account_number: '5420', debit_amount: '385.40', credit_amount: '' },
        { account_number: '2893', debit_amount: '', credit_amount: '481.80' },
      ],
      { '2641': 'Debiterad ingående moms', '5420': 'Programvaror', '2893': 'Avräkning ägare' },
    )

    const vat = lines.find((l) => l.account === '2641')!
    expect(vat.type).toBe('vat')
    expect(vat.vat_rate).toBe(0.25)
    expect(vat.side).toBe('debit')

    const cost = lines.find((l) => l.account === '5420')!
    expect(cost.type).toBe('business')
    expect(cost.label).toBe('Programvaror')

    const settlement = lines.find((l) => l.account === '2893')!
    expect(settlement.type).toBe('settlement')
    expect(settlement.ratio).toBe(1)
    expect(settlement.side).toBe('credit')

    // Exactly one business + one settlement → convertible for the tx picker.
    expect(convertLibraryToBookingTemplate(
      { id: 'x', company_id: null, team_id: null, created_by: null, name: 'n', description: '', category: 'other', entity_type: 'all', lines, is_system: false, is_active: true, created_at: '', updated_at: '' },
    )).not.toBeNull()
  })

  it('re-applying the derived template reproduces the original split (± öre)', () => {
    const source = [
      { account_number: '5420', debit_amount: '385.40', credit_amount: '' },
      { account_number: '2641', debit_amount: '96.40', credit_amount: '' },
      { account_number: '2893', debit_amount: '', credit_amount: '481.80' },
    ]
    const applied = applyTemplate(deriveTemplateLinesFromBooking(source), 481.8)
    const byAccount = Object.fromEntries(applied.map((l) => [l.account_number, l]))
    expect(Number(byAccount['5420'].debit_amount)).toBeCloseTo(385.4, 1)
    expect(Number(byAccount['2641'].debit_amount)).toBeCloseTo(96.36, 1)
    expect(Number(byAccount['2893'].credit_amount)).toBeCloseTo(481.8, 2)
  })

  it('derives a simple two-line transfer (one business + one settlement)', () => {
    const lines = deriveTemplateLinesFromBooking([
      { account_number: '1630', debit_amount: '10000', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '10000' },
    ])
    expect(lines).toHaveLength(2)
    expect(lines.filter((l) => l.type === 'settlement')).toHaveLength(1)
    expect(lines.filter((l) => l.type === 'business')).toHaveLength(1)
    // The credit leg is tagged settlement on an equal-amount tie.
    expect(lines.find((l) => l.account === '1930')!.type).toBe('settlement')
  })

  it('falls back to the account number when no name is supplied', () => {
    const lines = deriveTemplateLinesFromBooking([
      { account_number: '1630', debit_amount: '500', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '500' },
    ])
    expect(lines.every((l) => l.label.length > 0)).toBe(true)
    expect(lines.find((l) => l.account === '1630')!.label).toBe('1630')
  })

  it('drops rows without a 4-digit account or amount and returns [] below two lines', () => {
    expect(
      deriveTemplateLinesFromBooking([
        { account_number: '', debit_amount: '100', credit_amount: '' },
        { account_number: '19', debit_amount: '', credit_amount: '100' },
        { account_number: '1930', debit_amount: '0', credit_amount: '' },
      ]),
    ).toEqual([])
  })

  it('snaps a 12% VAT line to the reduced rate', () => {
    // Hotel: 5820 net 1000, 2641 VAT 120, 1930 gross 1120.
    const lines = deriveTemplateLinesFromBooking([
      { account_number: '5820', debit_amount: '1000', credit_amount: '' },
      { account_number: '2641', debit_amount: '120', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1120' },
    ])
    expect(lines.find((l) => l.account === '2641')!.vat_rate).toBe(0.12)
    expect(lines.find((l) => l.account === '1930')!.type).toBe('settlement')
  })
})

describe('getTemplateScope', () => {
  it('identifies system templates', () => {
    expect(getTemplateScope({ is_system: true, team_id: null, company_id: null })).toBe('system')
  })

  it('identifies team templates', () => {
    expect(getTemplateScope({ is_system: false, team_id: 'team-1', company_id: null })).toBe('team')
  })

  it('identifies company templates', () => {
    expect(getTemplateScope({ is_system: false, team_id: null, company_id: 'comp-1' })).toBe('company')
  })
})

describe('TEMPLATE_CATEGORY_LABELS', () => {
  it('has labels for all categories', () => {
    expect(Object.keys(TEMPLATE_CATEGORY_LABELS)).toHaveLength(9)
    expect(TEMPLATE_CATEGORY_LABELS.eu_trade).toBe('EU-handel')
    expect(TEMPLATE_CATEGORY_LABELS.tax_account).toBe('Skattekonto')
  })
})

describe('convertLibraryToBookingTemplate', () => {
  it('converts a simple 2-line business + settlement template', () => {
    const tpl = makeLibraryTemplate([
      { account: '6072', label: 'Representation', side: 'debit', type: 'business', ratio: 1 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1 },
    ])
    const result = convertLibraryToBookingTemplate(tpl)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(`${LIBRARY_TEMPLATE_PREFIX}tpl-1`)
    expect(result!.direction).toBe('expense')
    expect(result!.debit_account).toBe('6072')
    expect(result!.credit_account).toBe('1930')
    expect(result!.vat_treatment).toBeNull()
  })

  it('identifies direction "income" when business line is on credit', () => {
    const tpl = makeLibraryTemplate([
      { account: '3001', label: 'Försäljning', side: 'credit', type: 'business', ratio: 1 },
      { account: '1930', label: 'Företagskonto', side: 'debit', type: 'settlement', ratio: 1 },
    ])
    const result = convertLibraryToBookingTemplate(tpl)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('income')
    expect(result!.debit_account).toBe('1930')
    expect(result!.credit_account).toBe('3001')
  })

  it.each([
    [0.25, 'standard_25'],
    [0.12, 'reduced_12'],
    [0.06, 'reduced_6'],
  ] as const)('extracts VAT treatment for rate %f', (rate, treatment) => {
    const tpl = makeLibraryTemplate([
      { account: '4010', label: 'Varor', side: 'debit', type: 'business', ratio: 1 },
      { account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: rate },
      { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 },
    ])
    const result = convertLibraryToBookingTemplate(tpl)
    expect(result).not.toBeNull()
    expect(result!.vat_treatment).toBe(treatment)
    expect(result!.vat_rate).toBe(rate)
  })

  it('detects reverse charge via 2614 fictitious output VAT', () => {
    const tpl = makeLibraryTemplate([
      { account: '4056', label: 'EU-varor', side: 'debit', type: 'business', ratio: 1 },
      { account: '2614', label: 'Utg. moms omv.', side: 'credit', type: 'vat', vat_rate: 0.25 },
      { account: '2645', label: 'Ing. moms omv.', side: 'debit', type: 'vat', vat_rate: 0.25 },
      { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 },
    ])
    const result = convertLibraryToBookingTemplate(tpl)
    expect(result).not.toBeNull()
    expect(result!.vat_treatment).toBe('reverse_charge')
  })

  it('returns null when there are 2 business lines', () => {
    const tpl = makeLibraryTemplate([
      { account: '6072', label: 'A', side: 'debit', type: 'business', ratio: 0.5 },
      { account: '6073', label: 'B', side: 'debit', type: 'business', ratio: 0.5 },
      { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 },
    ])
    expect(convertLibraryToBookingTemplate(tpl)).toBeNull()
  })

  it('returns null when there is no settlement line', () => {
    const tpl = makeLibraryTemplate([
      { account: '6072', label: 'A', side: 'debit', type: 'business', ratio: 1 },
      { account: '2641', label: 'Moms', side: 'debit', type: 'vat', vat_rate: 0.25 },
    ])
    expect(convertLibraryToBookingTemplate(tpl)).toBeNull()
  })

  it('returns null when business and settlement are on the same side', () => {
    const tpl = makeLibraryTemplate([
      { account: '6072', label: 'A', side: 'debit', type: 'business', ratio: 1 },
      { account: '1930', label: 'Bank', side: 'debit', type: 'settlement', ratio: 1 },
    ])
    expect(convertLibraryToBookingTemplate(tpl)).toBeNull()
  })

  it('returns null when lines is not an array', () => {
    const tpl = makeLibraryTemplate([], { lines: null as unknown as BookingTemplateLibraryLine[] })
    expect(convertLibraryToBookingTemplate(tpl)).toBeNull()
  })

  // Real-world shape from before the editor defaulted new lines to 'vat': users
  // would tap "add line" twice and end up with three lines all typed 'business'
  // (the dropdown default at the time). The converter rightly rejects this;
  // the transaction picker now still surfaces these templates and routes the
  // click to the manual booking editor instead of hiding them.
  it('returns null when every line is typed "business" (pre-#589 default)', () => {
    const tpl = makeLibraryTemplate([
      { account: '5420', label: 'Programvara', side: 'debit', type: 'business', ratio: 1 },
      { account: '2640', label: 'Ingående moms', side: 'debit', type: 'business', ratio: 0.25 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'business', ratio: 1 },
    ])
    expect(convertLibraryToBookingTemplate(tpl)).toBeNull()
  })
})

describe('applyTemplate on shapes the converter rejects', () => {
  // The transaction picker's fallback for unconvertible templates is to open
  // the manual booking dialog with initialLines = applyTemplate(raw.lines, |amount|).
  // These tests pin that path: even when the shape is too rich for the simple
  // debit/credit summary, applyTemplate still produces a usable FormLine[].
  it('still produces lines for a split-expense template (two business legs)', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '5420', label: 'Programvara', side: 'debit', type: 'business', ratio: 0.7 },
      { account: '6991', label: 'Övrigt', side: 'debit', type: 'business', ratio: 0.3 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1 },
    ]
    const result = applyTemplate(lines, 1000)
    expect(result).toHaveLength(3)
    expect(result[0].debit_amount).toBe('700.00')
    expect(result[1].debit_amount).toBe('300.00')
    expect(result[2].credit_amount).toBe('1000.00')
  })

  it('still produces lines when every leg is typed "business"', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '5420', label: 'Programvara', side: 'debit', type: 'business', ratio: 1 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'business', ratio: 1 },
    ]
    const result = applyTemplate(lines, 250)
    expect(result).toHaveLength(2)
    expect(result[0].debit_amount).toBe('250.00')
    expect(result[1].credit_amount).toBe('250.00')
  })
})

describe('library mall books its literal accounts (regression)', () => {
  // A user's "Inbetalning från kund" mall is D 1930 (bank) / K 1510
  // (kundfordran). The QuickReview fast path used to reduce a library template
  // to a category + one account_override and book D 6991 / K 1930: or, with a
  // VAT line, D 1930 / K 1930 / K 2611: silently dropping the chosen accounts.
  // The transaction picker now routes EVERY library template through the
  // journal-entry editor, whose lines come from applyTemplate. These tests pin
  // the guarantee the editor path relies on: applyTemplate books exactly the
  // accounts/sides the user defined, and never re-derives a counter account.
  const AMOUNT = 5000

  const customerPaymentLines: BookingTemplateLibraryLine[] = [
    { account: '1930', label: 'Inbetalning', side: 'debit', type: 'settlement', ratio: 1 },
    { account: '1510', label: 'Kundfordran', side: 'credit', type: 'business', ratio: 1 },
  ]

  it('books exactly D 1930 / K 1510 with no re-derived accounts', () => {
    const result = applyTemplate(customerPaymentLines, AMOUNT)
    expect(result).toEqual([
      { account_number: '1930', debit_amount: '5000.00', credit_amount: '', line_description: 'Inbetalning' },
      { account_number: '1510', debit_amount: '', credit_amount: '5000.00', line_description: 'Kundfordran' },
    ])
    // The accounts the lossy fast path used to inject must never appear.
    const accounts = result.map((l) => l.account_number)
    expect(accounts).not.toContain('6991')
    expect(accounts).not.toContain('3001')
    expect(accounts).not.toContain('2611')
  })

  it('is blind to business/settlement tagging: same accounts either way', () => {
    // The old converter keyed "direction" (and thus the whole booking) off which
    // leg was tagged business vs settlement. applyTemplate must not: swapping the
    // tags leaves the same accounts on the same sides.
    const swappedTags: BookingTemplateLibraryLine[] = [
      { account: '1930', label: 'Inbetalning', side: 'debit', type: 'business', ratio: 1 },
      { account: '1510', label: 'Kundfordran', side: 'credit', type: 'settlement', ratio: 1 },
    ]
    expect(applyTemplate(swappedTags, AMOUNT)).toEqual(applyTemplate(customerPaymentLines, AMOUNT))
  })

  it('stays balanced (sum debit === sum credit)', () => {
    const result = applyTemplate(customerPaymentLines, 4999.99)
    const sumDebit = result.reduce((s, l) => s + (parseFloat(l.debit_amount || '0') || 0), 0)
    const sumCredit = result.reduce((s, l) => s + (parseFloat(l.credit_amount || '0') || 0), 0)
    expect(sumDebit).toBeCloseTo(sumCredit, 2)
    expect(sumDebit).toBeCloseTo(4999.99, 2)
  })
})
