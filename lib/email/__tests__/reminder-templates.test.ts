import { describe, it, expect } from 'vitest'
import {
  generateReminderEmailHtml,
  generateReminderEmailText,
  generateReminderEmailSubject,
  calculateReminderAmounts,
  formatReminderTotalDue,
  REMINDER_FEE_CURRENCY,
  reminderPrincipal,
} from '../reminder-templates'
import { formatCurrency } from '@/lib/utils'
import { makeCustomer, makeInvoice, makeCompanySettings } from '@/tests/helpers'
import type { CompanySettings } from '@/types'

const company = makeCompanySettings({ company_name: 'Acme AB' })
const customer = makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se' })
const invoice = makeInvoice({
  invoice_number: 'F2026010',
  invoice_date: '2026-04-15',
  due_date: '2026-05-01',
  currency: 'SEK',
  total: 10_000,
})

const eurInvoice = makeInvoice({
  invoice_number: 'F2026011',
  invoice_date: '2026-04-15',
  due_date: '2026-05-01',
  currency: 'EUR',
  total: 1_000,
})

const baseData = {
  invoice,
  customer,
  company,
  reminderLevel: 1 as const,
  daysOverdue: 25,
  actionUrl: 'https://example.com/invoice-action/abc',
}

const eurBaseData = { ...baseData, invoice: eurInvoice }

describe('reminder email templates: surcharges', () => {
  it('renders dröjsmålsränta + påminnelseavgift in HTML when set', () => {
    const html = generateReminderEmailHtml({
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
    })
    expect(html).toContain('Ursprungligt belopp:')
    expect(html).toContain('Dröjsmålsränta')
    expect(html).toContain('Påminnelseavgift:')
    expect(html).toContain('Att betala:')
    expect(html).toContain('10,5%') // rate display (sv-SE format)
    expect(html).toContain('30 dagar')
  })

  it('omits surcharge rows when both are zero', () => {
    const html = generateReminderEmailHtml({
      ...baseData,
      interestAmount: 0,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 0,
      reminderFee: 0,
    })
    expect(html).not.toContain('Dröjsmålsränta')
    expect(html).not.toContain('Påminnelseavgift:')
    expect(html).toContain('Att betala:')
  })

  it('renders surcharges in plain text', () => {
    const text = generateReminderEmailText({
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
    })
    expect(text).toContain('Ursprungligt belopp')
    expect(text).toContain('Dröjsmålsränta')
    expect(text).toContain('Påminnelseavgift')
    expect(text).toContain('Att betala')
  })

  it('subject includes surcharge note when surcharges apply', () => {
    const subject = generateReminderEmailSubject({
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
    })
    expect(subject).toContain('F2026010')
    expect(subject).toContain('inkl. dröjsmålsränta')
  })

  it('subject is unchanged when no surcharges apply', () => {
    const subject = generateReminderEmailSubject({
      ...baseData,
      interestAmount: 0,
      interestRate: 0,
      interestFromDate: '2026-05-01',
      interestDays: 0,
      reminderFee: 0,
    })
    expect(subject).not.toContain('inkl. dröjsmålsränta')
    expect(subject).toContain('F2026010')
  })
})

describe('calculateReminderAmounts', () => {
  it('folds the fee into the total for a SEK invoice', () => {
    expect(
      calculateReminderAmounts({
        invoiceTotal: 10_000,
        interestAmount: 86.3,
        reminderFee: 60,
        currency: 'SEK',
      }),
    ).toEqual({ currency: 'SEK', totalDue: 10_146.3, feeDueSeparately: 0 })
  })

  it('keeps the SEK fee out of a foreign-currency total', () => {
    expect(
      calculateReminderAmounts({
        invoiceTotal: 1_000,
        interestAmount: 10,
        reminderFee: 60,
        currency: 'EUR',
      }),
    ).toEqual({ currency: 'EUR', totalDue: 1_010, feeDueSeparately: 60 })
  })

  it('treats a missing currency as SEK', () => {
    expect(
      calculateReminderAmounts({
        invoiceTotal: 100,
        interestAmount: 0,
        reminderFee: 60,
        currency: null,
      }),
    ).toEqual({ currency: 'SEK', totalDue: 160, feeDueSeparately: 0 })
  })

  it('rounds with Math.round(x * 100) / 100, not toFixed', () => {
    const amounts = calculateReminderAmounts({
      invoiceTotal: 1_000.005,
      interestAmount: 0.011,
      reminderFee: 0,
      currency: 'SEK',
    })
    expect(amounts.totalDue).toBe(1_000.02)
  })

  it('renders a split total as two amounts, never one mixed scalar', () => {
    const amounts = calculateReminderAmounts({
      invoiceTotal: 1_000,
      interestAmount: 10,
      reminderFee: 60,
      currency: 'EUR',
    })
    expect(formatReminderTotalDue(amounts)).toBe(
      `${formatCurrency(1_010, 'EUR')} + ${formatCurrency(60, 'SEK')}`,
    )
  })
})

