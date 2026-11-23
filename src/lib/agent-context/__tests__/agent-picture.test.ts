/**
 * The agent picture's loader: each part, each part's failure leaving the
 * rest, the company filter on every read, and what is masked.
 *
 * The Supabase client is a small fake keyed by table: every chained call is
 * recorded, and a table's handler answers when the chain is awaited.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const COMPANY = 'company-1'
const USER = 'user-1'
// A Monday morning in Stockholm (CET): the day began at 2026-03-01T23:00Z.
const NOW = new Date('2026-03-02T09:00:00.000Z')

interface Call {
  table: string
  ops: Array<{ method: string; args: unknown[] }>
}
type Answer = { data?: unknown; error?: { message: string } | null; count?: number | null }
type Handler = Answer | ((call: Call) => Answer | Promise<Answer>)

function fakeSupabase(tables: Record<string, Handler>) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] }
      calls.push(call)
      const answer = async () => {
        const handler = tables[table]
        const result = typeof handler === 'function' ? await handler(call) : handler
        return { data: result?.data ?? null, error: result?.error ?? null, count: result?.count ?? null }
      }
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_target, prop: string) {
            if (prop === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer().then(resolve, reject)
            return (...args: unknown[]) => {
              call.ops.push({ method: prop, args })
              return builder
            }
          },
        },
      )
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const filtered = (call: Call, method: string, column: string, value?: unknown) =>
  call.ops.some((op) => op.method === method && op.args[0] === column && (value === undefined || op.args[1] === value))

const { listUnexplainedMock, dataStatusMock, inboxAddressMock, skillRowsMock, enabled } = vi.hoisted(() => ({
  listUnexplainedMock: vi.fn(),
  dataStatusMock: vi.fn(),
  inboxAddressMock: vi.fn(),
  skillRowsMock: vi.fn(),
  enabled: new Set<string>(),
}))

let service: ReturnType<typeof fakeSupabase>
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => service.client,
}))
vi.mock('@/lib/extensions/_generated/enabled-extensions', () => ({ ENABLED_EXTENSION_IDS: enabled }))
vi.mock('@/lib/unexplained', () => ({
  listUnexplained: (...args: unknown[]) => listUnexplainedMock(...args),
  getCheckDefinition: (id: string) => ({ name_en: `EN ${id}` }),
}))
vi.mock('@/lib/reports/data-status', () => ({
  buildReportDataStatus: (...args: unknown[]) => dataStatusMock(...args),
}))
vi.mock('@/lib/documents/inbox-address', () => ({
  resolveInboxAddress: (...args: unknown[]) => inboxAddressMock(...args),
}))
vi.mock('@/lib/agent-skills/company-skills', async (original) => ({
  ...(await original<typeof import('@/lib/agent-skills/company-skills')>()),
  loadCompanySkillRows: (...args: unknown[]) => skillRowsMock(...args),
}))

import { limitNotConnected, loadAgentActivity, loadAgentPicture, type PictureSource, type PictureSourceGroup } from '../agent-picture'

const ALL_EXTENSIONS = ['enable-banking', 'skatteverket', 'tic', 'invoice-inbox', 'whatsapp-inbox', 'mail', 'stripe', 'shopify', 'woocommerce', 'zettle']

const OAUTH_KEY_NAME = 'MCP-klient (OAuth)'

/** A company with a bit of everything. Each test changes the one table it is about. */
function tables(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    cash_accounts: {
      data: [
        {
          id: 'cash-1',
          name: 'Företagskonto',
          iban: 'SE45 5000 0000 0583 9825 7466',
          kind: 'bank',
          ledger_account: '1930',
          bank_connection_id: 'conn-1',
          bank_connection: { bank_name: 'SEB', status: 'active', last_synced_at: '2026-03-02T05:12:00.000Z' },
        },
      ],
    },
    companies: (call) =>
      call.ops.some((op) => op.method === 'select' && op.args[0] === 'name')
        ? { data: { name: 'Exempelbolaget AB' } }
        : { data: { tic_snapshot_fetched_at: '2026-02-14T10:00:00.000Z' } },
    invoice_inbox_items: (call) =>
      call.ops.some((op) => op.method === 'select' && (op.args[1] as { head?: boolean } | undefined)?.head)
        ? { count: 86 }
        : { data: [{ created_at: '2026-02-28T08:00:00.000Z' }] },
    whatsapp_phone_links: { data: { phone_masked: '+46 70 *** ** 34', last_message_at: '2026-03-01T12:00:00.000Z' } },
    digital_mailbox_connections: { data: [{ provider: 'kivra', receive_state: 'active', last_synced_at: '2026-03-01T03:00:00.000Z' }] },
    mail_connections: { data: [] },
    pos_connections: { data: [] },
    stripe_connections: { data: [] },
    shopify_connections: { data: [] },
    woocommerce_connections: { data: [] },
    zettle_connections: { data: [] },
    journal_entries: { count: 4912 },
    transactions: { count: 1311 },
    document_attachments: { count: 86 },
    customers: { count: 38 },
    suppliers: { count: 64 },
    agent_memory: { count: 23 },
    agent_profiles: { data: { horizontal_atoms: ['horizontal/a', 'horizontal/b'], vertical_atoms: ['vertical/c'], modifier_atoms: null } },
    agent_atom_registry: { count: 3 },
    fiscal_periods: { data: [{ id: 'period-1' }] },
    api_keys: (call) =>
      filtered(call, 'eq', 'company_id')
        ? {
            data: [
              { id: 'key-claude', name: OAUTH_KEY_NAME, client: 'claude', last_used_at: '2026-03-02T08:59:30.000Z', created_at: '2026-01-04T00:00:00.000Z', user_id: USER, service_account_id: null, company_id: COMPANY },
              { id: 'key-manual', name: 'Nattjobbet', client: null, last_used_at: null, created_at: '2026-01-05T00:00:00.000Z', user_id: USER, service_account_id: null, company_id: COMPANY },
            ],
          }
        : { data: [] },
    event_log: {
      data: [
        { created_at: '2026-03-02T08:59:30.000Z', actor_id: 'key-claude' },
        { created_at: '2026-03-02T08:10:00.000Z', actor_id: 'key-claude' },
        { created_at: '2026-03-01T20:00:00.000Z', actor_id: 'key-claude' },
      ],
    },
    ...over,
  }
}

