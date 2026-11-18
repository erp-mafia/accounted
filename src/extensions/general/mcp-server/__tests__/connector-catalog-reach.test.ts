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
 * Guards:
 *   1. The real tools/list round trip for a connector-shaped key contains the
 *      draft round trip: create, list, update, delete. The pre-read
 *      gnubok_get_invoice may stay search-only because the bridge reaches it,
 *      but then the update tool must say so.
 *   2. No search-only WRITE is out of reach (issue #2800). #2768 froze 20 of
 *      them here; all 20 only stage, so gnubok_stage_tool carries them and the
 *      allowlist is empty. A write that commits directly may not hide.
 *   3. gnubok_stage_tool carries exactly what the dispatcher says, its
 *      annotations are the worst case over its targets, and the approve step
 *      never shares a bridge with staging.
 *   4. Whatever a listed tool, skill, prompt, loadout or the server
 *      instructions NAME is reachable, so the class cannot regrow.
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

import {
  handleMcpRequest,
  tools,
  isDefaultCatalogTool,
  callableViaFor,
  STAGE_BRIDGE_TARGETS,
  WITHDRAW_TOOL_NAME,
  type CatalogViewer,
  type McpTool,
} from '../server'
import { RECOMMENDED_WORKFLOW_LOADOUTS } from '../recommended-tools'
import { isViewOnlyTool } from '../tool-reach'
import { workflowSkills } from '../skills'
import { prompts } from '../prompts'

// The connector grant for an owner on a multi-company account: every scope,
// so the widest tools/list a caller gets. Reach below is read off it.
const OWNER_CONNECTOR: CatalogViewer = { anonymous: false, simpleCompanyMode: false, keyScopes: [...ALL_SCOPES] }
const reach = (tool: McpTool) => callableViaFor(tool, OWNER_CONNECTOR)

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
    expect(reach(getInvoice)).toBe('call_tool')
    const updateInvoice = tools.find((t) => t.name === 'gnubok_update_invoice')!
    expect(updateInvoice.description).toMatch(/gnubok_get_invoice.*gnubok_call_tool/)
  })

  it('no tool in the draft round trip is unreachable', () => {
    for (const name of [...DRAFT_ROUND_TRIP_WRITES, 'gnubok_get_invoice', 'gnubok_list_invoices']) {
      const tool = tools.find((t) => t.name === name)!
      expect(reach(tool), name).not.toBe('none')
    }
  })
})

/**
 * Search-only WRITES that NO bridge carries, i.e. genuinely unreachable from a
 * client that can only name what tools/list showed it. Empty since issue
 * #2800, and meant to stay empty.
 *
 * #2768 froze 20 such writes here with a reason each. #2800 decided all of
 * them the same way, because all 20 turned out to be the same kind: each only
 * STAGES a pending operation (none commits directly; staging-behaviour.test.ts
 * checks that against behaviour). gnubok_stage_tool now carries a write that
 * declares the staged envelope and is absent from tools/list, so none of them
 * needed listing (about 15K tokens) or trading against a read. Decision per
 * family, all "bridged through gnubok_stage_tool":
 *
 *   reconciliation   link_transaction_to_journal_entry, reconcile_unmatch,
 *                    reconcile_signoff, reconcile_residual
 *   skattekonto      book_skattekonto_row, book_skattekonto_rows
 *   anläggningar     update_asset, dispose_asset
 *   recurring        create_recurring_schedule, update_recurring_schedule
 *   kundorder        create_sales_order, transition_sales_order,
 *                    register_sales_order_delivery, create_invoice_from_sales_order
 *   körjournal       log_mileage_trip, book_mileage_period
 *   singles          update_company_settings, update_salary_run,
 *                    post_kontantmetod_cutoff, link_documents_to_vouchers
 *
 * Adding an entry means shipping a write that commits directly AND hiding it
 * from tools/list. Prefer making it stage. If it truly must commit directly,
 * list it; an entry here also has to pass the "nothing names it" test below.
 */
