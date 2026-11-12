/**
 * The guards of the AGI due day, the moms a period pays and the balance of an
 * account catch the shapes that were written by hand, and leave the lines
 * that only look alike.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import dueDay from '../one-definition/agi-payment-due-day.mjs'
import netAsFiled from '../one-definition/vat-net-as-filed.mjs'
import balance from '../one-definition/account-balance-from-opening-balance.mjs'

const hits = (rule: Parameters<typeof findRuleLines>[1], line: string) => findRuleLines(line, rule).length > 0

describe.each([
  ['agi-payment-due-day', dueDay, [
    "return `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-12`",
    "const due = `${year}-${String(month).padStart(2, '0')}-26`",
    'const day = month === 0 || month === 7 ? 17 : 12',
    'day: deadlineMonth === 0 ? 17 : 12,',
  ], [
    "return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`",
    "const period = `${year}-${String(month).padStart(2, '0')}`",
    "const first = `${year}-${String(month).padStart(2, '0')}-01`",
    'const paymentDate = getAgiPaymentDueDate(periodYear, periodMonth, settings)',
    'const columns = wide ? 17 : 12',
  ]],
  ['vat-net-as-filed', netAsFiled, [
    'const ruta49 = Number(r.ruta49 || 0)',
    "const summaryLabel = report.rutor.ruta49 > 0 ? 'Moms att betala' : 'Moms att få tillbaka'",
    'value: declaration.rutor.ruta49,',
    'const { ruta48, ruta49 } = rutor',
    'net_due: rutor?.ruta49 ?? 0,',
  ], [
    'const net = buildFiledAmounts(rutor).net',
    'const netFiled = Number(report.net_filed || 0)',
    "ruta49: 'summaMoms',",
    "if (key !== 'ruta49' && amounts[key] !== 0) {",
    'ruta49: 0,',
    'const { ruta48, ruta50 } = rutor',
  ]],
  ['account-balance-from-opening-balance', balance, [
    "const balance = await sumAccountBalance(supabase, companyId, '2893', { cutoffDate: day })",
    "const LEDGER_BALANCE_STATUSES = ['posted', 'reversed'] as const",
    "filterEntries: (q) => q.eq('company_id', companyId).in('status', [...LEDGER_BALANCE_STATUSES]).lte('entry_date', day),",
    ".in('journal_entries.status', [...LEDGER_BALANCE_STATUSES])",
  ], [
    "const balance = await accountBalanceThrough(supabase, companyId, '2893', day)",
    'const balances = await bookedBalancesAt(supabase, companyId, period.id, date)',
    "import { LEDGER_BALANCE_STATUSES } from '@/lib/reconciliation/gl-balance'",
    ".in('status', ['draft', 'posted'])",
    'const floor = await findOpeningBalanceFloor(supabase, companyId, account, cutoffDate)',
  ]],
] as const)('%s', (_name, rule, written, alike) => {
  it.each(written)('catches %s', (line) => {
    expect(hits(rule, line)).toBe(true)
  })

  it.each(alike)('leaves %s', (line) => {
    expect(hits(rule, line)).toBe(false)
  })
})
