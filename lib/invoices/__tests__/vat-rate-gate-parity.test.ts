/**
 * Every server-side write path that validates an invoice line's VAT rate must
 * gate on the SAME set, or the surfaces disagree about what is lawful: the web
 * UI would accept a 12% hotel night to a German company while the REST bulk
 * create, an MCP-staged commit, a recurring schedule or a self-bill refused it.
 *
 * The guarantee is structural, not coincidental: all of them call the one shared
 * getPermittedVatRates(customer_type, vat_number_validated) with the same two
 * fields off the same customers row, and all of them fall back to
 * getVatRules().rate (0% for a foreign business) when a line omits vat_rate. So
 * this pins the call, which is the part a future edit could quietly change back.
 *
 * The MCP staging tool (gnubok_create_invoice) is in the list too: it gates at
 * staging time, so gating it on the default set refused a lawful invoice before
 * the executor's own gate was ever reached.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../..')

const WRITE_GATES = [
  'lib/invoices/build-invoice-write.ts',
  'lib/invoices/self-billed-sale.ts',
  'lib/invoices/recurring-schedule-service.ts',
  'lib/pending-operations/commit.ts',
  'app/api/v1/companies/[companyId]/invoices/bulk-create/route.ts',
  'extensions/general/mcp-server/server.ts',
]

describe('invoice VAT-rate gates agree with buildInvoiceWriteData', () => {
  for (const relative of WRITE_GATES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')

    it(`${relative} gates on getPermittedVatRates`, () => {
      expect(source).toContain('getPermittedVatRates(')
    })

    it(`${relative} does not gate on the picker default`, () => {
      // getAvailableVatRates is the DEFAULT offered in the picker (a single
      // locked 0% for a foreign business customer). Using it as the validation
      // gate is what made a taxed-where-performed invoice impossible to issue.
      expect(source).not.toContain('getAvailableVatRates')
    })
  }
})

/**
 * The same write paths also EXPLAIN the treatment (explainVatTreatment, #2749):
 * which of the three reverse-charge conditions failed. The explanation reads
 * vat_number off the customers row the path fetched, to tell "no number" from
 * "number not validated". A narrow projection that carries vat_number_validated
 * but drops vat_number would tell an unvalidated EU customer that HAS a number
 * that it has none, with a remediation that lost the number.
 *
 * `country` is the same story with a worse outcome (#2783): without it the
 * rule itself is wrong, not just the sentence. countryPermitsReverseCharge()
 * reads a missing country as "does not block", so an eu_business established
 * in Sweden got 0 % reverse charge on the two v1 routes that never selected it.
 *
 * The route tests used table mocks that ignored the select() string, so they
 * could not see this (the v1 invoice route mocks honour it since #2783).
 * Pinned at source level, like the gate above, and independent of tsc.
 */
const EXPLAINING_PATHS_WITH_NARROW_CUSTOMER_SELECT = [
  'app/api/v1/companies/[companyId]/invoices/route.ts',
  'app/api/v1/companies/[companyId]/invoices/[id]/route.ts',
  'app/api/v1/companies/[companyId]/invoices/bulk-create/route.ts',
  'extensions/general/mcp-server/server.ts',
]

describe('narrow customer projections that decide a VAT treatment carry every input', () => {
  for (const relative of EXPLAINING_PATHS_WITH_NARROW_CUSTOMER_SELECT) {
    it(`${relative} selects vat_number and country wherever it selects vat_number_validated`, () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')
      // Directly, or through the shared builder's result.
      expect(source).toMatch(/explainVatTreatment\(|build\.warnings/)
      const selects = Array.from(source.matchAll(/\.select\(\s*'([^']*\bvat_number_validated\b[^']*)'/g)).map(
        (match) => match[1],
      )
      expect(selects.length).toBeGreaterThan(0)
      for (const columns of selects) {
        // \b...\b does not match inside vat_number_validated: "_" is a word char.
        expect(columns, columns).toMatch(/\bvat_number\b(?!_)/)
        expect(columns, columns).toMatch(/\bcountry\b/)
      }
    })
  }
})

/**
 * For the doors that go through buildInvoiceWriteData the pin above is the
 * second net, not the first. The builder's customer parameter
 * (InvoiceBuilderCustomer) makes every field it reads a required key, and
 * supabase-js types a literal select() string into a row with those keys, so a
 * projection that drops one does not compile. Verified when this landed:
 * deleting `country` from either v1 select fails `npm run check:types` with
 * TS2322 at that call site.
 *
 * What the compiler cannot stop is the thing that hid #2783 in the first place:
 * a cast. The builder used to take the full `Customer`, no narrow projection
 * could satisfy that, so both v1 routes wrote `customer as unknown as Customer`
 * and the cast erased the check. Nobody casts their way back in.
 */
describe('doors into buildInvoiceWriteData cannot cast away a missing customer input', () => {
  it('no caller of buildInvoiceWriteData double-casts its customer', () => {
    // Code only: the builder's own doc comment quotes the old cast to explain
    // why the parameter type changed, and prose is not an offence.
    const codeOnly = (source: string) =>
      source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n')
    const offenders = listSourceFiles(['app', 'lib', 'extensions'])
      .filter((file) => {
        const code = codeOnly(fs.readFileSync(file, 'utf8'))
        return code.includes('buildInvoiceWriteData(') && /customer\s+as\s+unknown\s+as\b/.test(code)
      })
      .map((file) => path.relative(REPO_ROOT, file))
    expect(offenders).toEqual([])
  })
})

function listSourceFiles(roots: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full)
    }
  }
  for (const root of roots) walk(path.join(REPO_ROOT, root))
  return found
}