const OK_QUEUE = {
  as_of: '2026-03-02',
  counts: { unexplained: 1, cannot_check: 1, ok: 1 },
  truncated: 0,
  items: [
    {
      check_id: 'unbooked_bank_lines_overdue',
      name_sv: 'Obokförda banktransaktioner efter sista bokföringsdag',
      status: 'unexplained',
      subject: { kind: 'company' },
      difference: 5,
      unit: 'count',
      as_of: '2026-03-02',
      summary_sv: '5 rader',
      refusal_code: null,
      next: { tool: 'x', screen: '/transactions' },
      explain: {},
    },
    {
      check_id: 'skattekonto_vs_skatteverket',
      name_sv: 'Skattekontot mot Skatteverkets saldo',
      status: 'cannot_check',
      subject: { kind: 'company' },
      difference: null,
      unit: 'SEK',
      as_of: '2026-03-02',
      summary_sv: 'Inte kopplat',
      refusal_code: 'SKATTEKONTO_NOT_CONNECTED',
      next: null,
      explain: {},
    },
    {
      check_id: 'bank_balance_vs_bank',
      name_sv: 'Bokfört banksaldo mot bankens saldo',
      status: 'ok',
      subject: { kind: 'bank_account', cash_account_id: 'cash-1', handle: null, account_number: '1930', name: 'Företagskonto' },
      difference: 0,
      unit: 'SEK',
      as_of: '2026-03-02',
      summary_sv: 'Stämmer',
      refusal_code: null,
      next: null,
      explain: {},
    },
  ],
}

const FEED_OK = { bank: { feed_status: 'active', last_sync_at: '2026-03-02T05:12:00.000Z', stale: false, reconciled_through: null } }

const skatteverket = vi.fn()
const ports = () => ({ skatteverket })

