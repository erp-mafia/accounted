import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { lineTextAddsSomething, voucherLinesTotals } from '../VoucherLinesTable'

describe('voucherLinesTotals', () => {
  it('sums every line that is not struck, to the öre, whatever the amount type', () => {
    // The verifikat list summed the raw lines and the approval card took the
    // staged totals; one rule now: the lines shown, minus rättelse-struck ones.
    expect(
      voucherLinesTotals([
        { account_number: '5410', debit_amount: '100.10', credit_amount: 0 },
        { account_number: '2641', debit_amount: 25.025, credit_amount: null },
        { account_number: '1930', debit_amount: 0, credit_amount: 125.13 },
        { account_number: '5410', debit_amount: 999, credit_amount: 0, struck: true },
      ]),
    ).toEqual({ debit: 125.13, credit: 125.13 })
  })
})

describe('lineTextAddsSomething', () => {
  it('hides a text that only repeats the account name or the verifikat text', () => {
    expect(lineTextAddsSomething('Företagskonto', 'Företagskonto')).toBe(false)
    expect(lineTextAddsSomething(' telia mars ', 'Telefon', ['Telia mars'])).toBe(false)
    expect(lineTextAddsSomething('', 'Telefon')).toBe(false)
  })

  it('shows a text that adds something', () => {
    expect(lineTextAddsSomething('Telia mars', 'Telefon', ['Mars'])).toBe(true)
    expect(lineTextAddsSomething('Telia mars', null)).toBe(true)
  })
})

/*
 * The read-only konteringar of the review steps and previews render through
 * the one table: a hand-built Konto/Debet/Kredit table, or a second phone copy
 * of one, in these files is the drift coming back.
 */
describe('surfaces on the shared voucher lines table', () => {
  const root = path.resolve(__dirname, '../../../')
  it.each([
    'components/bookkeeping/JournalEntryReviewContent.tsx',
    'components/suppliers/SupplierInvoiceReviewContent.tsx',
    'components/transactions/JournalEntryPreview.tsx',
    'components/bookkeeping/year-end/PreviewStep.tsx',
    'app/(dashboard)/bookkeeping/[id]/page.tsx',
  ])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(src).toContain('<VoucherLinesTable')
    expect(src).not.toMatch(/sm:hidden space-y-1\.5/)
    expect(src).not.toMatch(/divide-y divide-border text-sm sm:hidden/)
  })

  it('the verifikat page keeps Swedish heads in both locales', () => {
    const src = fs.readFileSync(path.join(root, 'app/(dashboard)/bookkeeping/[id]/page.tsx'), 'utf8')
    expect(src).toMatch(/<VoucherLinesTable[\s\S]*?\bswedish\b/)
  })

  it('the year-end preview keeps Swedish heads in both locales', () => {
    const src = fs.readFileSync(path.join(root, 'components/bookkeeping/year-end/PreviewStep.tsx'), 'utf8')
    expect(src).toMatch(/<VoucherLinesTable[\s\S]*?\bswedish\b/)
  })
})
