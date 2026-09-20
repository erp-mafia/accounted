/**
 * What a connector-minted key can reach (issue #2748).
 *
 * From the claude.ai connector a customer could create a draft invoice but
 * neither edit nor delete it. The scope map was not the cause: /authorize
 * pre-checks the whole catalog for a built-in client (Claude, ChatGPT), capped
 * only by the member's role, so an owner's key carries invoices:write. The
 * cause was catalogVisibility: 'search' on gnubok_update_invoice and
 * gnubok_delete_draft_invoice. tools/list hides a search-only tool, and
 * gnubok_call_tool bridges READS only, so a search-only WRITE is unreachable
 * from any client that can only name what tools/list showed it.
 *
 * Two guards:
 *   1. The real tools/list round trip for a connector-shaped key contains the
 *      draft round trip: create, list, update, delete. The pre-read
 *      gnubok_get_invoice may stay search-only because the bridge reaches it,
 *      but then the update tool must say so.
 *   2. Every search-only WRITE is grandfathered here with a reason. The list
 *      only shrinks: promoting a write removes its entry, and adding a new
 *      write as search-only means adding an entry and, with it, an argument.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { ALL_SCOPES, TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { capScopesForRole } from '@/lib/auth/oauth-allowlist'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        return () => chain
      },
    },
  )
  const membershipChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({
              data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
              error: null,
            })
        }
        return () => membershipChain
      },
    },
  )
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      // The grant the Claude connector mints for an owner: every scope in the
      // catalog (capScopesForRole passes a writer role's ceiling through).
      scopes: [...actual.ALL_SCOPES],
      apiKeyId: 'key-1',
      apiKeyName: 'Claude',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => (table === 'company_members' ? membershipChain : chain),
      rpc: () => chain,
    })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest, tools, isDefaultCatalogTool } from '../server'
import { toolCallableVia } from '../tool-reach'

const DRAFT_ROUND_TRIP_WRITES = [
  'gnubok_create_invoice',
  'gnubok_update_invoice',
  'gnubok_delete_draft_invoice',
] as const

async function listTools(namespace?: 'accounted'): Promise<string[]> {
  const url = new URL('http://localhost:3000/api/extensions/ext/mcp-server/mcp')
  if (namespace) url.searchParams.set('tool_namespace', namespace)
  const response = await handleMcpRequest(
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  )
  expect(response.status).toBe(200)
  const json = (await response.json()) as { result: { tools: Array<{ name: string }> } }
  return json.result.tools.map((t) => t.name)
}

describe('connector-minted key: invoice draft round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('the connector grant for an owner carries every scope the round trip needs', () => {
    // /authorize: a built-in client that passes no scope parameter gets the
    // whole catalog as its ceiling, capped by role; owner is a writer role.
    const connectorScopes = capScopesForRole([...ALL_SCOPES], 'owner')
    expect(connectorScopes).toEqual([...ALL_SCOPES])
    for (const name of [...DRAFT_ROUND_TRIP_WRITES, 'gnubok_get_invoice', 'gnubok_list_invoices']) {
      const required = TOOL_SCOPE_MAP[name]
      expect(required, `${name} must be scoped`).toBeDefined()
      expect(connectorScopes).toContain(required)
    }
  })

  it('tools/list on the accounted namespace shows create, list, update and delete draft', async () => {
    const names = await listTools('accounted')
    expect(names).toContain('accounted_list_invoices')
    for (const name of DRAFT_ROUND_TRIP_WRITES) {
      expect(names, `${name} must be in tools/list: a WRITE outside it is unreachable`).toContain(
        name.replace(/^gnubok_/, 'accounted_'),
      )
    }
    // The bridge itself is listed, so the search-only pre-read is one call away.
    expect(names).toContain('accounted_call_tool')
  })

  it('tools/list on the legacy namespace shows the same writes', async () => {
    const names = await listTools()
    for (const name of DRAFT_ROUND_TRIP_WRITES) expect(names).toContain(name)
  })

  it('the pre-read is bridged, and the update tool tells the agent how', () => {
    const getInvoice = tools.find((t) => t.name === 'gnubok_get_invoice')!
    expect(toolCallableVia(getInvoice)).toBe('call_tool')
    const updateInvoice = tools.find((t) => t.name === 'gnubok_update_invoice')!
    expect(updateInvoice.description).toMatch(/gnubok_get_invoice.*gnubok_call_tool/)
  })

  it('no tool in the draft round trip is unreachable', () => {
    for (const name of [...DRAFT_ROUND_TRIP_WRITES, 'gnubok_get_invoice', 'gnubok_list_invoices']) {
      const tool = tools.find((t) => t.name === name)!
      expect(toolCallableVia(tool), name).not.toBe('none')
    }
  })
})

/**
 * Search-only WRITES on record. gnubok_call_tool refuses writes (a write must
 * be named directly so the client sees its own annotations and approval
 * contract), so each of these is reachable only from a client that can name
 * unlisted tools. They stay search-only because tools/list has a token
 * ceiling (payload-size.bench.test.ts) and promoting one means demoting a
 * read first. Promote one: delete its entry. Add one: add an entry and say
 * why the connector may go without it.
 */