function sourceOf(picture: { sources: PictureSourceGroup[] }, id: string): PictureSource | undefined {
  return picture.sources.flatMap((g) => g.items).find((item) => item.id === id)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('RESEND_INBOUND_DOMAIN', 'inbox.example')
  enabled.clear()
  for (const id of ALL_EXTENSIONS) enabled.add(id)
  service = fakeSupabase({ api_key_companies: { data: [] }, oauth_partner_clients: { data: [] } })
  listUnexplainedMock.mockResolvedValue(OK_QUEUE)
  dataStatusMock.mockResolvedValue(FEED_OK)
  inboxAddressMock.mockResolvedValue('exempel-ab12@inbox.example')
  skillRowsMock.mockResolvedValue([])
  skatteverket.mockResolvedValue({ state: 'connected', last_sync_at: '2026-03-01T21:14:00.000Z' })
})

describe('loadAgentPicture: sources', () => {
  it('lists a connected bank account by its bank, with only the last four characters of the account', async () => {
    const { client } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'bank:cash-1')).toEqual({
      id: 'bank:cash-1',
      key: 'bank',
      name: 'SEB',
      detail: 'Företagskonto',
      tail: '7466',
      count: null,
      state: 'connected',
      last_delivered_at: '2026-03-02T05:12:00.000Z',
      logo: '/logos/banks/seb.png',
      href: '/settings/banking',
    })
    // The account number itself never leaves the server.
    expect(JSON.stringify(picture)).not.toContain('5000')
    expect(JSON.stringify(picture)).not.toContain('0583')
  })

  it('shows a stopped connection as needing attention and leaves a revoked one out', async () => {
    const row = (id: string, status: string) => ({ id, name: 'Konto', iban: 'SE4550000000058398257466', kind: 'bank', bank_connection_id: id, bank_connection: { bank_name: 'Nordea', status, last_synced_at: null } })
    const { client } = fakeSupabase(tables({ cash_accounts: { data: [row('a', 'expired'), row('b', 'revoked'), row('c', 'error')] } }))
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    const bank = picture.sources.find((g) => g.id === 'bank')!.items
    expect(bank.map((item) => [item.id, item.state])).toEqual([
      ['bank:a', 'needs_attention'],
      ['bank:c', 'needs_attention'],
    ])
  })

  it('offers the bank when no account is connected, and says unknown when the read fails', async () => {
    const none = await loadAgentPicture(fakeSupabase(tables({ cash_accounts: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(none, 'bank')).toMatchObject({ state: 'not_connected', href: '/settings/banking' })

    const broken = await loadAgentPicture(fakeSupabase(tables({ cash_accounts: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(broken, 'bank')).toMatchObject({ state: 'unknown' })
    // The rest still answers.
    expect(sourceOf(broken, 'skatteverket')).toMatchObject({ state: 'connected' })
    expect(broken.company.counts.vouchers).toBe(4912)
  })

  it('reads Skatteverket through the port and Bolagsverket from the stored register data', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'skatteverket')).toMatchObject({ state: 'connected', last_delivered_at: '2026-03-01T21:14:00.000Z', href: '/settings/skatteverket' })
    expect(sourceOf(picture, 'bolagsverket')).toMatchObject({ state: 'connected', last_delivered_at: '2026-02-14T10:00:00.000Z', href: '/settings/company' })
    const register = calls.find((c) => c.table === 'companies' && c.ops.some((op) => op.method === 'not'))!
    expect(filtered(register, 'eq', 'id', COMPANY)).toBe(true)
    expect(register.ops.find((op) => op.method === 'not')!.args).toEqual(['tic_snapshot', 'is', null])
  })

  it('says unknown for Skatteverket when the port fails or is not wired, never not connected', async () => {
    skatteverket.mockRejectedValue(new Error('down'))
    const failed = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(failed, 'skatteverket')).toMatchObject({ state: 'unknown' })

    const unwired = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, {}, NOW)
    expect(sourceOf(unwired, 'skatteverket')).toMatchObject({ state: 'unknown' })
  })

  it('offers Bolagsverket when the company holds no register data', async () => {
    const companies: Handler = (call) => (call.ops.some((op) => op.method === 'select' && op.args[0] === 'name') ? { data: { name: 'X' } } : { data: null })
    const picture = await loadAgentPicture(fakeSupabase(tables({ companies })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'bolagsverket')).toMatchObject({ state: 'not_connected' })
  })

  it('counts the documents that came through the inbox address this calendar year', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'inbox')).toMatchObject({
      state: 'connected',
      detail: 'exempel-ab12@inbox.example',
      count: 86,
      last_delivered_at: '2026-02-28T08:00:00.000Z',
    })
    const count = calls.find((c) => c.table === 'invoice_inbox_items' && c.ops.some((op) => op.method === 'gte'))!
    expect(filtered(count, 'eq', 'source', 'email')).toBe(true)
    // New Year's midnight in Stockholm.
    expect(count.ops.find((op) => op.method === 'gte')!.args).toEqual(['created_at', '2025-12-31T23:00:00.000Z'])
  })

  it('leaves the inbox out where the installation receives no mail', async () => {
    vi.stubEnv('RESEND_INBOUND_DOMAIN', '')
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'inbox')).toBeUndefined()
    expect(inboxAddressMock).not.toHaveBeenCalled()
  })

  it('shows the signed-in person\'s WhatsApp link by its masked number', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'whatsapp')).toMatchObject({ state: 'connected', detail: '+46 70 *** ** 34', last_delivered_at: '2026-03-01T12:00:00.000Z' })
    const link = calls.find((c) => c.table === 'whatsapp_phone_links')!
    expect(filtered(link, 'eq', 'user_id', USER)).toBe(true)
    expect(link.ops.find((op) => op.method === 'select')!.args[0]).toBe('phone_masked, last_message_at')
  })

  it('shows Kivra where the company receives through it', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'kivra')).toMatchObject({ state: 'connected', last_delivered_at: '2026-03-01T03:00:00.000Z' })
    expect(sourceOf(picture, 'billo')).toBeUndefined()
  })

  it('shows every connected sales source and at most two that are not connected', async () => {
    const picture = await loadAgentPicture(
      fakeSupabase(
        tables({
          whatsapp_phone_links: { data: null },
          shopify_connections: { data: [{ id: 's' }] },
          pos_connections: { data: [{ venue_name: 'Butiken', provider_name: 'Kassa', health: 'ok' }] },
        }),
      ).client,
      COMPANY,
      USER,
      ports(),
      NOW,
    )
    expect(sourceOf(picture, 'shopify')).toMatchObject({ state: 'connected' })
    expect(sourceOf(picture, 'pos')).toMatchObject({ state: 'connected', detail: 'Butiken (Kassa)' })
    const off = picture.sources.flatMap((g) => g.items).filter((item) => item.state === 'not_connected')
    // Stripe and WhatsApp come first in the order; WooCommerce and Zettle are left out.
    expect(off.map((item) => item.key).sort()).toEqual(['stripe', 'whatsapp'])
  })

  it('leaves out a source whose extension is not built in', async () => {
    enabled.delete('stripe')
    enabled.delete('skatteverket')
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'stripe')).toBeUndefined()
    expect(sourceOf(picture, 'skatteverket')).toBeUndefined()
    expect(calls.some((c) => c.table === 'stripe_connections')).toBe(false)
    expect(skatteverket).not.toHaveBeenCalled()
  })

  it('leaves out a sales source whose read failed instead of calling it not connected', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ stripe_connections: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(picture, 'stripe')).toBeUndefined()
  })
})