describe('reminder email templates: statutory fee currency (Lag 1981:739)', () => {
  const eurSurcharges = {
    interestAmount: 10,
    interestRate: 0.105,
    interestFromDate: '2026-05-01',
    interestDays: 30,
    reminderFee: 60,
  }

  it('the fee is a SEK statute, not the invoice currency', () => {
    expect(REMINDER_FEE_CURRENCY).toBe('SEK')
  })

  it('never labels the 60 kr fee with the invoice currency in HTML', () => {
    const html = generateReminderEmailHtml({ ...eurBaseData, ...eurSurcharges })

    expect(
      html,
      'the påminnelseavgift is capped at 60 kr by Lag 1981:739; rendering it as 60 EUR demands roughly 690 kr',
    ).not.toContain(formatCurrency(60, 'EUR'))
    expect(html).toContain(formatCurrency(60, 'SEK'))
  })

  it('never sums a SEK fee into a EUR total in HTML', () => {
    const html = generateReminderEmailHtml({ ...eurBaseData, ...eurSurcharges })

    // 1000 EUR invoice + 10 EUR interest = 1010 EUR, plus 60 kr alongside.
    expect(html).toContain(formatCurrency(1_010, 'EUR'))
    expect(html).not.toContain(formatCurrency(1_070, 'EUR'))
    expect(html).toContain('Lag 1981:739')
  })

  it('never labels the fee with the invoice currency in plain text', () => {
    const text = generateReminderEmailText({ ...eurBaseData, ...eurSurcharges })

    expect(text).toContain(`Påminnelseavgift: ${formatCurrency(60, 'SEK')}`)
    expect(text).not.toContain(formatCurrency(60, 'EUR'))
    expect(text).toContain(
      `Att betala: ${formatCurrency(1_010, 'EUR')} + ${formatCurrency(60, 'SEK')}`,
    )
  })

  it('never quotes a mixed-currency amount in the subject', () => {
    const subject = generateReminderEmailSubject({ ...eurBaseData, ...eurSurcharges })

    expect(subject).not.toContain(formatCurrency(1_070, 'EUR'))
    expect(subject).toContain(
      `${formatCurrency(1_010, 'EUR')} + ${formatCurrency(60, 'SEK')}`,
    )
  })

  it('leaves a SEK invoice untouched: one currency, one total, no split note', () => {
    const data = {
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
    }
    const html = generateReminderEmailHtml(data)
    const text = generateReminderEmailText(data)
    const subject = generateReminderEmailSubject(data)

    expect(html).toContain(formatCurrency(60, 'SEK'))
    expect(html).toContain(formatCurrency(10_146.3, 'SEK'))
    expect(html).not.toContain('Lag 1981:739')
    expect(text).toContain(`Påminnelseavgift: ${formatCurrency(60, 'SEK')}`)
    expect(text).toContain(`Att betala: ${formatCurrency(10_146.3, 'SEK')}`)
    expect(text).not.toContain(' + ')
    expect(subject).toContain(formatCurrency(10_146.3, 'SEK'))
  })

  it('does not append a SEK note when the fee is disabled on a EUR invoice', () => {
    const html = generateReminderEmailHtml({
      ...eurBaseData,
      ...eurSurcharges,
      reminderFee: 0,
    })
    expect(html).not.toContain('Lag 1981:739')
    expect(html).toContain(formatCurrency(1_010, 'EUR'))
  })
})

