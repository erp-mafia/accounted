/**
 * One customer, every door, one row.
 *
 * The dashboard's POST and PATCH /api/customers, the v1 POST, PATCH and
 * bulk-create, and the approval of an agent's staged create_customer and
 * update_customer used to write through their own copies: v1 bulk-create
 * dropped customer_number and language, the approval's insert dropped every
 * field outside the agent tool's own list, and the dashboard echoed a
 * duplicate org number back. They now share createCustomer and updateCustomer
 * (lib/customers/customer-commands.ts); the same input must write the same row
 * through each.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const { doors } = vi.hoisted(() => ({ doors: { dashboard: null as unknown } }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(doors.dashboard),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  getActiveCompanyId: vi.fn().mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/invoices/sync-draft-vat-headers', () => ({
  syncDraftVatHeadersForCustomer: vi.fn().mockResolvedValue(0),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as dashboardPOST } from '@/app/api/customers/route'
import { PATCH as dashboardPATCH } from '@/app/api/customers/[id]/route'
import { POST as v1POST } from '@/app/api/v1/companies/[companyId]/customers/route'
import { PATCH as v1PATCH } from '@/app/api/v1/companies/[companyId]/customers/[id]/route'
import { POST as v1BulkPOST } from '@/app/api/v1/companies/[companyId]/customers/bulk-create/route'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { tools } from '@/extensions/general/mcp-server/server'
import { findUnknownArgKeys } from '@/extensions/general/mcp-server/arg-guard'
import { CreateCustomerSchema, UpdateCustomerSchema } from '@/lib/api/schemas'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

/** The fields v1 bulk-create (customer_number, language) and the approval dropped. */
const input = {
  name: 'Konsult AB',
  customer_type: 'swedish_business',
  customer_number: 'K-7',
  contact_person: 'Anna Andersson',
  email: 'faktura@konsult.example',
  invoice_email_cc_addresses: ['ekonomi@konsult.example'],
  phone: '08-123 45',
  address_line1: 'Gatan 1',
  postal_code: '111 22',
  city: 'Stockholm',
  org_number: '556677-8899',
  language: 'en',
  default_payment_terms: 14,
  notes: 'Ring före leverans.',
}

const row = { id: CUSTOMER_ID, name: 'Konsult AB', customer_type: 'swedish_business', personal_number: null }

function written(findCall: (table: string, method: string) => unknown[] | undefined, method: 'insert' | 'update') {
  const payload = findCall('customers', method)?.[0] as Record<string, unknown> | undefined
  expect(payload).toBeDefined()
  return payload!
}

function v1Request(path: string, method: 'POST' | 'PATCH', body: unknown) {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

function v1Supabase() {
  const v1 = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    customers: { data: row, error: null },
  })
  vi.mocked(createServiceClientNoCookies).mockReturnValue(v1.supabase as never)
  return v1
}

function stagedOp(type: string, params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: USER_ID,
    company_id: COMPANY_ID,
    operation_type: type,
    status: 'pending',
    title: 'Kund',
    params,
    preview_data: {},
    result_data: null,
    risk_level: 'low',
    created_at: '2026-10-13T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-13T00:00:00Z',
  } as unknown as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['customers:write'],
    mode: 'live',
  } as never)
})