describe('limitNotConnected', () => {
  const item = (key: PictureSource['key'], state: PictureSource['state']): PictureSource => ({ id: key, key, name: null, detail: null, tail: null, count: null, state, last_delivered_at: null, logo: null, href: '/' })

  it('keeps what is connected, the bank and the authorities, and drops empty groups', () => {
    const groups = limitNotConnected([
      { id: 'bank', items: [item('bank', 'not_connected')] },
      { id: 'authorities', items: [item('skatteverket', 'not_connected'), item('bolagsverket', 'not_connected')] },
      { id: 'documents', items: [] },
      { id: 'sales', items: [item('zettle', 'not_connected'), item('woocommerce', 'not_connected'), item('stripe', 'not_connected'), item('pos', 'connected')] },
    ])
    expect(groups.map((g) => g.id)).toEqual(['bank', 'authorities', 'sales'])
    expect(groups[2].items.map((i) => i.key)).toEqual(['woocommerce', 'stripe', 'pos'])
  })
})

describe('loadAgentPicture: the company', () => {
  it('counts verifikat, bank rows, documents, customers and suppliers for the company', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(picture.company.name).toBe('Exempelbolaget AB')
    expect(picture.company.counts).toEqual({ vouchers: 4912, bank_rows: 1311, documents: 86, customers: 38, suppliers: 64 })
    const vouchers = calls.find((c) => c.table === 'journal_entries')!
    expect(vouchers.ops.find((op) => op.method === 'in')!.args).toEqual(['status', ['posted', 'reversed']])
    expect(filtered(calls.find((c) => c.table === 'document_attachments')!, 'eq', 'admission_state', 'admitted')).toBe(true)
  })

  it('answers a failed count as unknown and keeps the others', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ transactions: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.counts).toEqual({ vouchers: 4912, bank_rows: null, documents: 86, customers: 38, suppliers: 64 })
  })

  it('counts the remembered facts the briefing sends: active and not replaced', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(picture.company.memory_facts).toBe(23)
    const memory = calls.find((c) => c.table === 'agent_memory')!
    expect(filtered(memory, 'eq', 'is_active', true)).toBe(true)
    expect(memory.ops.find((op) => op.method === 'is')!.args).toEqual(['superseded_by', null])

    const broken = await loadAgentPicture(fakeSupabase(tables({ agent_memory: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(broken.company.memory_facts).toBeNull()
  })

  it('counts the knowledge items of the profile that are live, the installed ones and the company\'s own', async () => {
    skillRowsMock.mockResolvedValue([
      { id: 'i1', atom_id: 'community/x', name: null, body: null },
      { id: 'o1', atom_id: null, name: 'Vårt sätt', body: 'text', draft: false },
      { id: 'o2', atom_id: null, name: 'Utkast', body: 'text', draft: true },
    ])
    const { client, calls } = fakeSupabase(tables({ agent_atom_registry: { count: 4 } }))
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    // Four live registry items and one own item a person has added; the draft is not counted.
    expect(picture.company.knowledge.rule_areas).toBe(5)
    const registry = calls.find((c) => c.table === 'agent_atom_registry')!
    expect(registry.ops.find((op) => op.method === 'in')!.args).toEqual(['id', ['horizontal/a', 'horizontal/b', 'vertical/c', 'community/x']])
    expect(filtered(registry, 'eq', 'is_active', true)).toBe(true)
    expect(filtered(registry, 'eq', 'mcp_exposed', true)).toBe(true)
  })

  it('names the curated workflows and says unknown when the knowledge cannot be counted', async () => {
    skillRowsMock.mockRejectedValue(new Error('boom'))
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.knowledge.rule_areas).toBeNull()
    expect(picture.company.knowledge.workflows).toContain('month-end-close')
    expect(picture.company.knowledge.workflows).toHaveLength(10)
  })
})