const GRANDFATHERED_SEARCH_ONLY_WRITES: Record<string, string> = {
  gnubok_update_company_settings: 'settings edit outside every bookkeeping loadout; the web app is the primary door',
  gnubok_create_sales_order: 'kundorder family shipped search-only behind gnubok_list_sales_orders (2026-09-02 entry)',
  gnubok_transition_sales_order: 'kundorder family (2026-09-02 entry)',
  gnubok_register_sales_order_delivery: 'kundorder family (2026-09-02 entry)',
  gnubok_create_invoice_from_sales_order: 'kundorder family (2026-09-02 entry)',
  gnubok_link_transaction_to_journal_entry: 'moved to search on 2026-08-23 for the reconciliation doors; in the categorize_month loadout, which flags it',
  gnubok_reconcile_unmatch: 'reconciliation writes shipped search-only (2026-08-23 entry); gnubok_reconcile_match stays listed',
  gnubok_reconcile_signoff: 'reconciliation writes (2026-08-23 entry)',
  gnubok_reconcile_residual: 'reconciliation writes (2026-08-23 entry)',
  gnubok_book_skattekonto_row: 'skattekonto booking pair; the listed reconciliation tools name it',
  gnubok_book_skattekonto_rows: 'skattekonto booking pair',
  gnubok_link_documents_to_vouchers: 'one-off bulk migration tool (2026-08-05 entry); the single-link tool stays listed',
  gnubok_log_mileage_trip: 'körjournal family shipped search-only (2026-08-07 entry)',
  gnubok_book_mileage_period: 'körjournal family (2026-08-07 entry)',
  gnubok_update_salary_run: 'payroll correction outside the payroll_month loadout',
  gnubok_post_kontantmetod_cutoff: 'named by the year-end instructions as "the searchable" cutoff tool',
  gnubok_update_asset: 'anläggningsregister family behind gnubok_list_assets (2026-09-19 entry)',
  gnubok_dispose_asset: 'anläggningsregister family (2026-09-19 entry)',
  gnubok_create_recurring_schedule: 'recurring invoicing; the web app is the primary door',
  gnubok_update_recurring_schedule: 'recurring invoicing; the web app is the primary door',
}

describe('search-only WRITE tools are grandfathered, and the list only shrinks', () => {
  const searchOnlyWrites = tools
    .filter((t) => !isDefaultCatalogTool(t) && t.annotations.readOnlyHint !== true)
    .map((t) => t.name)
    .sort()

  it('every search-only WRITE has an entry with a reason', () => {
    const undocumented = searchOnlyWrites.filter((name) => !(name in GRANDFATHERED_SEARCH_ONLY_WRITES))
    expect(
      undocumented,
      'A WRITE with catalogVisibility "search" is unreachable from claude.ai (tools/list hides it, ' +
        'gnubok_call_tool refuses it). List it in GRANDFATHERED_SEARCH_ONLY_WRITES with a reason, ' +
        'or put it in the default catalog and demote a read to pay for it: ' +
        undocumented.join(', '),
    ).toEqual([])
  })

  it('no entry outlives its promotion', () => {
    const stale = Object.keys(GRANDFATHERED_SEARCH_ONLY_WRITES).filter(
      (name) => !searchOnlyWrites.includes(name),
    )
    expect(stale, 'promoted or renamed: delete the entry: ' + stale.join(', ')).toEqual([])
  })

  it('the draft-invoice writes are off the list for good', () => {
    for (const name of DRAFT_ROUND_TRIP_WRITES) {
      expect(GRANDFATHERED_SEARCH_ONLY_WRITES).not.toHaveProperty(name)
    }
  })
})
