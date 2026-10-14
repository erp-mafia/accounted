import { describe, it, expect } from 'vitest'
import { applyTemplate, convertLibraryToBookingTemplate, deriveTemplateLinesFromBooking, getTemplateScope, LIBRARY_TEMPLATE_PREFIX, libraryLinesForSkattekonto, libraryLinesTouchSkattekonto, templateShareLines } from '../template-library'
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
    // Total payment is 10000 SEK. The supplier charged no VAT, so the payment
    // IS the beskattningsunderlag: fiktiv moms = 10000 * 0.25 on top, never
    // extracted out of the total.
    const result = applyTemplate(lines, 10000)
    expect(result).toHaveLength(4)
    // Business line = 10000 * 1.0
    expect(result[0].debit_amount).toBe('10000.00')
    // VAT = 10000 * 0.25 = 2500 on both offsetting legs
    expect(result[1].credit_amount).toBe('2500.00')
    expect(result[2].debit_amount).toBe('2500.00')
    // Settlement = 10000
    expect(result[3].credit_amount).toBe('10000.00')
  })

  it('reverse charge regression: 807.99 gives 202.00, not 161.60 (20%)', () => {
    // User-reported bug: the seeded "Inköp EU-tjänster, omvänd moms 25%"
    // template produced 807.99 * 0.25 / 1.25 = 161.60 (the inclusive
    // back-calculation, i.e. 20% of the amount) instead of 807.99 * 0.25.
    const lines: BookingTemplateLibraryLine[] = [
      { account: '6540', label: 'IT-tjänster', side: 'debit', type: 'business', ratio: 1.0 },
      { account: '2614', label: 'Utgående moms omvänd skattskyldighet 25%', side: 'credit', type: 'vat', vat_rate: 0.25 },
      { account: '2645', label: 'Beräknad ingående moms 25%', side: 'debit', type: 'vat', vat_rate: 0.25 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1.0 },
    ]
    const result = applyTemplate(lines, 807.99)
    const byAccount = Object.fromEntries(result.map((l) => [l.account_number, l]))
    expect(byAccount['6540'].debit_amount).toBe('807.99')
    expect(byAccount['2614'].credit_amount).toBe('202.00')
    expect(byAccount['2645'].debit_amount).toBe('202.00')
    expect(byAccount['1930'].credit_amount).toBe('807.99')
    // The entry balances: the fiktiv legs net to zero.
    const sumDebit = result.reduce((s, l) => s + (parseFloat(l.debit_amount || '0') || 0), 0)
    const sumCredit = result.reduce((s, l) => s + (parseFloat(l.credit_amount || '0') || 0), 0)
    expect(sumDebit).toBeCloseTo(sumCredit, 2)
  })

  it('applies reduced-rate reverse charge (2624/2645 at 12%) on top of the base', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '4010', label: 'Varuinköp', side: 'debit', type: 'business', ratio: 1.0 },
      { account: '2624', label: 'Utgående moms omvänd 12%', side: 'credit', type: 'vat', vat_rate: 0.12 },
      { account: '2645', label: 'Beräknad ingående moms 12%', side: 'debit', type: 'vat', vat_rate: 0.12 },
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1.0 },
    ]
    const result = applyTemplate(lines, 1000)
    expect(result[1].credit_amount).toBe('120.00')
    expect(result[2].debit_amount).toBe('120.00')
  })

  it('save-as-mall then apply round-trips a correct reverse-charge booking', () => {
    // A correctly booked RC purchase saved via "Spara som mall" and re-applied
    // must reproduce the 25%-of-base fiktiv moms, not shrink it to 20%.
    const source = [
      { account_number: '6540', debit_amount: '807.99', credit_amount: '' },
      { account_number: '2645', debit_amount: '202.00', credit_amount: '' },
      { account_number: '2614', debit_amount: '', credit_amount: '202.00' },
      { account_number: '1930', debit_amount: '', credit_amount: '807.99' },
    ]
    const derived = deriveTemplateLinesFromBooking(source)
    expect(derived.find((l) => l.account === '2614')!.vat_rate).toBe(0.25)
    const applied = applyTemplate(derived, 807.99)
    const byAccount = Object.fromEntries(applied.map((l) => [l.account_number, l]))
    expect(byAccount['2614'].credit_amount).toBe('202.00')
    expect(byAccount['2645'].debit_amount).toBe('202.00')
    expect(byAccount['6540'].debit_amount).toBe('807.99')
  })

  it('save-as-mall then apply round-trips a reverse-charge booking with its basis pair (crm#1096)', () => {
    // What the momskod "tjänster utanför EU, 25 %" books on 6540: the 4531 /
    // 4598 basis pair nets to zero like the fiktiv pair. Counted toward the
    // total it doubled it, and the re-applied mall booked half of everything.
    const source = [
      { account_number: '6540', debit_amount: '1000', credit_amount: '' },
      { account_number: '2645', debit_amount: '250', credit_amount: '' },
      { account_number: '2614', debit_amount: '', credit_amount: '250' },
      { account_number: '4531', debit_amount: '1000', credit_amount: '' },
      { account_number: '4598', debit_amount: '', credit_amount: '1000' },
      { account_number: '1930', debit_amount: '', credit_amount: '1000' },
    ]
    const derived = deriveTemplateLinesFromBooking(source)
    expect(derived.find((l) => l.account === '1930')!.type).toBe('settlement')
    expect(derived.find((l) => l.account === '2614')!.vat_rate).toBe(0.25)

    const applied = applyTemplate(derived, 1000)
    expect(applied.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', '1000.00', ''],
      ['2645', '250.00', ''],
      ['2614', '', '250.00'],
      ['4531', '1000.00', ''],
      ['4598', '', '1000.00'],
      ['1930', '', '1000.00'],
    ])
  })

  it('keeps a 45xx cost line in the total when no 4598 offset sits beside it', () => {
    const derived = deriveTemplateLinesFromBooking([
      { account_number: '4535', debit_amount: '1000', credit_amount: '' },
      { account_number: '2645', debit_amount: '250', credit_amount: '' },
      { account_number: '2614', debit_amount: '', credit_amount: '250' },
      { account_number: '2440', debit_amount: '', credit_amount: '1000' },
    ])
    expect(derived.find((l) => l.account === '4535')).toMatchObject({ type: 'business', ratio: 1 })
    expect(derived.find((l) => l.account === '2440')).toMatchObject({ type: 'settlement', ratio: 1 })
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
    // Hotel: 5830 net 1000, 2641 VAT 120, 1930 gross 1120.
    const lines = deriveTemplateLinesFromBooking([
      { account_number: '5830', debit_amount: '1000', credit_amount: '' },
      { account_number: '2641', debit_amount: '120', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1120' },
    ])
    expect(lines.find((l) => l.account === '2641')!.vat_rate).toBe(0.12)
    expect(lines.find((l) => l.account === '1930')!.type).toBe('settlement')
  })
})

