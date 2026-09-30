import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { REPORT_CATALOG, DIMENSION_FILTER_SLUGS } from '../catalog'
import { OPERATIONS } from '@/lib/operations/registry'

// ============================================================
// Statutory exclusion guard (dimensions PR4).
//
// A dimension-filtered statutory output is a WRONG output: a filtered
// balance sheet doesn't balance, a filtered VAT declaration under-reports,
// a filtered SIE export is not the company's bokföring. The whitelist of
// filterable reports is therefore pinned by TEST, not by convention: this
// suite fails when the filter leaks into a statutory report on any door
// (dashboard route, v1 route or operation, MCP tool) or into a statutory
// generator, or when someone widens a whitelist without touching this file.
// ============================================================

const ROOT = join(process.cwd(), 'src')

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
  // The v1 doors of the same P&L-safe reports: same parser, and the body
  // discloses the partial view (dimension_filter + partial_view).
  'app/api/v1/companies/[companyId]/reports/income-statement/route.ts',
  'app/api/v1/companies/[companyId]/reports/general-ledger/route.ts',
  'app/api/v1/companies/[companyId]/reports/monthly-breakdown/route.ts',
])

/** Route trees scanned for the parser and for filtered generator calls. */
const ROUTE_TREES = ['app/api/reports', 'app/api/v1']

/**
 * Read operations (their v1 doors and any generated MCP tool) whose input
 * takes a dimension. Every other read operation must not.
 */
const ALLOWED_DIMENSION_READ_OPERATIONS = new Set([
  // P&L-side KPIs filtered; the balance-side figures stay company-wide, as
  // the operation's pitfalls say.
  'reports.kpi',
  // dim_no picks the matrix axis (one column per value); it filters nothing.
  'reports.dimension-pnl',
])

/** MCP tools allowed to apply a dimension filter. */
const ALLOWED_MCP_FILTER_TOOLS = new Set([
  'gnubok_get_income_statement',
  'gnubok_get_general_ledger',
  // A journal line query, not a report: it filters lines and totals the match.
  'gnubok_query_journal',
  // Saldobalans is NOT a filterable report (not in FILTERABLE_SLUGS, and the
  // v1 trial balance refuses the filter). Agents use the MCP filter as a
  // P&L-per-project view, so it stays (coordinator decision 2026-09-28), but
  // the answer must carry partial_view: no IB, is_balanced not meaningful.
  // Pinned by the partial_view case below.
  'gnubok_get_trial_balance',
])

/** Statutory generators that must never gain a containment filter. */
const STATUTORY_GENERATORS = [
  'lib/reports/balance-sheet.ts',
  'lib/reports/balansrapport.ts',
  'lib/reports/kassaflodesanalys.ts',
  'lib/reports/vat-declaration.ts',
  'lib/reports/sie-export.ts',
  'lib/reports/full-archive-export.ts',
  'lib/reports/continuity-check.ts',
  'lib/reports/periodisk-sammanstallning.ts',
  'lib/reports/ink2/ink2-engine.ts',
  'lib/reports/ne-bilaga/ne-engine.ts',
  'lib/bokslut/arsredovisning/build-data.ts',
  'lib/bokslut/ixbrl/build-input.ts',
  'lib/bokslut/ixbrl/k2-mapper.ts',
  'lib/bokslut/tax-provision/bolagsskatt-calculator.ts',
  'lib/bokslut/tax-provision/tax-adjustment-service.ts',
  'lib/bokslut/enskild-firma/ef-declaration-preview.ts',
  'lib/bokslut/dispositions-proposal-builder.ts',
  'lib/bokslut/reserves/overavskrivningar-calculator.ts',
  'lib/core/bookkeeping/year-end-service.ts',
]

