/**
 * The approval card of an operation without a dedicated preview (crm#1104).
 * Reported: "Bokför 4 skattekontohändelser" showed "rows: 4 rader, row count:
 * 4, total amount: 192264, skattekonto account: 1630", nothing about the
 * verifikat it posts. The card must show the verifikat (the executor's lines,
 * staged as journal_entry / journal_entries), state plain fields only under
 * a label the approver reads, and write money as money.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatCurrency } from '@/lib/utils'
import { currencyForField, formatPreviewNumber, isMoneyField } from '../preview-facts'

// The real Swedish strings, so a field without a label really has none.
vi.mock('next-intl', async () => {
  const sv = (await import('@/messages/sv.json')).default as { pending: Record<string, unknown> }
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], sv.pending)
  const t = (key: string, values?: Record<string, unknown>) => {
    const text = lookup(key)
    return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name])) : key
  }
  return {
    useTranslations: () => Object.assign(t, { has: (key: string) => typeof lookup(key) === 'string' }),
    useLocale: () => 'sv',
  }
})

const { OperationPreview } = await import('../OperationPreview')

const render = (operation_type: string, preview_data: Record<string, unknown>, detail = false) =>
  renderToStaticMarkup(createElement(OperationPreview, { op: { operation_type, preview_data }, detail }))

/** A skattekonto event as the executor books it: one verifikat per row. */
function skattekontoEntry(date: string, text: string, amount: number, counter: string) {
  return {
    entry_date: date,
    description: `Skattekonto: ${text}`,
    lines: [
      { account_number: '1630', debit_amount: amount, credit_amount: 0, line_description: text },
      { account_number: counter, debit_amount: 0, credit_amount: amount, line_description: text },
    ],
    total_debit: amount,
    total_credit: amount,
    balanced: true,
    note: 'Lines as the entry generator builds them.',
  }
}

const SKATTEKONTO_BATCH = {
  row_count: 4,
  total_amount: 192264,
  skattekonto_account: '1630',
  rows: [{ skattekonto_transaction_id: 'skv-1', amount: 192264 }],
  journal_entries: [
    skattekontoEntry('2026-09-12', 'Inbetalning bokförd 260912', 150000, '1930'),
    skattekontoEntry('2026-09-12', 'Intäktsränta', 12, '8314'),
    skattekontoEntry('2026-09-19', 'Inbetalning bokförd 260919', 40000, '1930'),
    skattekontoEntry('2026-09-30', 'Intäktsränta', 2252, '8314'),
  ],
}

describe('the approval card of a skattekonto booking (crm#1104)', () => {
  it('shows each verifikat the approval posts: date, text, accounts, debit and credit in kronor', () => {
    const html = render('book_skattekonto_rows', SKATTEKONTO_BATCH, true)

    expect(html).toContain('Verifikat som bokförs: 4')
    expect(html).toContain('2026-09-19')
    expect(html).toContain('Skattekonto: Inbetalning bokförd 260919')
    for (const account of ['1630', '1930', '8314']) expect(html).toContain(account)
    for (const amount of [150000, 12, 40000, 2252]) expect(html).toContain(formatCurrency(amount, 'SEK'))
    expect(html).toContain('Totalt belopp')
    expect(html).toContain(formatCurrency(192264, 'SEK'))
  })

  it('never shows a staging field name or an unformatted amount', () => {
    const html = render('book_skattekonto_rows', SKATTEKONTO_BATCH, true)
    for (const raw of ['skattekonto account', 'skattekonto_account', 'row count', 'total amount', '4 rader', '192264']) {
      expect(html).not.toContain(raw)
    }
  })

  it('stops after three verifikat outside the review panel, and says how many more', () => {
    const html = render('book_skattekonto_rows', SKATTEKONTO_BATCH)
    expect(html).toContain('Skattekonto: Inbetalning bokförd 260919')
    expect(html).not.toContain('2026-09-30')
    expect(html).toContain('och 1 till')
  })

  it('shows the one verifikat of a single-row booking', () => {
    const html = render('book_skattekonto_row', {
      transaction_date: '2026-09-30',
      amount: -2252,
      journal_entry: skattekontoEntry('2026-09-30', 'Kostnadsränta', 2252, '8423'),
    })
    expect(html).toContain('Skattekonto: Kostnadsränta')
    expect(html).toContain('8423')
    expect(html).toContain(formatCurrency(-2252, 'SEK'))
  })
})

describe('the generic approval card', () => {
  it('states labelled fields with their label, money as money, yes/no in words', () => {
    const html = render('mark_invoice_sent', {
      customer_name: 'Kunden AB',
      total: 1234.5,
      currency: 'EUR',
      will_be_ignored: true,
      some_new_field: 'internal',
      nested: { a: 1 },
    })
    expect(html).toContain('Kund')
    expect(html).toContain('Kunden AB')
    expect(html).toContain('Totalt')
    expect(html).toContain(formatCurrency(1234.5, 'EUR'))
    expect(html).toContain('Ignoreras')
    expect(html).toContain('Ja')
    expect(html).not.toContain('some new field')
    expect(html).not.toContain('internal')
    expect(html).not.toContain('&quot;a&quot;')
  })

  it('shows the changes of an update field by field, not as JSON', () => {
    const html = render('update_customer', {
      current: { name: 'Kunden AB', email: 'old@example.se' },
      changes: { email: 'new@example.se', internal_flag: true },
    })
    expect(html).toContain('Ändringar')
    expect(html).toContain('E-post')
    expect(html).toContain('new@example.se')
    expect(html).not.toContain('internal_flag')
    expect(html).not.toContain('&quot;email&quot;')
  })

  it('shows the lines of a payment preview without empty date and text rows', () => {
    const html = render('mark_invoice_paid', {
      journal_entry_preview: {
        lines: [
          { account_number: '1930', debit_amount: 1250, credit_amount: 0, line_description: 'Inbetalning' },
          { account_number: '1510', debit_amount: 0, credit_amount: 1250, line_description: 'Kundfordran' },
        ],
        total_debit: 1250,
        total_credit: 1250,
      },
    })
    expect(html).toContain('1510')
    expect(html).toContain(formatCurrency(1250, 'SEK'))
    expect(html).not.toContain('Datum')
  })

  it('says there is no detailed preview rather than showing an empty box', () => {
    const html = render('some_operation', { some_new_field: 'internal', id: '44444444-4444-4444-8444-444444444444' })
    expect(html).toContain('Förslaget har ingen detaljerad förhandsvisning')
  })
})

