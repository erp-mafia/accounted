/**
 * Ratchet: no new `|| 'accrual'` / `?? 'accrual'` (accounted#58).
 *
 * A missing or failed read of company_settings.accounting_method used to be
 * replaced by faktureringsmetoden on ~20 booking paths, so a kontantmetod
 * invoice's payment booked as a 1510 clearing with no revenue and no moms.
 * Booking paths now read the method through requireAccountingMethod /
 * checkAccountingMethod (lib/company/accounting-method.ts), which refuse.
 *
 * The sites left below are not reads of the setting on a booking path: pure
 * helpers handed an already validated value, display and form defaults in the
 * UI, rows whose read was already checked (the column is NOT NULL, so the
 * fallback is unreachable there), and the settings-change guard. A file may
 * go below its ceiling, never above it, and no other file may gain one: a new
 * booking path takes requireAccountingMethod instead.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../../..')

const ACCRUAL_DEFAULT = /(?:\|\||\?\?)\s*['"]accrual['"]/g

const CEILINGS: Record<string, number> = {
  // Pure helpers: the caller hands in a value it already validated.
  'lib/bookkeeping/booking-mode.ts': 4,
  'lib/invoices/apply-supplier-payment.ts': 1,
  'lib/invoices/invoice-settlement-side.ts': 1,
  'lib/bookkeeping/currency-revaluation.ts': 1,
  // The settings row was read with its error checked before the fallback.
  'lib/invoices/book-service.ts': 2,
  'lib/invoices/credit-invoice.ts': 2,
  'lib/invoices/issue-and-book-invoice.ts': 1,
  'lib/supplier-invoices/book-service.ts': 1,
  'app/api/invoices/[id]/send/route.ts': 1,
  'app/api/v1/companies/[companyId]/invoices/[id]/mark-sent/route.ts': 1,
  'app/api/v1/companies/[companyId]/invoices/[id]/send/route.ts': 1,
  // Reports and UI: describe, never book (the server decides again).
  'lib/bokslut/readiness-aggregator.ts': 1,
  'app/(dashboard)/invoices/page.tsx': 1,
  'components/invoices/SendInvoiceDialog.tsx': 1,
  // The settings form and the mid-year change guard.
  'components/settings/sections/BookkeepingSettingsContent.tsx': 5,
  'lib/operations/company-settings.ts': 1,
  'lib/company/accounting-method-change.ts': 1,
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

function accrualDefaults(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of sourceFiles(SRC)) {
    const n = readFileSync(file, 'utf8').match(ACCRUAL_DEFAULT)?.length ?? 0
    if (n > 0) counts.set(relative(SRC, file).split(sep).join('/'), n)
  }
  return counts
}

describe('accounting method: no new accrual default', () => {
  it('no file defaults the accounting method to accrual beyond its ceiling', () => {
    const over = [...accrualDefaults()]
      .filter(([file, n]) => n > (CEILINGS[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} (ceiling ${CEILINGS[file] ?? 0})`)
    expect(
      over,
      'Read the method with requireAccountingMethod / checkAccountingMethod (lib/company/accounting-method.ts) instead of defaulting it',
    ).toEqual([])
  })

  it('the scan sees the known sites (guards against a broken matcher)', () => {
    expect(accrualDefaults().get('lib/bookkeeping/booking-mode.ts')).toBeGreaterThan(0)
  })
})