describe('loadAgentPicture: checks', () => {
  it('carries each result of the unexplained queue as the check answered it', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    const checks = picture.company.checks!
    expect(listUnexplainedMock).toHaveBeenCalledWith({ supabase: expect.anything(), companyId: COMPANY }, { today: '2026-03-02' })
    expect(checks.queue_unavailable).toBe(false)
    expect(checks.lines.find((l) => l.check_id === 'unbooked_bank_lines_overdue')).toEqual({
      id: 'unbooked_bank_lines_overdue:company',
      check_id: 'unbooked_bank_lines_overdue',
      name_sv: 'Obokförda banktransaktioner efter sista bokföringsdag',
      name_en: 'EN unbooked_bank_lines_overdue',
      subject: null,
      status: 'attention',
      difference: 5,
      unit: 'count',
      things: 5,
      as_of: '2026-03-02',
      href: '/transactions',
      reason_code: null,
    })
    expect(checks.lines.find((l) => l.check_id === 'skattekonto_vs_skatteverket')).toMatchObject({
      status: 'unknown',
      reason_code: 'SKATTEKONTO_NOT_CONNECTED',
      href: null,
      things: null,
    })
    expect(checks.lines.find((l) => l.check_id === 'bank_balance_vs_bank')).toMatchObject({
      id: 'bank_balance_vs_bank:cash-1',
      status: 'agrees',
      subject: 'Företagskonto',
      difference: null,
    })
  })

  it('adds the bank feed from the report data status, read over the fiscal year up to today', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(dataStatusMock).toHaveBeenCalledWith(expect.anything(), COMPANY, { periodId: 'period-1', toDate: '2026-03-02', now: NOW })
    const checks = picture.company.checks!
    expect(checks.lines.at(-1)).toMatchObject({ check_id: 'bank_feed', status: 'agrees', as_of: '2026-03-02T05:12:00.000Z', href: null })
    // The queue's own counts plus the bank feed.
    expect(checks.counts).toEqual({ agrees: 2, attention: 1, unknown: 1 })
    const period = calls.find((c) => c.table === 'fiscal_periods')!
    expect(period.ops.find((op) => op.method === 'lte')!.args).toEqual(['period_start', '2026-03-02'])
    expect(period.ops.find((op) => op.method === 'gte')!.args).toEqual(['period_end', '2026-03-02'])
  })

  it('puts a stopped or stale bank feed first, with where it is handled', async () => {
    dataStatusMock.mockResolvedValue({ bank: { feed_status: 'active', last_sync_at: '2026-02-20T05:00:00.000Z', stale: true, reconciled_through: null } })
    const stale = (await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)).company.checks!
    expect(stale.lines[0]).toMatchObject({ check_id: 'bank_feed', status: 'attention', things: 1, href: '/settings/banking' })

    dataStatusMock.mockResolvedValue({ bank: { feed_status: 'stopped', last_sync_at: null, stale: false, reconciled_through: null } })
    const stopped = (await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)).company.checks!
    expect(stopped.lines[0]).toMatchObject({ check_id: 'bank_feed', status: 'attention' })
  })

  it('has no bank feed line for a company without a feed or without a fiscal year covering today', async () => {
    dataStatusMock.mockResolvedValue({ bank: { feed_status: null, last_sync_at: null, stale: false, reconciled_through: null } })
    const noFeed = (await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)).company.checks!
    expect(noFeed.lines.some((l) => l.check_id === 'bank_feed')).toBe(false)

    const noYear = (await loadAgentPicture(fakeSupabase(tables({ fiscal_periods: { data: [] } })).client, COMPANY, USER, ports(), NOW)).company.checks!
    expect(noYear.lines.some((l) => l.check_id === 'bank_feed')).toBe(false)
    expect(dataStatusMock).toHaveBeenCalledTimes(1)
  })

  it('says could not be checked when the data status is unavailable', async () => {
    dataStatusMock.mockResolvedValue({ unavailable: true, reason: 'x' })
    const checks = (await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)).company.checks!
    expect(checks.lines.find((l) => l.check_id === 'bank_feed')).toMatchObject({ status: 'unknown' })
    expect(checks.counts.unknown).toBe(2)
  })

  it('runs the queue through the door\'s ledger read, and keeps the bank feed when the queue cannot be read', async () => {
    const ledgerRead = vi.fn(async <T,>(read: () => Promise<T>) => read())
    await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, { ...ports(), ledgerRead }, NOW)
    expect(ledgerRead).toHaveBeenCalledTimes(1)

    const refused = vi.fn(async () => {
      throw new Error('import in progress')
    })
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, { ...ports(), ledgerRead: refused }, NOW)
    const checks = picture.company.checks!
    expect(listUnexplainedMock).toHaveBeenCalledTimes(1)
    expect(checks.queue_unavailable).toBe(true)
    expect(checks.lines.map((l) => l.check_id)).toEqual(['bank_feed'])
    expect(checks.counts).toEqual({ agrees: 1, attention: 0, unknown: 1 })
  })

  it('answers no checks at all as unknown, and the rest of the picture still renders', async () => {
    listUnexplainedMock.mockRejectedValue(new Error('boom'))
    const picture = await loadAgentPicture(fakeSupabase(tables({ fiscal_periods: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.checks).toBeNull()
    expect(picture.company.counts.vouchers).toBe(4912)
    expect(picture.agents?.list).toHaveLength(2)
  })
})

describe('loadAgentPicture: agents', () => {
  it('lists the company\'s connections with what each did today', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list).toEqual([
      { id: 'key-claude', kind: 'claude', name: null, last_used_at: '2026-03-02T08:59:30.000Z', calls_today: 2, last_call_at: '2026-03-02T08:59:30.000Z' },
      { id: 'key-manual', kind: 'key', name: 'Nattjobbet', last_used_at: null, calls_today: 0, last_call_at: null },
    ])
    expect(picture.agents!.more).toBe(0)
    expect(picture.agents!.activity).toMatchObject({ day: '2026-03-02', now: NOW.toISOString(), capped: false })
  })

  it('reads only live keys, and the person\'s own keys by user', async () => {
    const { client, calls } = fakeSupabase(tables())
    await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    const keyReads = calls.filter((c) => c.table === 'api_keys')
    expect(keyReads).toHaveLength(2)
    for (const read of keyReads) expect(read.ops.find((op) => op.method === 'is')!.args).toEqual(['revoked_at', null])
    expect(keyReads.filter((c) => filtered(c, 'eq', 'company_id', COMPANY))).toHaveLength(1)
    expect(keyReads.filter((c) => filtered(c, 'eq', 'user_id', USER))).toHaveLength(1)
  })

  it('adds the person\'s own connection homed in another company when it reaches this one', async () => {
    const elsewhere = (id: string) => ({ id, name: OAUTH_KEY_NAME, client: 'chatgpt', last_used_at: null, created_at: '2026-01-01T00:00:00.000Z', user_id: USER, service_account_id: null, company_id: 'company-2' })
    const api_keys: Handler = (call) => (filtered(call, 'eq', 'company_id') ? { data: [] } : { data: [elsewhere('open'), elsewhere('listed'), elsewhere('other')] })
    service = fakeSupabase({
      api_key_companies: {
        data: [
          { api_key_id: 'listed', company_id: COMPANY },
          { api_key_id: 'other', company_id: 'company-3' },
        ],
      },
    })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys })).client, COMPANY, USER, ports(), NOW)
    // No company list reaches every company; a list reaches the ones on it.
    expect(picture.agents!.list.map((a) => a.id).sort()).toEqual(['listed', 'open'])
    expect(picture.agents!.list[0].kind).toBe('chatgpt')
    const lists = service.calls.find((c) => c.table === 'api_key_companies')!
    expect(lists.ops.find((op) => op.method === 'in')!.args).toEqual(['api_key_id', ['open', 'listed', 'other']])
  })

  it('leaves out connections homed elsewhere when their company lists cannot be read', async () => {
    const api_keys: Handler = (call) =>
      filtered(call, 'eq', 'company_id')
        ? { data: [] }
        : { data: [{ id: 'open', name: OAUTH_KEY_NAME, client: 'claude', last_used_at: null, created_at: '2026-01-01T00:00:00.000Z', user_id: USER, service_account_id: null, company_id: 'company-2' }] }
    service = fakeSupabase({ api_key_companies: { error: { message: 'boom' } } })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list).toEqual([])
  })

  it('lists six connections, the ones that worked last first, and counts the rest', async () => {
    const key = (n: number) => ({ id: `k${n}`, name: `Nyckel ${n}`, client: null, last_used_at: `2026-02-0${n}T00:00:00.000Z`, created_at: '2026-01-01T00:00:00.000Z', user_id: USER, service_account_id: null, company_id: COMPANY })
    const api_keys: Handler = (call) => (filtered(call, 'eq', 'company_id') ? { data: [1, 2, 3, 4, 5, 6, 7, 8].map(key) } : { data: [] })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list.map((a) => a.id)).toEqual(['k8', 'k7', 'k6', 'k5', 'k4', 'k3'])
    expect(picture.agents!.more).toBe(2)
  })

  it('keeps the connections when the tool call log cannot be read, and says the activity is unknown', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ event_log: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.activity).toBeNull()
    expect(picture.agents!.list.map((a) => a.id)).toEqual(['key-claude', 'key-manual'])
  })

  it('answers unknown agents when the connections cannot be read, and the rest still renders', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents).toBeNull()
    expect(picture.company.name).toBe('Exempelbolaget AB')
    expect(sourceOf(picture, 'bank:cash-1')).toBeDefined()
  })
})