describe('reminder email templates: ROT/RUT-avdrag (fakturamodellen)', () => {
  // 12 500 total with a 3 750 ROT deduction: the customer was asked for
  // 8 750; the 3 750 is a claim on Skatteverket and must never be dunned.
  const rotInvoice = makeInvoice({
    invoice_number: 'F2026012',
    invoice_date: '2026-04-15',
    due_date: '2026-05-01',
    currency: 'SEK',
    total: 12_500,
    deduction_total: 3_750,
  } as Parameters<typeof makeInvoice>[0])
  const rotData = { ...baseData, invoice: rotInvoice, interestAmount: 0, interestRate: 0, interestFromDate: '2026-05-02', interestDays: 0, reminderFee: 0 }

  it('reminderPrincipal is the customer share', () => {
    expect(reminderPrincipal(rotInvoice, company)).toBe(8_750)
    expect(reminderPrincipal(invoice, company)).toBe(10_000)
  })

  it('HTML, text and subject never quote the pre-deduction total', () => {
    const html = generateReminderEmailHtml(rotData)
    const text = generateReminderEmailText(rotData)
    const subject = generateReminderEmailSubject({ ...rotData, reminderFee: 60 })
    for (const out of [html, text]) {
      expect(out).toContain(formatCurrency(8_750, 'SEK'))
      expect(out).not.toContain(formatCurrency(12_500, 'SEK'))
    }
    expect(subject).not.toContain(formatCurrency(12_500, 'SEK'))
  })

  it('folds interest and fee onto the customer share', () => {
    const amounts = calculateReminderAmounts({
      invoiceTotal: reminderPrincipal(rotInvoice, company),
      interestAmount: 12.5,
      reminderFee: 60,
      currency: 'SEK',
    })
    expect(amounts.totalDue).toBe(8_822.5)
  })
})

describe('payment details follow the invoice currency', () => {
  const multiCurrencyCompany = makeCompanySettings({
    company_name: 'Acme AB',
    bank_name: 'Svenska Banken',
    iban: 'SE4550000000058398257466',
    bic: 'ESSESESS',
    invoice_payment_accounts: {
      SEK: { bank_name: 'Svenska Banken', iban: 'SE4550000000058398257466', bic: 'ESSESESS' },
      EUR: { bank_name: 'Deutsche Bank', iban: 'DE89370400440532013000', bic: 'DEUTDEFF' },
    } as CompanySettings['invoice_payment_accounts'],
  })

  it('prints the EUR account on a EUR reminder, never the SEK IBAN', () => {
    const data = { ...baseData, company: multiCurrencyCompany, invoice: eurInvoice }
    const html = generateReminderEmailHtml(data)
    const text = generateReminderEmailText(data)
    for (const out of [html, text]) {
      expect(out).toContain('DE89370400440532013000')
      expect(out).toContain('DEUTDEFF')
      expect(out).toContain('Deutsche Bank')
      expect(out).not.toContain('SE4550000000058398257466')
      expect(out).not.toContain('ESSESESS')
    }
  })

  it('keeps the SEK account on a SEK reminder', () => {
    const data = { ...baseData, company: multiCurrencyCompany, invoice }
    const html = generateReminderEmailHtml(data)
    const text = generateReminderEmailText(data)
    for (const out of [html, text]) {
      expect(out).toContain('SE4550000000058398257466')
      expect(out).not.toContain('DE89370400440532013000')
    }
  })


  it('never falls back to the legacy SEK fields for a EUR reminder when no EUR account exists', () => {
    const sekOnly = makeCompanySettings({
      company_name: 'Acme AB',
      bank_name: 'Svenska Banken',
      iban: 'SE4550000000058398257466',
      bic: 'ESSESESS',
    })
    const data = { ...baseData, company: sekOnly, invoice: eurInvoice }
    for (const out of [generateReminderEmailHtml(data), generateReminderEmailText(data)]) {
      expect(out).not.toContain('SE4550000000058398257466')
      expect(out).not.toContain('Svenska Banken')
    }
  })
})