const UNREACHABLE_SEARCH_ONLY_WRITES: Record<string, string> = {
  // The liquidity forecast's rows (accounted#136, decision 2026-10-28): not
  // bookkeeping, so they commit directly (DIRECT_WRITE_SCOPES) instead of
  // staging, and search-only because tools/list is at its ceiling. Reachable
  // over v1 REST and a raw tools/call; for a client that only calls listed
  // tools, the operator picks between listing the upsert and a bridge for
  // direct writes.
  gnubok_upsert_cash_forecast_rows: 'Direct forecast-row write (not bookkeeping), search-only by the tools/list ceiling; v1 POST /cash-forecast-rows carries it.',
  gnubok_cancel_cash_forecast_row: 'Direct forecast-row write (not bookkeeping), search-only by the tools/list ceiling; v1 POST /cash-forecast-rows/cancel carries it.',
}

describe('no search-only WRITE is out of reach (issue #2800)', () => {
  // The approval view's own door is not search-only: it is listed, app-only,
  // to a connection with the view, and only the view calls it (view-approval.ts).
  const searchOnlyWrites = tools.filter(
    (t) => !isDefaultCatalogTool(t) && !isViewOnlyTool(t) && t.annotations.readOnlyHint !== true,
  )

  it('every search-only WRITE is carried by gnubok_stage_tool, or is on record as unreachable', () => {
    const unreachable = searchOnlyWrites
      .filter((t) => reach(t) === 'none')
      .map((t) => t.name)
      .filter((name) => !(name in UNREACHABLE_SEARCH_ONLY_WRITES))
    expect(
      unreachable,
      'A search-only WRITE that commits directly is unreachable from claude.ai: tools/list hides ' +
        'it and both bridges refuse it. Make it stage a pending operation (then gnubok_stage_tool ' +
        'carries it), or put it in the default catalog: ' + unreachable.join(', '),
    ).toEqual([])
  })

  it('no entry outlives its fix', () => {
    const stale = Object.keys(UNREACHABLE_SEARCH_ONLY_WRITES).filter((name) => {
      const tool = tools.find((t) => t.name === name)
      return !tool || reach(tool) !== 'none'
    })
    expect(stale, 'now reachable or renamed: delete the entry: ' + stale.join(', ')).toEqual([])
  })

  it('the 20 writes #2768 froze, and the draft-invoice pair, are all reachable now', () => {
    const frozenBy2768 = [
      'gnubok_update_company_settings', 'gnubok_create_sales_order', 'gnubok_transition_sales_order',
      'gnubok_register_sales_order_delivery', 'gnubok_create_invoice_from_sales_order',
      'gnubok_link_transaction_to_journal_entry', 'gnubok_reconcile_unmatch', 'gnubok_reconcile_signoff',
      'gnubok_reconcile_residual', 'gnubok_book_skattekonto_row', 'gnubok_book_skattekonto_rows',
      'gnubok_link_documents_to_vouchers', 'gnubok_log_mileage_trip', 'gnubok_book_mileage_period',
      'gnubok_update_salary_run', 'gnubok_post_kontantmetod_cutoff', 'gnubok_update_asset',
      'gnubok_dispose_asset', 'gnubok_create_recurring_schedule', 'gnubok_update_recurring_schedule',
    ]
    expect(frozenBy2768).toHaveLength(20)
    for (const name of [...frozenBy2768, ...DRAFT_ROUND_TRIP_WRITES]) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, `${name} was renamed or removed: update this list`).toBeDefined()
      expect(reach(tool!), name).not.toBe('none')
    }
  })
})

