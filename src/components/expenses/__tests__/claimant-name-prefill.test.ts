/**
 * PH 101: "jag måste skriva in mitt namn hela tiden". "Jag, privat" opened
 * with an empty name on every receipt, so people retyped it, and a receipt
 * left empty became "Ägare" beside the typed name: one owner, two people
 * to pay. The owner field now opens with the name the company's last owner
 * claim used. The rule is tested in lib/expenses/__tests__/payer.test.ts;
 * components are not rendered in this suite (vitest runs in `node`), so the
 * wiring is pinned on the source: the shared field reads the claims and the
 * rule, and both doors that register an utlägg render that field.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const fields = read('../ExpenseClaimantFields.tsx')

describe('the owner name under "Jag, privat"', () => {
  it('opens with the last owner name the company typed, read from its claims', () => {
    expect(fields).toContain("fetch('/api/expense-claims'")
    expect(fields).toContain('lastOwnerClaimantName(')
  })

  it('fills only an empty field, once per mount, so a person typing first keeps what they typed', () => {
    expect(fields).toMatch(/if \(prefilled\.current \|\| remembered === undefined\) return/)
    expect(fields).toMatch(/if \(remembered && !\(ownerName \?\? ''\)\.trim\(\)\) onOwnerNameChange\(remembered\)/)
  })

  it('is the field both utlägg doors render: the inbox dialog and the supplier-invoice form', () => {
    for (const host of ['../../extensions/general/RegisterExpenseDialog.tsx', '../../supplier-invoices/NewSupplierInvoiceForm.tsx']) {
      const source = read(host)
      expect(source).toContain('<ExpenseClaimantFields')
      expect(source).toMatch(/onOwnerNameChange=\{/)
    }
  })
})