/** Generators that accept a `dimensions` option. */
const FILTERABLE_GENERATORS = [
  'generateTrialBalance',
  'generateIncomeStatement',
  'generateGeneralLedger',
  'generateMonthlyBreakdown',
  'generateResultatrapport',
  'generateKpiReport',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Repo-relative POSIX path, so the allowlists match on Windows too. */
function rel(full: string): string {
  return full.slice(ROOT.length + 1).replace(/\\/g, '/')
}

/** The route trees' source files; their tests are not routes. */
function routeSources(): string[] {
  return ROUTE_TREES.flatMap((tree) => walk(join(ROOT, tree))).filter((f) => !/[\\/]__tests__[\\/]/.test(f))
}

/**
 * The argument list of every call to `fn` in `src`. Paren-aware (walks to
 * the call's closing paren), not a fixed character window: a long options
 * object cannot slip a key past the guard (#862 review). A declaration
 * (`function fn(`) is not a call.
 */
function callArgs(src: string, fn: string): string[] {
  const out: string[] = []
  let idx = src.indexOf(`${fn}(`)
  while (idx !== -1) {
    const argsStart = idx + fn.length + 1
    let depth = 1
    let end = argsStart
    while (end < src.length && depth > 0) {
      if (src[end] === '(') depth++
      else if (src[end] === ')') depth--
      end++
    }
    const isCall = !/[\w$]/.test(src[idx - 1] ?? '') && !src.slice(Math.max(0, idx - 9), idx).endsWith('function ')
    if (isCall) out.push(src.slice(argsStart, end - 1))
    idx = src.indexOf(`${fn}(`, end)
  }
  return out
}

/** The filterable generators `src` calls with a dimensions option. */
function generatorsGivenDimensions(src: string): string[] {
  return FILTERABLE_GENERATORS.filter((fn) => callArgs(src, fn).some((args) => args.includes('dimensions')))
}

/** True when a piece of MCP server code applies a dimension filter. */
function appliesDimensionFilter(code: string): boolean {
  return (
    code.includes('REPORT_DIMENSIONS_FILTER_SCHEMA') ||
    code.includes('resolveReportDimensionFilter(') ||
    /\.contains\(\s*['"]dimensions['"]/.test(code) ||
    generatorsGivenDimensions(code).length > 0
  )
}

const MCP_DIR = join(ROOT, 'extensions/general/mcp-server')
const MCP_SERVER = join(MCP_DIR, 'server.ts')

/** Each tool of the MCP catalog in server.ts with its definition source. */
function mcpToolBlocks(src: string): Array<{ name: string; code: string }> {
  const start = src.indexOf('export const tools: McpTool[] = [')
  const end = src.indexOf('\n]\n', start)
  const catalog = src.slice(start, end)
  const hits = [...catalog.matchAll(/\n {4}name: '(gnubok_[a-z0-9_]+)'/g)]
  return hits.map((m, i) => ({
    name: m[1]!,
    code: catalog.slice(m.index, i + 1 < hits.length ? hits[i + 1]!.index : catalog.length),
  }))
}

describe('dimension filter: statutory exclusion', () => {
  it('the catalog whitelist is exactly the four P&L-safe reports', () => {
    const flagged = REPORT_CATALOG.filter((r) => r.dimensions).map((r) => r.slug).sort()
    expect(flagged).toEqual([...FILTERABLE_SLUGS].sort())
    expect([...DIMENSION_FILTER_SLUGS].sort()).toEqual([...FILTERABLE_SLUGS].sort())
  })

  it('the dimension-pnl report is gated on dimensions being enabled, never entity/employees', () => {
    const entry = REPORT_CATALOG.find((r) => r.slug === 'dimension-pnl')
    expect(entry).toBeDefined()
    expect(entry?.needsDimensions).toBe(true)
    // Free tier for everyone (founder decision 2026-07-02): no other gate.
    expect(entry?.entityType).toBeUndefined()
    expect(entry?.needsEmployees).toBeUndefined()
  })

  it('no statutory report route, dashboard or v1, imports the dimension filter parser', () => {
    const importers = routeSources()
      .filter((f) => readFileSync(f, 'utf8').includes('lib/reports/dimension-filter'))
      .map(rel)
      .sort()

    // Exactly the P&L-safe routes: nothing more (statutory leak), nothing
    // less (a whitelisted route silently dropping the filter would show an
    // unfiltered report under a "Filtrerad" chip).
    expect(importers).toEqual([...ALLOWED_PARSER_IMPORTERS].sort())
  })

  it('no other route hands a filterable generator a dimensions option', () => {
    // Catches a route that builds its own filter (say from ?project=) and
    // passes it past the shared parser.
    const leaks = routeSources()
      .filter((f) => generatorsGivenDimensions(readFileSync(f, 'utf8')).length > 0)
      .map(rel)
      .filter((f) => !ALLOWED_PARSER_IMPORTERS.has(f))
    expect(leaks).toEqual([])
  })

  it('only the whitelisted read operations take a dimension input', () => {
    const takesDimension = OPERATIONS.filter((op) => op.kind === 'read')
      .filter((op) => {
        const input = op.input as unknown as z.ZodTypeAny
        const keys = input instanceof z.ZodObject ? Object.keys((input as z.ZodObject<z.ZodRawShape>).shape) : []
        return keys.some((k) => k.startsWith('dim_') || k.startsWith('dimension'))
      })
      .map((op) => op.id)
      .sort()
    expect(takesDimension).toEqual([...ALLOWED_DIMENSION_READ_OPERATIONS].sort())
  })

  it('only the whitelisted MCP tools apply a dimension filter', () => {
    const blocks = mcpToolBlocks(readFileSync(MCP_SERVER, 'utf8'))
    // The split must see the whole catalog, or the check below proves nothing.
    expect(blocks.length).toBeGreaterThan(150)
    const filtering = blocks.filter((b) => appliesDimensionFilter(b.code)).map((b) => b.name).sort()
    expect(filtering).toEqual([...ALLOWED_MCP_FILTER_TOOLS].sort())

    // Tools defined outside server.ts never filter.
    const elsewhere = readdirSync(MCP_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'server.ts')
      .filter((f) => appliesDimensionFilter(readFileSync(join(MCP_DIR, f), 'utf8')))
    expect(elsewhere).toEqual([])
  })

  it('the filtered MCP trial balance discloses its partial view', () => {
    const tb = mcpToolBlocks(readFileSync(MCP_SERVER, 'utf8')).find((b) => b.name === 'gnubok_get_trial_balance')
    expect(tb?.code).toMatch(/dimensionFilterPartialView\([^)]*balanceCheck: true/)
  })

  it('statutory generators never apply a dimensions containment filter', () => {
    for (const relPath of STATUTORY_GENERATORS) {
      const src = readFileSync(join(ROOT, relPath), 'utf8')
      expect(src, `${relPath} must not filter on line dimensions`).not.toMatch(
        /contains\(\s*['"]dimensions['"]/,
      )
      expect(src, `${relPath} must not accept a dimensionFilter/dimensions option`).not.toMatch(
        /dimensionFilter|options\?\.dimensions/,
      )
      expect(src, `${relPath} must not import the route filter parser`).not.toContain(
        'lib/reports/dimension-filter',
      )
    }
  })

  it('statutory generators do not receive dimensions through any filterable generator', () => {
    // They may call the P&L generators (kassaflödesanalys reads the income
    // statement, the archive every report), but never with a dimensions
    // option: the check covers every generator that accepts one, not only
    // generateTrialBalance.
    for (const relPath of STATUTORY_GENERATORS) {
      const src = readFileSync(join(ROOT, relPath), 'utf8')
      expect(generatorsGivenDimensions(src), `${relPath} passes dimensions to a generator`).toEqual([])
    }
  })

  it('the call scanner sees a dimensions key deep inside a long options object', () => {
    const src = `const r = await generateIncomeStatement(supabase, id, pid, {
      fromDate, toDate, closingEntry: fn(a, b), dimensions: { '6': 'P1' },
    })`
    expect(generatorsGivenDimensions(src)).toEqual(['generateIncomeStatement'])
    expect(generatorsGivenDimensions('export async function generateTrialBalance(options: { dimensions?: X }) {}')).toEqual([])
  })
})
