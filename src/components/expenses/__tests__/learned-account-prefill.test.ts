/**
 * PH 101: "jag måste ... välja konto" on every receipt. The utlägg dialog now
 * opens with what the company booked the merchant on before. The rule is
 * tested in lib/expenses/__tests__/learned-account.test.ts; components are not
 * rendered in this suite (vitest runs in `node`), so the wiring is pinned on
 * the source: the hook reads the same counterparty lookup and rule as
 * "Privat, med mina egna pengar" plus the company's claims, and the dialog
 * writes the proposal only into an empty field nobody picked.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const hook = read('../use-learned-expense-account.ts')
const dialog = read('../../extensions/general/RegisterExpenseDialog.tsx')

describe('the learned cost account in the utlägg dialog', () => {
  it("reads the counterparty template through the owner-paid lookup and rule, and the company's claims", () => {
    expect(hook).toContain('/api/settings/counterparty-templates?counterparty=')
    expect(hook).toContain('templateCostAccount(')
    expect(hook).toContain("readJson('/api/expense-claims')")
    expect(hook).toContain('learnedExpenseAccount(')
  })

  it('fills only an empty field a person has not picked, with an account the dialog can book, and a pick or clear stays theirs', () => {
    expect(dialog).toContain('useLearnedExpenseAccount(open ? merchant : null, chart)')
    expect(dialog).toMatch(/if \(!open \|\| !learnedAccount \|\| !isCostAccount\(learnedAccount\) \|\| accountPicked\.current \|\| expenseAccount\) return/)
    expect(dialog).toMatch(/accountPicked\.current = true\s+setExpenseAccount\(account\)/)
    expect(dialog).toMatch(/setExpenseAccount\(''\)\s+accountPicked\.current = false/)
  })

  it('says where the proposal came from while the field holds it', () => {
    expect(dialog).toContain("t('expense_account_learned', { merchant })")
  })
})