describe('gnubok_stage_tool carries exactly what the dispatcher says it carries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('STAGE_BRIDGE_TARGETS and callable_via agree for every tool in the registry', () => {
    // Plus the one carried write that does not stage: the stager's own
    // withdrawal (ridesStageBridge in server.ts).
    const carried = new Set([...STAGE_BRIDGE_TARGETS.map((t) => t.name), WITHDRAW_TOOL_NAME])
    for (const tool of tools) {
      expect(reach(tool) === 'stage_tool', tool.name).toBe(
        carried.has(tool.name),
      )
    }
  })

  it('the REAL dispatcher agrees, tool by tool: carried reaches the scope check, the rest is refused', async () => {
    // A key with no scopes at all, so nothing ever executes. A carried tool
    // gets past the bridge and stops at ITS OWN scope check (which also shows
    // the inner scope is what is enforced); anything else is bridge_refused.
    // Every carried tool is scoped: strict-schemas.test.ts guarantees it.
    const carried = new Set(STAGE_BRIDGE_TARGETS.map((t) => t.name))
    const { validateApiKey } = await import('@/lib/auth/api-keys')
    const disagreements: string[] = []
    for (const tool of tools) {
      vi.mocked(validateApiKey).mockResolvedValueOnce({
        userId: 'user-1',
        companyId: '11111111-1111-4111-8111-111111111111',
        scopes: [],
        apiKeyId: 'key-1',
        apiKeyName: 'No Scopes',
        mode: 'live',
      } as never)
      const kinds: string[] = []
      const off = eventBus.on('mcp.tool_called', (payload) => {
        kinds.push(String((payload as unknown as { errorKind: string | null }).errorKind))
      })
      await handleMcpRequest(
        new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'gnubok_stage_tool', arguments: { tool: tool.name, arguments: {} } },
          }),
        }),
      )
      off()
      // A view-only tool does not exist to a bridge (view-approval.ts): the
      // model learns nothing about it, not even advice to call it directly.
      // The withdrawal has no scope (ownership is its gate), so the bridge
      // carries it into its own argument check: no operation_id was sent.
      const expected = isViewOnlyTool(tool)
        ? 'unknown_tool'
        : tool.name === WITHDRAW_TOOL_NAME
          ? 'execution'
          : carried.has(tool.name)
            ? 'scope_denied'
            : 'bridge_refused'
      if (kinds[0] !== expected) disagreements.push(`${tool.name}: expected ${expected}, got ${kinds[0]}`)
    }
    expect(disagreements).toEqual([])
  })

  it("the carrier's annotations are the worst case over what it can carry", () => {
    // A hint that errs toward prompting is the safe direction. If a carried
    // tool is destructive or open-world, so is the carrier; it may only claim
    // idempotency if every carried tool does.
    const carrier = tools.find((t) => t.name === 'gnubok_stage_tool')!.annotations
    expect(carrier.readOnlyHint).toBe(false)
    const targets = STAGE_BRIDGE_TARGETS.map((t) => t.annotations)
    expect(targets.some((a) => a.destructiveHint === true)).toBe(true)
    if (targets.some((a) => a.destructiveHint !== false)) expect(carrier.destructiveHint).toBe(true)
    if (targets.some((a) => a.openWorldHint !== false)) expect(carrier.openWorldHint).not.toBe(false)
    if (targets.some((a) => a.idempotentHint !== true)) expect(carrier.idempotentHint).not.toBe(true)
  })

  it('carries no tool that settles a pending operation: stage and approve never share a bridge', () => {
    const carried = STAGE_BRIDGE_TARGETS.map((t) => t.name)
    expect(carried).not.toContain('gnubok_approve_pending_operation')
    expect(carried).not.toContain('gnubok_reject_pending_operation')
    // The withdrawal the bridge does carry is not one of them: it is not a
    // staging target, it cannot approve, and it settles only the caller's own.
    expect(carried).not.toContain(WITHDRAW_TOOL_NAME)
    const withdrawal = tools.find((t) => t.name === WITHDRAW_TOOL_NAME)!
    expect(isDefaultCatalogTool(withdrawal)).toBe(false)
    expect(reach(withdrawal)).toBe('stage_tool')
    // And the approve step is LISTED, so the human-visible approval keeps its
    // own name, its own destructive annotation and its own client permission.
    const approve = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!
    expect(isDefaultCatalogTool(approve)).toBe(true)
    expect(approve.annotations.destructiveHint).toBe(true)
  })
})