/**
 * Reported (crm#1300): an agent's change to a customer or an article showed
 * only the new value, so the approver opened the kundkort or artikelkort to
 * see what it replaced. Each changed field states what it held, struck, then
 * what it becomes, whichever way the staging tool said the old value.
 */
describe('the approval card of an update (crm#1300)', () => {
  const struck = (before: string, after: string) =>
    `<del class="text-muted-foreground">${before}</del> → <ins class="no-underline">${after}</ins>`

  it('shows an article price change against the stored price, in the article’s currency', () => {
    const html = render('update_article', {
      article_id: '44444444-4444-4444-8444-444444444444',
      name: 'Takarbete',
      article_number: '920',
      current: { name: 'Takarbete', price_excl_vat: 1180, currency: 'EUR', vat_rate: 25 },
      changes: { price_excl_vat: 1220 },
    })
    expect(html).toContain('Artikelnummer')
    expect(html).toContain('Ändringar')
    expect(html).toContain('Pris exkl. moms')
    expect(html).toContain(struck(formatCurrency(1180, 'EUR'), formatCurrency(1220, 'EUR')))
    // The stored fields the update leaves alone are not listed as changes.
    expect(html).not.toContain('Momssats')
  })

  it('reads a customer’s old values from the stored record beside the changes', () => {
    const html = render('update_customer', {
      current: { name: 'Kunden AB', email: 'old@example.se', customer_type: 'swedish_business', contact_person: 'Anna' },
      changes: { email: 'new@example.se', customer_type: 'eu_business', contact_person: null },
      proposed: { name: 'Kunden AB', email: 'new@example.se', customer_type: 'eu_business', contact_person: null },
    })
    expect(html).toContain(struck('old@example.se', 'new@example.se'))
    // A code reads as its word, and a cleared field shows as cleared.
    expect(html).toContain(struck('Svenskt företag eller organisation', 'EU-företag'))
    expect(html).toContain('Kontaktperson')
    expect(html).toContain(struck('Anna', '-'))
  })

  it('reads a supplier’s { from, to } pairs, which used to show nothing', () => {
    const html = render('update_supplier', {
      name: 'Leverantören AB',
      email: 'ny@leverantor.se',
      changes: { email: { from: 'gammal@leverantor.se', to: 'ny@leverantor.se' } },
    })
    expect(html).toContain(struck('gammal@leverantor.se', 'ny@leverantor.se'))
    expect(html).not.toContain('&quot;from&quot;')
  })

  it('reads a settings change’s old values from previous', () => {
    const html = render('update_company_settings', {
      changes: { iban: 'SE4550000000058398257466' },
      previous: { iban: 'SE3550000000054910000003' },
    })
    expect(html).toContain(struck('SE3550000000054910000003', 'SE4550000000058398257466'))
  })

  it('shows the new value alone when the update was staged without the old one', () => {
    const html = render('update_cash_account', { changes: { name: 'Företagskonto' } })
    expect(html).toContain('Företagskonto')
    expect(html).not.toContain('<del')
  })
})

describe('preview field formatting', () => {
  it('reads money from the field name', () => {
    for (const key of ['amount', 'total', 'total_amount', 'vat_amount', 'invoice_remaining', 'remaining_after', 'price_excl_vat', 'monthly_salary', 'reminder_fee_amount']) {
      expect(isMoneyField(key)).toBe(true)
    }
    for (const key of ['row_count', 'pair_count', 'vat_rate', 'exchange_rate', 'default_payment_terms', 'account_class', 'file_size_bytes']) {
      expect(isMoneyField(key)).toBe(false)
    }
  })

  it('takes the field’s own currency, then the preview’s, then SEK when none is named', () => {
    expect(currencyForField('transaction_amount', { transaction_currency: 'EUR', currency: 'USD' })).toBe('EUR')
    expect(currencyForField('total', { currency: 'NOK' })).toBe('NOK')
    expect(currencyForField('total_amount', {})).toBe('SEK')
    // Another field's currency only: which applies is unknown, so no unit.
    expect(currencyForField('payment_amount', { invoice_currency: 'EUR' })).toBeNull()
    expect(formatPreviewNumber('payment_amount', 1234.5, { invoice_currency: 'EUR' })).toBe('1 234,50')
  })

  it('writes a count as a plain number', () => {
    expect(formatPreviewNumber('row_count', 4, {})).toBe('4')
    expect(formatPreviewNumber('total_amount', 192264, {})).toBe(formatCurrency(192264, 'SEK'))
  })
})