describe('templateShareLines', () => {
  // What the mall editor (TemplateForm) shows share inputs for and checks
  // sums to 1.0: a basis pair there read as three shares summing to 3.
  it('leaves the basis pair of a reverse-charge mall out of the shares (crm#1096)', () => {
    const derived = deriveTemplateLinesFromBooking([
      { account_number: '6540', debit_amount: '1000', credit_amount: '' },
      { account_number: '2645', debit_amount: '250', credit_amount: '' },
      { account_number: '2614', debit_amount: '', credit_amount: '250' },
      { account_number: '4531', debit_amount: '1000', credit_amount: '' },
      { account_number: '4598', debit_amount: '', credit_amount: '1000' },
      { account_number: '1930', debit_amount: '', credit_amount: '1000' },
    ])
    expect(templateShareLines(derived).map((l) => [l.account, l.ratio])).toEqual([['6540', 1]])
  })

  it('keeps every cost line of a split mall beside the basis pair', () => {
    // A momskod on 6540 (600) and none on 6550 (400): the fiktiv moms is 25 %
    // of the 600 basis. Read against the whole total it was 15 %, snapped to 12 %.
    const derived = deriveTemplateLinesFromBooking([
      { account_number: '6540', debit_amount: '600', credit_amount: '' },
      { account_number: '2645', debit_amount: '150', credit_amount: '' },
      { account_number: '2614', debit_amount: '', credit_amount: '150' },
      { account_number: '4531', debit_amount: '600', credit_amount: '' },
      { account_number: '4598', debit_amount: '', credit_amount: '600' },
      { account_number: '6550', debit_amount: '400', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1000' },
    ])
    const shares = templateShareLines(derived)
    expect(shares.map((l) => [l.account, l.ratio])).toEqual([['6540', 0.6], ['6550', 0.4]])
    expect(shares.reduce((sum, l) => sum + (l.ratio ?? 1), 0)).toBe(1)
    expect(derived.filter((l) => l.type === 'vat').map((l) => [l.account, l.vat_rate]))
      .toEqual([['2645', 0.25], ['2614', 0.25]])
  })

  it('reads a fiktiv leg\'s rate from a cost line on a basis account in a split booking', () => {
    // 4531 carries its own basis (600), so there is no 4598 pair to read.
    const derived = deriveTemplateLinesFromBooking([
      { account_number: '4531', debit_amount: '600', credit_amount: '' },
      { account_number: '2645', debit_amount: '150', credit_amount: '' },
      { account_number: '2614', debit_amount: '', credit_amount: '150' },
      { account_number: '6550', debit_amount: '400', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1000' },
    ])
    expect(derived.filter((l) => l.type === 'vat').map((l) => [l.account, l.vat_rate]))
      .toEqual([['2645', 0.25], ['2614', 0.25]])
  })

  it('counts a 45xx line without a 4598 offset as the cost line it is', () => {
    const lines: BookingTemplateLibraryLine[] = [
      { account: '4535', label: 'Tjänster EU', side: 'debit', type: 'business', ratio: 1 },
      { account: '2645', label: 'Moms', side: 'debit', type: 'vat', vat_rate: 0.25 },
      { account: '2614', label: 'Moms', side: 'credit', type: 'vat', vat_rate: 0.25 },
      { account: '2440', label: 'Leverantörsskulder', side: 'credit', type: 'settlement', ratio: 1 },
    ]
    expect(templateShareLines(lines).map((l) => l.account)).toEqual(['4535'])
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

describe('system templates on the company skattekonto account (PH 175)', () => {
  const deposit: BookingTemplateLibraryLine[] = [
    { account: '1630', label: 'Skattekonto', side: 'debit', type: 'business', ratio: 1 },
    { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1 },
  ]

  it('moves only the skattekonto line to 2012', () => {
    expect(libraryLinesTouchSkattekonto(deposit)).toBe(true)
    expect(libraryLinesForSkattekonto(deposit, '2012').map((l) => l.account)).toEqual(['2012', '1930'])
    expect(libraryLinesForSkattekonto(deposit, '2012')[0]).toMatchObject({ label: 'Skattekonto', side: 'debit' })
  })

  it('leaves the lines alone on 1630, without an account, or without a skattekonto line', () => {
    expect(libraryLinesForSkattekonto(deposit, '1630')).toEqual(deposit)
    expect(libraryLinesForSkattekonto(deposit, undefined)).toBe(deposit)
    const sale: BookingTemplateLibraryLine[] = [
      { account: '1930', label: 'Bank', side: 'debit', type: 'settlement' },
      { account: '3001', label: 'Försäljning', side: 'credit', type: 'business', ratio: 1 },
    ]
    expect(libraryLinesTouchSkattekonto(sale)).toBe(false)
    expect(libraryLinesForSkattekonto(sale, '2012')).toBe(sale)
  })
})
