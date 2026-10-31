/**
 * The simulated company never leaves this machine. Every fetch of the build and
 * the tests passes through here: requests to the local database go on, the
 * Skatteverket tax table API is answered from a fixture of the official tables,
 * VIES calls every simulated VAT number valid, and anything else fails at once,
 * so a tool that starts calling out shows up as a failed run instead of a slow
 * or flaky one.
 */
import taxTables from './fixtures/tax-tables.json'

const TAX_TABLE_HOST = 'skatteverket.entryscape.net'
const VIES_HOST = 'ec.europa.eu'

type TaxRow = [from: number, to: number, column1: number]
type TaxTables = Record<string, Record<string, { amount: TaxRow[]; percent: TaxRow[] }>>

/** The official monthly tables (Skatteverket's open data, 2024-2026, tables 30 and 33, column 1). */
export const TAX_TABLES = taxTables as unknown as TaxTables

function taxTableResponse(url: URL): Response {
  const year = url.searchParams.get('år') ?? ''
  const table = url.searchParams.get('tabellnr') ?? ''
  const section = url.searchParams.get('antal dgr') === '30%' ? 'percent' : 'amount'
  const rows = TAX_TABLES[year]?.[table]?.[section] ?? []
  const results = rows.map(([from, to, column1]) => ({
    år: year,
    tabellnr: table,
    'inkomst fr.o.m.': String(from),
    'inkomst t.o.m.': to === 0 ? '' : String(to),
    'kolumn 1': String(column1),
  }))
  return Response.json({ results, resultCount: results.length })
}

/**
 * `databaseUrl` is the only host requests may reach. `bareRest` says it is a
 * PostgREST with nothing in front of it, which serves at the root: Supabase's
 * gateway mounts it under /rest/v1, and every client adds that prefix.
 */
export function installSimNetwork(options: { databaseUrl: string; bareRest: boolean }): void {
  const database = new URL(options.databaseUrl).host
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    if (url.host === TAX_TABLE_HOST) return taxTableResponse(url)
    if (url.host === VIES_HOST) return Response.json({ isValid: true, name: '---', address: '---' })
    if (url.host !== database) {
      throw new TypeError(`simulated company: no network outside this machine (${url.host})`)
    }
    if (!options.bareRest) return realFetch(input, init)
    return realFetch(raw.replace('/rest/v1/', '/').replace(/\/rest\/v1$/, ''), init)
  }) as typeof fetch
}