describe('customer create: every door inserts the same row', () => {
  it('inserts one row from the dashboard, v1, v1 bulk-create and the agent approval', async () => {
    const dashboard = createQueuedMockSupabase()
    dashboard.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
    dashboard.enqueue({ data: row })
    doors.dashboard = dashboard.supabase
    const res = await dashboardPOST(
      new Request('https://x.test/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }) as never,
      { params: Promise.resolve({}) } as never,
    )
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    const fromDashboard = written(dashboard.findCall, 'insert')
    expect(fromDashboard).toMatchObject({
      customer_number: 'K-7',
      contact_person: 'Anna Andersson',
      invoice_email_cc_addresses: ['ekonomi@konsult.example'],
      phone: '08-123 45',
      language: 'en',
      notes: 'Ring före leverans.',
      country: 'SE',
      default_payment_terms: 14,
      personal_number: null,
    })

    const v1 = v1Supabase()
    const v1Res = await v1POST(v1Request('/customers', 'POST', input), { params: Promise.resolve({ companyId: COMPANY_ID }) })
    expect(v1Res.status, JSON.stringify(await v1Res.clone().json())).toBe(201)
    expect(written(v1.findCall, 'insert')).toEqual(fromDashboard)

    const bulk = v1Supabase()
    const bulkRes = await v1BulkPOST(v1Request('/customers/bulk-create', 'POST', { customers: [input] }), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })
    expect(bulkRes.status, JSON.stringify(await bulkRes.clone().json())).toBe(200)
    expect(written(bulk.findCall, 'insert')).toEqual(fromDashboard)

    const approval = createQueuedMockSupabase()
    approval.enqueue({ data: { id: 'op-1' } }) // CAS claim
    approval.enqueue({ data: row }) // insert
    approval.enqueue({ data: null }) // finalize
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('create_customer', input),
    )
    expect(committed.status, committed.error).toBe('committed')
    expect(written(approval.findCall, 'insert')).toEqual(fromDashboard)
  })

  it('commits what the agent tool staged as the dashboard inserts it', async () => {
    const tool = tools.find((candidate) => candidate.name === 'gnubok_create_customer')!
    const staging = createQueuedMockSupabase()
    staging.enqueue({ data: { id: 'op-1' } }) // pending_operations insert
    // The tool's wire names: address and payment_terms.
    const { address_line1: address, default_payment_terms: paymentTerms, ...rest } = input
    const args = { ...rest, address, payment_terms: paymentTerms }
    // execute() runs after the dispatcher's argument guard, which refuses any
    // key the tool does not list: calling execute alone hid that contact_person
    // could never get this far (crm#1198).
    expect(findUnknownArgKeys(tool.inputSchema as Record<string, unknown>, args)).toEqual([])
    await tool.execute(args, COMPANY_ID, USER_ID, staging.supabase as never)
    const staged = staging.findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }

    const approval = createQueuedMockSupabase()
    approval.enqueue({ data: { id: 'op-1' } })
    approval.enqueue({ data: row })
    approval.enqueue({ data: null })
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('create_customer', staged.params),
    )
    expect(committed.status, committed.error).toBe('committed')

    const dashboard = createQueuedMockSupabase()
    dashboard.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
    dashboard.enqueue({ data: row })
    doors.dashboard = dashboard.supabase
    await dashboardPOST(
      new Request('https://x.test/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }) as never,
      { params: Promise.resolve({}) } as never,
    )
    expect(written(approval.findCall, 'insert')).toEqual(written(dashboard.findCall, 'insert'))
  })

  it('answers a duplicate org number without echoing it, from every door', async () => {
    const duplicate = { data: null, error: { code: '23505', message: 'duplicate key value' } }

    const dashboard = createQueuedMockSupabase()
    dashboard.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
    dashboard.enqueue(duplicate)
    doors.dashboard = dashboard.supabase
    const res = await dashboardPOST(
      new Request('https://x.test/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }) as never,
      { params: Promise.resolve({}) } as never,
    )
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).not.toContain('556677')

    const approval = createQueuedMockSupabase()
    approval.enqueue({ data: { id: 'op-1' } })
    approval.enqueue(duplicate)
    approval.enqueue({ data: null })
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('create_customer', input),
    )
    expect(committed.http_status).toBe(409)
    expect(committed.error).not.toContain('duplicate key')
  })
})

