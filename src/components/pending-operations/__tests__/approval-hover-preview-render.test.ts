/**
 * The card a row's Godkänn shows before the click, as a person reads it,
 * rendered under both catalogues: what the click does, what the proposal
 * concerns, and the verifikat it posts with account names, debit, credit and
 * a Summa that balances. A missing key or a broken ICU argument fails here.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import { ApprovalPreviewCard, type BuiltRows } from '../ApprovalHoverPreview'
import { AccountNamesContext } from '../OperationPreview'

const NAMES = {
  '6110': 'Kontorsmateriel',
  '2641': 'Debiterad ingående moms',
  '1930': 'Företagskonto',
  '6212': 'Mobiltelefon',
  '2440': 'Leverantörsskulder',
}

type Op = Parameters<typeof ApprovalPreviewCard>[0]['op']

const render = (op: Op, locale: 'sv' | 'en', lockedReason?: string, built?: BuiltRows) =>
  renderInLocale(
    createElement(AccountNamesContext.Provider, { value: NAMES }, createElement(ApprovalPreviewCard, { op, lockedReason, built })),
    locale,
  )

/** The card as one line of text: its text nodes joined, spaces normalised. */
const read = (op: Op, locale: 'sv' | 'en', lockedReason?: string, built?: BuiltRows) =>
  visibleText(render(op, locale, lockedReason, built)).join(' ')

const categorised: Op = {
  operation_type: 'categorize_transaction',
  title: 'Kategorisera: Kontorsvaruhuset -245 SEK',
  params: { transaction_id: '44444444-4444-4444-8444-444444444444', category: 'expense_office' },
  preview_data: {
    debit_account: '6110',
    credit_account: '1930',
    amount: 245,
    currency: 'SEK',
    date: '2026-11-18',
    lines: [
      { account_number: '6110', debit_amount: 196, credit_amount: 0, description: 'Kontorsvaruhuset' },
      { account_number: '2641', debit_amount: 49, credit_amount: 0, description: 'Kontorsvaruhuset' },
      { account_number: '1930', debit_amount: 0, credit_amount: 245, description: 'Kontorsvaruhuset' },
    ],
  },
}

const supplierInvoice: Op = {
  operation_type: 'create_supplier_invoice_from_inbox',
  title: 'Leverantörsfaktura: 4411 (Simulerad Telekom AB)',
  params: {},
  preview_data: {
    supplier_name: 'Simulerad Telekom AB',
    supplier_invoice_number: '4411',
    invoice_date: '2026-11-04',
    due_date: '2026-12-04',
    subtotal: 3528.8,
    vat_amount: 882.2,
    total: 4411,
    currency: 'SEK',
  },
}

