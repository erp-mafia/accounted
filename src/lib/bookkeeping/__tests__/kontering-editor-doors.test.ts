import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/*
 * The booking dialogs render their konteringsrader through one editor, once.
 * A second account picker in one of them is the phone-card-plus-desktop-table
 * copy coming back (two pickers per row, two DOM trees to keep in step).
 */
const root = path.resolve(__dirname, '../../../')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('editors on the shared kontering editor', () => {
  it.each([
    'components/invoices/SendInvoiceDialog.tsx',
    'components/invoices/PaymentBookingDialog.tsx',
    'components/bookkeeping/CorrectionEntryDialog.tsx',
    'components/bookkeeping/StrikeLinesDialog.tsx',
    'components/bookkeeping/JournalEntryForm.tsx',
  ])('%s', (rel) => {
    const src = read(rel)
    expect(src).toContain('<KonteringLinesEditor')
    expect(src).not.toContain('<AccountCombobox')
  })
})

describe('KonteringLinesEditor', () => {
  const src = read('components/bookkeeping/KonteringLinesEditor.tsx')

  it('renders one account picker per row, not one per layout', () => {
    expect(src.match(/<AccountCombobox/g)).toHaveLength(1)
    expect(src).not.toMatch(/\bsm:hidden space-y-3\b/)
  })

  it('keeps the tab order account, description, debit, credit, remove on every width', () => {
    // The phone layout moves the remove button beside the account with grid
    // placement only; the DOM order is the tab order.
    const account = src.indexOf('<AccountCombobox')
    const description = src.indexOf('onDescriptionChange(index')
    const amounts = src.indexOf("amountInput(index, 'debit_amount'")
    const credit = src.indexOf("amountInput(index, 'credit_amount'")
    const remove = src.indexOf('onClick={() => onRemove(index)}')
    expect(account).toBeGreaterThan(0)
    expect(account).toBeLessThan(description)
    expect(description).toBeLessThan(amounts)
    expect(amounts).toBeLessThan(credit)
    expect(credit).toBeLessThan(remove)
  })
})
