/**
 * An invoice's delivery_country decides its revenue account (#2906): under an
 * export / reverse_charge header it books the goods accounts 3105 / 3108
 * (rutor 36 / 35) instead of the services ones 3305 / 3308 (rutor 40 / 39).
 * The generators read it off the row they are handed, so a door that selects
 * an explicit invoice column list without it books a goods export as a
 * service: silently, because the verifikat still balances and both boxes are
 * 0 %. The same class of bug as `country` in #2783.
 *
 * Doors that select '*' or the shared INVOICE_FULL_COLUMNS are covered by
 * construction. This pins the rest at source level: every hand-written
 * invoice header projection (a column list naming vat_treatment and
 * invoice_date) carries delivery_country too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../..')

/**
 * Projections that read an invoice header but never feed a booking, with the
 * reason. Keep this short: a new entry needs the same justification.
 */
const NOT_BOOKING: Record<string, string> = {
  // Completes invoice_items for invoices imported by the Arcim migration;
  // those rows are bookkept in the source system and never state a delivery.
  'extensions/general/arcim-migration/lib/complete-invoice-lines.ts': 'import completion, no booking',
}

const COLUMN_LIST = /^\s*[\w:!.*()]+(\s*,\s*[\w:!.*()]+)+\s*$/

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, found)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

describe('invoice header projections carry delivery_country (#2906)', () => {
  const projections = sourceFiles(SRC).flatMap((file) => {
    const relative = path.relative(SRC, file)
    const source = fs.readFileSync(file, 'utf8')
    return Array.from(source.matchAll(/'([^'\n]*)'/g))
      .map((match) => match[1])
      .filter(
        (literal) =>
          COLUMN_LIST.test(literal) &&
          /\bvat_treatment\b/.test(literal) &&
          /\binvoice_date\b/.test(literal) &&
          !/\bsupplier/.test(literal),
      )
      .map((literal) => ({ relative, literal }))
  })

  it('finds the hand-written projections it guards', () => {
    // mark-sent, mark-paid, credit (x2), INVOICE_FULL_COLUMNS, kontantmetod cut-off.
    expect(projections.length).toBeGreaterThanOrEqual(6)
  })

  it('every one selects delivery_country, or is a documented non-booking read', () => {
    const missing = projections
      .filter(({ relative, literal }) => !/\bdelivery_country\b/.test(literal) && !(relative in NOT_BOOKING))
      .map(({ relative }) => relative)
    expect(missing).toEqual([])
  })
})