describe('reminder email texts: per-company overrides', () => {
  const zeroSurcharges = {
    interestAmount: 0,
    interestRate: 0,
    interestFromDate: '2026-05-02',
    interestDays: 0,
    reminderFee: 0,
  }
  const withOverrides = (overrides: CompanySettings['reminder_text_overrides']) => ({
    ...baseData,
    ...zeroSurcharges,
    company: makeCompanySettings({ company_name: 'Acme AB', reminder_text_overrides: overrides }),
  })

  it('renders the stock texts when no overrides are stored', () => {
    const data = withOverrides(null)
    const text = generateReminderEmailText(data)
    const html = generateReminderEmailHtml(data)
    const subject = generateReminderEmailSubject(data)
    expect(text).toContain(
      'Vi vill påminna dig om att faktura F2026010 förföll till betalning den 2026-05-01.',
    )
    expect(html).toContain('Om du redan har betalat kan du bortse från denna påminnelse.')
    expect(subject).toBe(
      `Vänlig påminnelse: Faktura F2026010 - ${formatCurrency(10_000, 'SEK')}`,
    )
  })

  it('the stock final level is an inkassovarning, never fee math', () => {
    const data = { ...withOverrides(null), reminderLevel: 3 as const }
    const text = generateReminderEmailText(data)
    const html = generateReminderEmailHtml(data)
    for (const out of [text, html]) {
      expect(out).toContain('inkassovarning')
      expect(out).toContain('överlämnas fordran till inkasso')
      expect(out).toContain('lag (1981:739)')
      expect(out).toContain('inom 8 dagar')
      // Text only: no fee amount is promised or invented by the template.
      expect(out).not.toContain('450')
    }
    // The opening inkassovarning paragraph keeps the red emphasis.
    expect(html).toContain('color: #dc2626; font-weight: 500;')
  })

  it('a body override wins in HTML and text; the subject stays stock', () => {
    const data = withOverrides({ level_1: { body: 'Vår helt egna påminnelsetext.' } })
    const text = generateReminderEmailText(data)
    const html = generateReminderEmailHtml(data)
    for (const out of [text, html]) {
      expect(out).toContain('Vår helt egna påminnelsetext.')
      expect(out).not.toContain('Vi vill påminna dig om att faktura')
    }
    expect(generateReminderEmailSubject(data)).toContain('Vänlig påminnelse: Faktura F2026010')
  })

  it('a subject override wins and owns the whole line: no automatic suffix', () => {
    const data = {
      ...withOverrides({ level_1: { subject: 'Obetald faktura {fakturanummer}' } }),
      interestAmount: 86.3,
      interestRate: 0.105,
      interestDays: 30,
      reminderFee: 60,
    }
    const subject = generateReminderEmailSubject(data)
    expect(subject).toBe('Obetald faktura F2026010')
    expect(subject).not.toContain('inkl. dröjsmålsränta')
    // The body is untouched by a subject-only override.
    expect(generateReminderEmailText(data)).toContain('Vi vill påminna dig om att faktura')
  })

  it('substitutes the documented placeholders in overrides', () => {
    const data = withOverrides({
      level_1: {
        body: 'Faktura {fakturanummer} till {kundnamn} ({förnamn}) från {företag} förföll {förfallodatum} ({dagar} dagar sedan). Att betala: {belopp}. Skickad {fakturadatum}.',
      },
    })
    const text = generateReminderEmailText(data)
    expect(text).toContain(
      `Faktura F2026010 till Erik Andersson (Erik) från Acme AB förföll 2026-05-01 (25 dagar sedan). Att betala: ${formatCurrency(10_000, 'SEK')}. Skickad 2026-04-15.`,
    )
  })

  it('leaves unknown placeholders as literal text', () => {
    const data = withOverrides({ level_1: { body: 'Hej {okänd} värld' } })
    expect(generateReminderEmailText(data)).toContain('Hej {okänd} värld')
  })

  it('falls back to the default for whitespace-only override fields', () => {
    const data = withOverrides({ level_1: { subject: '   ', body: '\n' } })
    expect(generateReminderEmailSubject(data)).toContain('Vänlig påminnelse: Faktura F2026010')
    expect(generateReminderEmailText(data)).toContain('Vi vill påminna dig om att faktura')
  })

  it('escapes override content in HTML and keeps paragraph breaks', () => {
    const data = withOverrides({
      level_1: { body: 'Första stycket <script>alert(1)</script>\n\nAndra stycket\nmed radbrytning' },
    })
    const html = generateReminderEmailHtml(data)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Andra stycket<br>med radbrytning')
    // Two paragraphs -> two <p> blocks.
    expect(html.match(/Första stycket/g)).toHaveLength(1)
    expect(html).toContain('<p style="margin: 0 0 15px 0;">Andra stycket<br>med radbrytning</p>')
  })

  it('applies an override only to its own level', () => {
    const overrides = { level_2: { body: 'Egen text för nivå två.' } }
    const level1 = generateReminderEmailText(withOverrides(overrides))
    const level2 = generateReminderEmailText({
      ...withOverrides(overrides),
      reminderLevel: 2 as const,
    })
    expect(level1).not.toContain('Egen text för nivå två.')
    expect(level1).toContain('Vi vill påminna dig')
    expect(level2).toContain('Egen text för nivå två.')
    expect(level2).not.toContain('Trots vår tidigare påminnelse')
  })
})