describe('customer update: every door writes the same change', () => {
  const stored = {
    id: CUSTOMER_ID,
    customer_type: 'swedish_business',
    country: 'SE',
    vat_number: null,
    org_number: '5566778899',
    personal_number: null,
  }
  const change = { customer_number: '', email: '', notes: 'Ny adress', city: 'Göteborg' }

  it('updates one row from the dashboard, v1 and the agent approval', async () => {
    const dashboard = createQueuedMockSupabase()
    dashboard.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
    dashboard.enqueue({ data: stored }) // lookup
    dashboard.enqueue({ data: { ...stored, ...change } }) // update
    doors.dashboard = dashboard.supabase
    const res = await dashboardPATCH(
      new Request(`https://x.test/api/customers/${CUSTOMER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }) as never,
      { params: Promise.resolve({ id: CUSTOMER_ID }) } as never,
    )
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    const fromDashboard = written(dashboard.findCall, 'update')
    expect(fromDashboard).toEqual({ customer_number: null, email: null, notes: 'Ny adress', city: 'Göteborg' })

    const v1 = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      customers: { data: stored, error: null },
    })
    vi.mocked(createServiceClientNoCookies).mockReturnValue(v1.supabase as never)
    const v1Res = await v1PATCH(v1Request(`/customers/${CUSTOMER_ID}`, 'PATCH', change), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: CUSTOMER_ID }),
    })
    expect(v1Res.status, JSON.stringify(await v1Res.clone().json())).toBe(200)
    expect(written(v1.findCall, 'update')).toEqual(fromDashboard)

    const approval = createQueuedMockSupabase()
    approval.enqueue({ data: { id: 'op-1' } }) // CAS claim
    approval.enqueue({ data: stored }) // lookup
    approval.enqueue({ data: { ...stored, ...change } }) // update
    approval.enqueue({ data: null }) // finalize
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('update_customer', { customer_id: CUSTOMER_ID, changes: change }),
    )
    expect(committed.status, committed.error).toBe('committed')
    expect(written(approval.findCall, 'update')).toEqual(fromDashboard)
  })
})

/**
 * The agent tools list their arguments by hand (a derived schema costs about
 * 200 tokens more in tools/list), and the dispatcher refuses any key a tool
 * does not list. So a register field missing from a tool cannot be set over
 * MCP at all, however the schema, the command and gnubok_get_customer carry
 * it: contact_person was such a field (crm#1198). Each field the shared
 * schema takes is an argument of the tool, or is named here with why not.
 */
const NOT_ON_THE_AGENT_TOOLS: Record<string, string> = {
  invoice_email_bcc_addresses: 'a hidden copy of every invoice email; set in the web app (tools/list budget)',
}

/** gnubok_create_customer names two fields its own way. */
const CREATE_WIRE_NAMES: Record<string, string> = { address: 'address_line1', payment_terms: 'default_payment_terms' }

/** Arguments that steer the tool rather than name a field. */
const CONTROL_ARGS = new Set(['customer_id', 'dry_run', 'idempotency_key'])

/** The keys of an object schema, through any transform wrapped around it. */
function schemaKeys(schema: unknown): string[] {
  let node = schema
  while (node && !(node instanceof z.ZodObject)) node = (node as { in?: unknown }).in
  if (!(node instanceof z.ZodObject)) throw new Error('not an object schema')
  return Object.keys(node.shape)
}

function fieldArgs(name: string): string[] {
  const agentTool = tools.find((candidate) => candidate.name === name)!
  return Object.keys((agentTool.inputSchema as { properties: Record<string, unknown> }).properties)
    .filter((key) => !CONTROL_ARGS.has(key))
    .map((key) => CREATE_WIRE_NAMES[key] ?? key)
}

describe('the agent tools take the register\'s fields', () => {
  it.each([
    ['gnubok_create_customer', CreateCustomerSchema],
    ['gnubok_update_customer', UpdateCustomerSchema],
  ] as const)('%s takes every field of its schema, or names why not', (name, schema) => {
    const args = fieldArgs(name)
    const missing = schemaKeys(schema).filter((key) => !args.includes(key))
    expect(missing.sort()).toEqual(Object.keys(NOT_ON_THE_AGENT_TOOLS).sort())
  })

  it.each(['gnubok_create_customer', 'gnubok_update_customer'])('%s has no argument outside the register', (name) => {
    const fields = new Set([...schemaKeys(CreateCustomerSchema), ...schemaKeys(UpdateCustomerSchema)])
    expect(fieldArgs(name).filter((key) => !fields.has(key))).toEqual([])
  })
})
