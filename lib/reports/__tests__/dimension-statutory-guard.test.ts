import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_CATALOG, DIMENSION_FILTER_SLUGS } from '../catalog'

// ============================================================
// Statutory exclusion guard (dimensions PR4).
//
// A dimension-filtered statutory output is a WRONG output: a filtered
// balance sheet doesn't balance, a filtered VAT declaration under-reports,
// a filtered SIE export is not the company's bokföring. The whitelist of
// filterable reports is therefore pinned by TEST, not by convention — this
// suite fails when the filter leaks into a statutory report route or
// generator, or when someone widens the catalog whitelist without touching
// this file.
// ============================================================

const ROOT = process.cwd()

/** The only reports allowed to accept the dimension value filter. */
const FILTERABLE_SLUGS = ['resultatrapport', 'income-statement', 'huvudbok', 'kpi']

/** Routes allowed to import the route-side filter parser. */
const ALLOWED_PARSER_IMPORTERS = new Set([
  'app/api/reports/resultatrapport/route.ts',
  'app/api/reports/resultatrapport/xlsx/route.ts',
  'app/api/reports/resultatrapport/pdf/route.ts',
  'app/api/reports/income-statement/route.ts',
  'app/api/reports/income-statement/xlsx/route.ts',
  'app/api/reports/income-statement/pdf/route.ts',
  'app/api/reports/general-ledger/route.ts',
  'app/api/reports/general-ledger/xlsx/route.ts',
  'app/api/reports/kpi/route.ts',
  'app/api/reports/monthly-breakdown/route.ts',
  'app/api/reports/trial-balance/account/[accountNumber]/sources/route.ts',
])

/** Statutory generators that must never gain a containment filter. */
const STATUTORY_GENERATORS = [
  'lib/reports/balance-sheet.ts',
  'lib/reports/balansrapport.ts',
  'lib/reports/kassaflodesanalys.ts',
  'lib/reports/vat-declaration.ts',
  'lib/reports/sie-export.ts',
  'lib/reports/full-archive-export.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('dimension filter — statutory exclusion', () => {
  it('the catalog whitelist is exactly the four P&L-safe reports', () => {
    const flagged = REPORT_CATALOG.filter((r) => r.dimensions).map((r) => r.slug).sort()
    expect(flagged).toEqual([...FILTERABLE_SLUGS].sort())
    expect([...DIMENSION_FILTER_SLUGS].sort()).toEqual([...FILTERABLE_SLUGS].sort())
  })

  it('the dimension-pnl report is gated on dimensions being enabled, never entity/employees', () => {
    const entry = REPORT_CATALOG.find((r) => r.slug === 'dimension-pnl')
    expect(entry).toBeDefined()
    expect(entry?.needsDimensions).toBe(true)
    // Free tier for everyone (founder decision 2026-07-02) — no other gate.
    expect(entry?.entityType).toBeUndefined()
    expect(entry?.needsEmployees).toBeUndefined()
  })

  it('no statutory report route imports the dimension filter parser', () => {
    const reportRoutes = walk(join(ROOT, 'app/api/reports'))
    const importers = reportRoutes
      .filter((f) => readFileSync(f, 'utf8').includes('lib/reports/dimension-filter'))
      .map((f) => f.slice(ROOT.length + 1))
      .sort()

    // Exactly the P&L-safe routes — nothing more (statutory leak), nothing
    // less (a whitelisted route silently dropping the filter would show an
    // unfiltered report under a "Filtrerad" chip).
    expect(importers).toEqual([...ALLOWED_PARSER_IMPORTERS].sort())
  })

  it('statutory generators never apply a dimensions containment filter', () => {
    for (const rel of STATUTORY_GENERATORS) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(src, `${rel} must not filter on line dimensions`).not.toMatch(
        /contains\(\s*['"]dimensions['"]/,
      )
      expect(src, `${rel} must not accept a dimensionFilter/dimensions option`).not.toMatch(
        /dimensionFilter|options\?\.dimensions/,
      )
    }
  })

  it('statutory generators do not receive dimensions through generateTrialBalance', () => {
    // They may call generateTrialBalance, but never with a dimensions option.
    // The scan is paren-aware (walks to the call's closing paren), not a
    // fixed character window — a long options object cannot slip the key
    // past the guard (#862 review).
    for (const rel of STATUTORY_GENERATORS) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      let idx = src.indexOf('generateTrialBalance(')
      while (idx !== -1) {
        const argsStart = idx + 'generateTrialBalance('.length
        let depth = 1
        let end = argsStart
        while (end < src.length && depth > 0) {
          if (src[end] === '(') depth++
          else if (src[end] === ')') depth--
          end++
        }
        const argList = src.slice(argsStart, end)
        expect(argList, `${rel} passes dimensions to generateTrialBalance`).not.toContain(
          'dimensions',
        )
        idx = src.indexOf('generateTrialBalance(', end)
      }
    }
  })
})