describe('the card beside Godkänn', () => {
  it('a categorised bank row: what the click does, the date, and the rows with names, debit, credit and a Summa that balances', () => {
    expect(read(categorised, 'sv')).toBe(
      'Genom att klicka godkänn så kategoriseras transaktionen och en verifikation skapas. Datum 2026-11-18 Det här bokförs ' +
        'Konto Beskrivning Debet Kredit 6110 Kontorsmateriel 196 kr 2641 Debiterad ingående moms 49 kr 1930 Företagskonto 245 kr ' +
        'Summa 245 kr 245 kr',
    )
    expect(read(categorised, 'en')).toBe(
      'By clicking approve, the transaction is categorised and a voucher is created. Datum 2026-11-18 This will be posted ' +
        'Account Description Debit Credit 6110 Kontorsmateriel 196 kr 2641 Debiterad ingående moms 49 kr 1930 Företagskonto 245 kr ' +
        'Total 245 kr 245 kr',
    )
  })

  it('a supplier invoice from the inbox, before the server answers: the supplier, the number and the total, then its rows being asked for', () => {
    const html = render(supplierInvoice, 'sv')
    const sv = visibleText(html).join(' ')
    expect(sv).toContain('Simulerad Telekom AB')
    expect(sv).toContain('4411')
    expect(sv).toMatch(/Totalt 4 411 kr Det här bokförs$/)
    expect(html).toContain('aria-busy="true"')
    expect(read(supplierInvoice, 'en')).toMatch(/Total 4 411 kr This will be posted$/)
  })

  it('a supplier invoice from the inbox, answered: the rows its approval posts, with names, debit, credit and a Summa', () => {
    const built: BuiltRows = {
      state: 'answered',
      answer: {
        posts: 'verifikat',
        verifikat: [
          {
            entry_date: '2026-11-04',
            lines: [
              { account_number: '6212', debit_amount: 3528.8, credit_amount: 0 },
              { account_number: '2641', debit_amount: 882.2, credit_amount: 0 },
              { account_number: '2440', debit_amount: 0, credit_amount: 4411 },
            ],
            total_debit: 4411,
            total_credit: 4411,
          },
        ],
      },
    }
    expect(read(supplierInvoice, 'sv', undefined, built)).toMatch(
      /Totalt 4 411 kr Det här bokförs Konto Beskrivning Debet Kredit 6212 Mobiltelefon 3 528,80 kr 2641 Debiterad ingående moms 882,20 kr 2440 Leverantörsskulder 4 411 kr Summa 4 411 kr 4 411 kr$/,
    )
    expect(read(supplierInvoice, 'en', undefined, built)).toMatch(/This will be posted .* Total 4 411 kr 4 411 kr$/)
  })

  it('a supplier invoice from the inbox, past the room: the rest of its rows are counted, and the review is not offered for them', () => {
    const lines = [
      ...Array.from({ length: 9 }, () => ({ account_number: '6110', debit_amount: 100, credit_amount: 0 })),
      { account_number: '2440', debit_amount: 0, credit_amount: 900 },
    ]
    const built: BuiltRows = {
      state: 'answered',
      answer: { posts: 'verifikat', verifikat: [{ entry_date: '2026-11-04', lines, total_debit: 900, total_credit: 900 }] },
    }
    const sv = read(supplierInvoice, 'sv', undefined, built)
    expect(sv).toMatch(/\+ 2 rader till Summa 900 kr 900 kr$/)
    expect(sv).not.toContain('Öppna förslaget')
  })

  it('a supplier invoice from the inbox that books nothing now, one the approval refuses, and an answer that never came', () => {
    const nothing: BuiltRows = { state: 'answered', answer: { posts: 'nothing' } }
    expect(read(supplierInvoice, 'sv', undefined, nothing)).toMatch(/Totalt 4 411 kr Inget verifikat bokförs nu: fakturan bokförs senare\.$/)
    expect(read(supplierInvoice, 'en', undefined, nothing)).toMatch(/No voucher is posted now: the invoice is booked later\.$/)

    const refused: BuiltRows = {
      state: 'answered',
      answer: { posts: 'refused', code: 'SI_CREATE_NO_FISCAL_PERIOD', message_sv: 'Inget räkenskapsår täcker datumet.', message_en: 'No fiscal year covers the date.' },
    }
    expect(read(supplierInvoice, 'sv', undefined, refused)).toMatch(/Totalt 4 411 kr Inget räkenskapsår täcker datumet\.$/)
    expect(read(supplierInvoice, 'en', undefined, refused)).toMatch(/No fiscal year covers the date\.$/)
    expect(read(supplierInvoice, 'sv', undefined, refused)).not.toContain('Det här bokförs')
    // A locked button's reason stays the one attention line; the refusal follows it as text.
    expect(read(supplierInvoice, 'sv', 'Perioden är låst', refused)).toMatch(/^Perioden är låst .* Inget räkenskapsår täcker datumet\.$/)

    expect(read(supplierInvoice, 'sv', undefined, { state: 'failed' })).toMatch(/Verifikatets rader kunde inte hämtas\.$/)
    expect(read(supplierInvoice, 'en', undefined, { state: 'failed' })).toMatch(/The voucher's lines could not be loaded\.$/)

    const atApproval: BuiltRows = { state: 'answered', answer: { posts: 'at_approval' } }
    expect(read(supplierInvoice, 'sv', undefined, atApproval)).toMatch(
      /Totalt 4 411 kr Raderna räknas fram vid godkännandet, när växelkursen hämtas från Riksbanken\.$/,
    )
    expect(read(supplierInvoice, 'en', undefined, atApproval)).toMatch(/The rows are worked out on approval, when the exchange rate is fetched from Riksbanken\.$/)
  })

  it('a registration of an already-booked supplier invoice asks for no rows: it posts none', () => {
    const registerBooked: Op = { ...supplierInvoice, params: { mode: 'register_booked' } }
    const sv = read(registerBooked, 'sv')
    expect(sv).not.toContain('Det här bokförs')
    expect(render(registerBooked, 'sv')).not.toContain('aria-busy')
  })

  it('a proposal that books nothing: what the click does and what it concerns, no verifikat', () => {
    const customer: Op = {
      operation_type: 'create_customer',
      title: 'Ny kund: Provkund Äng AB',
      params: {},
      preview_data: { name: 'Provkund Äng AB', customer_type: 'swedish_business' },
    }
    const sv = read(customer, 'sv')
    expect(sv).toMatch(/^Genom att klicka godkänn så skapar du en kund\. Namn Provkund Äng AB Typ /)
    expect(sv).not.toContain('Det här bokförs')
    expect(read(customer, 'en')).toMatch(/^By clicking approve, you create a customer\. /)
  })

  it('more than eight rows: eight are listed, the rest are counted, and the Summa adds up every row', () => {
    const lines = [
      ...Array.from({ length: 13 }, () => ({ account_number: '6110', debit_amount: 100, credit_amount: 0 })),
      { account_number: '1930', debit_amount: 0, credit_amount: 1300 },
    ]
    const batch: Op = { operation_type: 'bulk_book_transactions', title: 'Samlingsverifikat', params: {}, preview_data: { lines } }
    const sv = read(batch, 'sv')
    expect(sv.match(/6110 Kontorsmateriel/g)).toHaveLength(8)
    expect(sv).toContain('+ 6 rader till Summa 1 300 kr 1 300 kr Öppna förslaget för alla rader.')
    expect(read(batch, 'en')).toContain('+ 6 more rows Total 1 300 kr 1 300 kr Open the proposal for every row.')
  })

  it('a rättelse: the rows of the correction it posts, not the verifikat it replaces', () => {
    const correction: Op = {
      operation_type: 'correct_entry',
      title: 'Rättelse: V12 - Kontorsvaruhuset',
      params: {},
      preview_data: {
        original: { lines: [{ account_number: '2641', debit_amount: 999, credit_amount: 0 }, { account_number: '1930', debit_amount: 0, credit_amount: 999 }] },
        correction: { lines: [{ account_number: '6110', debit_amount: 245, credit_amount: 0 }, { account_number: '1930', debit_amount: 0, credit_amount: 245 }] },
      },
    }
    const sv = read(correction, 'sv')
    expect(sv).toContain('6110 Kontorsmateriel 245 kr')
    expect(sv).not.toContain('999')
  })

  it('a payment matched to an invoice whose sale is booked first: both verifikat, each with its own Summa', () => {
    const match: Op = {
      operation_type: 'match_transaction_invoice',
      title: 'Matcha: Inbetalning Fjällgård → 186',
      params: {},
      preview_data: {
        invoice_number: '186',
        customer_name: 'Fjällgård Data AB',
        invoice_total: 7000,
        transaction_amount: 7000,
        expected_lines: [
          { account_number: '1930', description: 'Inbetalning', debit: 7000, credit: 0 },
          { account_number: '1510', description: 'Kundfordran', debit: 0, credit: 7000 },
        ],
        sale_entry: {
          lines: [
            { account_number: '1510', debit_amount: 7000, credit_amount: 0 },
            { account_number: '3001', debit_amount: 0, credit_amount: 5600 },
            { account_number: '2611', debit_amount: 0, credit_amount: 1400 },
          ],
        },
      },
    }
    const sv = read(match, 'sv')
    expect(sv).toContain('Genom att klicka godkänn så matchas transaktionen mot fakturan.')
    // The sale (3001) before the payment that clears it (1930).
    expect(sv.indexOf('3001')).toBeGreaterThan(-1)
    expect(sv.indexOf('3001')).toBeLessThan(sv.indexOf('1930'))
    expect(sv.match(/Summa 7 000 kr 7 000 kr/g)).toHaveLength(2)
  })

  it('more verifikat than the room: whole ones are counted', () => {
    const entry = (amount: number) => ({
      lines: [
        { account_number: '2510', debit_amount: amount, credit_amount: 0 },
        { account_number: '1630', debit_amount: 0, credit_amount: amount },
      ],
    })
    const rows: Op = {
      operation_type: 'book_skattekonto_rows',
      title: 'Bokför skattekontot',
      params: {},
      preview_data: { journal_entries: [1, 2, 3, 4, 5, 6].map((n) => entry(n * 100)) },
    }
    expect(read(rows, 'sv')).toMatch(/\+ 2 verifikat till Öppna förslaget för alla rader\.$/)
    expect(read(rows, 'en')).toMatch(/\+ 2 more vouchers Open the proposal for every row\.$/)
  })

  it('a locked button: its reason is the first line', () => {
    expect(read(categorised, 'sv', 'Perioden är låst')).toMatch(/^Perioden är låst Genom att klicka godkänn/)
  })

  it('masks nothing itself: the hover wrapper masks the whole card', () => {
    // The card is rendered inside TooltipContent with data-ph-mask; on its own it adds no unmask.
    expect(render(categorised, 'sv')).not.toContain('data-ph-unmask')
  })

  it('renders nothing for a proposal that states nothing to show', () => {
    // A new supplier has no sentence of its own and no typed fields in the card; this one states no fields either.
    const bare: Op = { operation_type: 'create_supplier', title: 'Ny leverantör', params: {}, preview_data: {} }
    expect(render(bare, 'sv')).toBe('')
  })
})