describe('loadAgentPicture: the whole answer', () => {
  it('filters every read on the company, with the named exceptions', async () => {
    const { client, calls } = fakeSupabase(tables())
    await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(calls.length).toBeGreaterThan(15)
    for (const call of calls) {
      const byCompany = filtered(call, 'eq', 'company_id', COMPANY)
      if (call.table === 'companies') expect(filtered(call, 'eq', 'id', COMPANY)).toBe(true)
      else if (call.table === 'whatsapp_phone_links') expect(filtered(call, 'eq', 'user_id', USER)).toBe(true)
      else if (call.table === 'agent_atom_registry') expect(byCompany).toBe(false)
      else if (call.table === 'api_keys') expect(byCompany || filtered(call, 'eq', 'user_id', USER)).toBe(true)
      else expect(byCompany, `${call.table} is read without the company filter`).toBe(true)
    }
  })

  it('answers a part that runs past its deadline as unknown', async () => {
    vi.useFakeTimers()
    try {
      const never = () => new Promise<Answer>(() => {})
      const { client } = fakeSupabase(tables({ journal_entries: never, api_keys: never }))
      const pending = loadAgentPicture(client, COMPANY, USER, ports(), NOW)
      await vi.advanceTimersByTimeAsync(7000)
      const picture = await pending
      expect(picture.company.counts).toEqual({ vouchers: null, bank_rows: null, documents: null, customers: null, suppliers: null })
      expect(picture.agents).toBeNull()
      // The parts that answered are there.
      expect(picture.company.name).toBe('Exempelbolaget AB')
      expect(picture.company.memory_facts).toBe(23)
      expect(sourceOf(picture, 'bank:cash-1')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('loadAgentActivity', () => {
  it('counts today\'s calls per connection by the Stockholm day and keeps each one\'s last call', async () => {
    const { client, calls } = fakeSupabase({
      event_log: {
        data: [
          { created_at: '2026-03-02T08:59:30.000Z', actor_id: 'a' },
          { created_at: '2026-03-02T08:00:00.000Z', actor_id: 'b' },
          // 23:30 UTC the day before is 00:30 in Stockholm: today.
          { created_at: '2026-03-01T23:30:00.000Z', actor_id: 'a' },
          { created_at: '2026-03-01T22:30:00.000Z', actor_id: 'a' },
          { created_at: '2026-03-01T10:00:00.000Z', actor_id: 'c' },
          { created_at: '2026-03-01T09:00:00.000Z', actor_id: null },
        ],
      },
    })
    const activity = await loadAgentActivity(client, COMPANY, NOW)
    expect(activity).toEqual({
      now: NOW.toISOString(),
      day: '2026-03-02',
      capped: false,
      actors: {
        a: { calls_today: 2, last_call_at: '2026-03-02T08:59:30.000Z' },
        b: { calls_today: 1, last_call_at: '2026-03-02T08:00:00.000Z' },
        c: { calls_today: 0, last_call_at: '2026-03-01T10:00:00.000Z' },
      },
    })
    expect(calls).toHaveLength(1)
    const read = calls[0]
    expect(filtered(read, 'eq', 'company_id', COMPANY)).toBe(true)
    expect(filtered(read, 'eq', 'event_type', 'mcp.tool_called')).toBe(true)
    // Only the time and who called: no tool arguments, no results.
    expect(read.ops.find((op) => op.method === 'select')!.args[0]).toBe('created_at, actor_id:data->>actorId')
    expect(read.ops.find((op) => op.method === 'order')!.args).toEqual(['sequence', { ascending: false }])
    expect(read.ops.find((op) => op.method === 'range')!.args).toEqual([0, 199])
  })

  it('reads on while a whole page is from today, and says so when it stops short', async () => {
    const page = (minute: number) => Array.from({ length: 200 }, (_, i) => ({ created_at: new Date(Date.parse('2026-03-02T08:00:00.000Z') - (minute * 200 + i) * 1000).toISOString(), actor_id: 'a' }))
    const { client, calls } = fakeSupabase({ event_log: (call) => ({ data: page((call.ops.find((op) => op.method === 'range')!.args[0] as number) / 200) }) })
    const activity = await loadAgentActivity(client, COMPANY, NOW)
    expect(calls).toHaveLength(5)
    expect(calls.map((c) => c.ops.find((op) => op.method === 'range')!.args)).toEqual([[0, 199], [200, 399], [400, 599], [600, 799], [800, 999]])
    expect(activity.actors.a.calls_today).toBe(1000)
    expect(activity.capped).toBe(true)
  })

  it('throws when the log cannot be read', async () => {
    const { client } = fakeSupabase({ event_log: { error: { message: 'boom' } } })
    await expect(loadAgentActivity(client, COMPANY, NOW)).rejects.toThrow('tool call log read failed: boom')
  })
})