/**
 * The acceptance test for issue #2800, and the guard that stops the class
 * regrowing: whatever a connector-side agent is TOLD to call, it can call.
 *
 * Ten listed tools named unlisted writes when the issue was filed, and the
 * reconcile-month skill named book_skattekonto_row and reconcile_signoff that
 * the catalog hid. This walks every place that names tools to such an agent
 * and requires each named registry tool to be listed or bridged.
 */
describe('every tool a listed tool, skill, prompt, loadout or the instructions names is reachable', () => {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const TOOL_NAME = /gnubok_[a-z0-9]+(?:_[a-z0-9]+)*/g

  function unreachableNamesIn(text: string, registry: Map<string, McpTool> = byName): string[] {
    const named = new Set(text.match(TOOL_NAME) ?? [])
    return [...named].filter((name) => {
      const tool = registry.get(name)
      // Not a registry tool (an API-key prefix, a truncated "_suffix" list):
      // phantom names are other tests' business.
      if (!tool) return false
      return reach(tool) === 'none'
    })
  }

  it('listed tools: descriptions and schemas', () => {
    const offenders = tools
      .filter(isDefaultCatalogTool)
      .map((t) => ({
        name: t.name,
        bad: unreachableNamesIn(JSON.stringify([t.description, t.inputSchema, t.outputSchema])),
      }))
      .filter((entry) => entry.bad.length > 0)
      .map((entry) => `${entry.name} names ${entry.bad.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('search-only tools too: a bridged tool must not send the agent to a dead end either', () => {
    const offenders = tools
      .filter((t) => !isDefaultCatalogTool(t))
      .map((t) => ({ name: t.name, bad: unreachableNamesIn(JSON.stringify([t.description, t.inputSchema])) }))
      .filter((entry) => entry.bad.length > 0)
      .map((entry) => `${entry.name} names ${entry.bad.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('workflow skills', () => {
    const offenders = workflowSkills
      .map((skill) => ({ slug: skill.slug, bad: unreachableNamesIn(JSON.stringify(skill)) }))
      .filter((entry) => entry.bad.length > 0)
      .map((entry) => `skill ${entry.slug} names ${entry.bad.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('prompts', () => {
    const offenders = prompts
      .map((prompt) => ({ name: prompt.name, bad: unreachableNamesIn(JSON.stringify(prompt)) }))
      .filter((entry) => entry.bad.length > 0)
      .map((entry) => `prompt ${entry.name} names ${entry.bad.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('the briefing loadouts', () => {
    const offenders = RECOMMENDED_WORKFLOW_LOADOUTS.map((loadout) => ({
      workflow: loadout.workflow,
      bad: unreachableNamesIn(loadout.tools.join(' ')),
    }))
      .filter((entry) => entry.bad.length > 0)
      .map((entry) => `loadout ${entry.workflow} names ${entry.bad.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('the server instructions, which also stop saying the bridge refuses writes', async () => {
    const response = await handleMcpRequest(
      new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    )
    const json = (await response.json()) as { result: { instructions: string } }
    const instructions = json.result.instructions
    expect(unreachableNamesIn(instructions)).toEqual([])
    expect(instructions).toContain('gnubok_stage_tool')
    expect(instructions).not.toMatch(/bridge refuses writes/i)
  })

  it('the walk has teeth: it flags a name that resolves to an unreachable tool', () => {
    // Guard the guard. With the allowlist empty no real tool is unreachable,
    // so prove the detector on a registry where one is: the same search-only
    // write, but committing directly instead of staging.
    const victim = STAGE_BRIDGE_TARGETS[0]
    const text = `Undo it with ${victim.name}, then re-read gnubok_get_reconciliation_status.`
    expect(unreachableNamesIn(text)).toEqual([])

    const rigged = new Map<string, McpTool>(byName)
    rigged.set(victim.name, { ...victim, outputSchema: { type: 'object' } })
    expect(unreachableNamesIn(text, rigged)).toEqual([victim.name])
  })
})
