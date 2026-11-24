/**
 * The agent picture's loader: each part, each part's failure leaving the
 * rest, the company filter on every read, and what is masked.
 *
 * The Supabase client is the table mock from tests/helpers: a table's
 * handler answers when a chain is awaited, and sees the calls of that chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

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

/**
 * The table mock from tests/helpers, with one addition: every awaited chain
 * is kept whole (its table and its calls), so a test can ask what one read
 * filtered on.
 */
function fakeSupabase(tables: Record<string, Handler>) {
  const calls: Call[] = []
  const resolvers = Object.fromEntries(
    Object.entries(tables).map(([table, handler]): [string, TableMockResolver] => [
      table,
      (ops) => {
        const call: Call = { table, ops }
        calls.push(call)
        return typeof handler === 'function' ? handler(call) : handler
      },
    ]),
  )
  const mock = createTableMockSupabase(resolvers)
  return { client: mock.supabase as unknown as SupabaseClient, calls, tablesRead: () => [...new Set(mock.tables())] }
}

const filtered = (call: Call, method: string, column: string, value?: unknown) =>
  call.ops.some((op) => op.method === method && op.args[0] === column && (value === undefined || op.args[1] === value))

const { listUnexplainedMock, dataStatusMock, inboxAddressMock, mailboxAvailabilityMock, enabled } = vi.hoisted(() => ({
  listUnexplainedMock: vi.fn(),
  dataStatusMock: vi.fn(),
  inboxAddressMock: vi.fn(),
  mailboxAvailabilityMock: vi.fn(),
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
vi.mock('@/lib/digital-mailboxes/providers', () => ({
  digitalMailboxAvailability: (...args: unknown[]) => mailboxAvailabilityMock(...args),
}))

import { loadKnowledgeOptions } from '@/lib/agent-skills/knowledge-choices'
import { limitNotConnected, loadAgentActivity, loadAgentCards, loadAgentPicture, type AgentPicturePorts, type PictureSource, type PictureSourceGroup } from '../agent-picture'

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
    companies: (call) => {
      const columns = call.ops.find((op) => op.method === 'select')?.args[0]
      if (columns === 'name') return { data: { name: 'Exempelbolaget AB' } }
      // The company's legal form, and the team it belongs to (none here).
      if (typeof columns === 'string' && (columns.includes('entity_type') || columns.includes('team_id'))) return { data: { entity_type: 'aktiebolag', team_id: null } }
      return { data: { tic_snapshot_fetched_at: '2026-02-14T10:00:00.000Z' } }
    },
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
    agent_profiles: { data: { vertical_atoms: ['vertical/retired', 'vertical/konsult-it'], modifier_atoms: null } },
    agent_atom_registry: { data: REGISTRY },
    company_skills: { data: [] },
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
    company_questions: { data: [] },
    pending_operations: { data: [] },
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

interface RegistryRow {
  id: string
  tier: string
  title: string
  description: string
  version: number
  reviewed_at: string | null
}
const registryRow = (id: string, tier: string): RegistryRow => ({ id, tier, title: id, description: '', version: 1, reviewed_at: null })
/** The registry: five of the product's own items and one the community shared. */
const REGISTRY: RegistryRow[] = [
  registryRow('horizontal/swedish-vat', 'horizontal'),
  registryRow('horizontal/swedish-payroll', 'horizontal'),
  registryRow('modifier/holding-ab', 'modifier'),
  registryRow('vertical/konsult-it', 'vertical'),
  registryRow('vertical/e-handel', 'vertical'),
  registryRow('community/shared', 'community'),
]

const FEED_OK = { bank: { feed_status: 'active', last_sync_at: '2026-03-02T05:12:00.000Z', stale: false, reconciled_through: null } }

const skatteverket = vi.fn()
const ports = () => ({ skatteverket })

function sourceOf(picture: { sources: PictureSourceGroup[] }, id: string): PictureSource | undefined {
  return picture.sources.flatMap((g) => g.items).find((item) => item.id === id)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('RESEND_INBOUND_DOMAIN', 'inbox.example')
  vi.stubEnv('INKORG_V2_COMPANY_IDS', '')
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  enabled.clear()
  for (const id of ALL_EXTENSIONS) enabled.add(id)
  service = fakeSupabase({ api_key_companies: { data: [] }, oauth_partner_clients: { data: [] } })
  listUnexplainedMock.mockResolvedValue(OK_QUEUE)
  dataStatusMock.mockResolvedValue(FEED_OK)
  inboxAddressMock.mockResolvedValue('exempel-ab12@inbox.example')
  mailboxAvailabilityMock.mockReturnValue({ kivra: { receive: true, send: false }, billo: { receive: true, send: false } })
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

  it('leads the inbox card to the workspace for a company outside the new inbox page\'s rollout', async () => {
    const outside = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(outside, 'inbox')).toMatchObject({ state: 'connected', href: '/e/general/invoice-inbox' })
    // Another company's place in the rollout moves nothing for this one.
    vi.stubEnv('INKORG_V2_COMPANY_IDS', 'company-2')
    const other = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(other, 'inbox')?.href).toBe('/e/general/invoice-inbox')
  })

  it('leads the inbox card to the new inbox page for a company in its rollout, whatever the card says', async () => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', `company-2, ${COMPANY}`)
    const connected = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(connected, 'inbox')).toMatchObject({ state: 'connected', detail: 'exempel-ab12@inbox.example', href: '/inkorg' })
    inboxAddressMock.mockResolvedValue(null)
    const off = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(off, 'inbox')).toMatchObject({ state: 'not_connected', href: '/inkorg' })
    inboxAddressMock.mockRejectedValue(new Error('address read failed'))
    const unknown = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(unknown, 'inbox')).toMatchObject({ state: 'unknown', href: '/inkorg' })
    // No other card moves with it.
    expect(sourceOf(connected, 'skatteverket')?.href).toBe('/settings/skatteverket')
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

  it('offers a cash register only where the installation has a connector for one', async () => {
    const withConnector: AgentPicturePorts = { ...ports(), posConnector: () => true }
    const offered = await loadAgentPicture(fakeSupabase(tables({ whatsapp_phone_links: { data: null } })).client, COMPANY, USER, withConnector, NOW)
    expect(sourceOf(offered, 'pos')).toMatchObject({ state: 'not_connected', href: '/settings/pos' })

    // Without a connector there is nothing to connect it through: no card says "not connected".
    const withoutConnector: AgentPicturePorts = { ...ports(), posConnector: () => false }
    const neither: AgentPicturePorts[] = [withoutConnector, ports()]
    for (const given of neither) {
      const picture = await loadAgentPicture(fakeSupabase(tables({ whatsapp_phone_links: { data: null } })).client, COMPANY, USER, given, NOW)
      expect(sourceOf(picture, 'pos')).toBeUndefined()
    }

    // A venue that is connected shows either way.
    const pos_connections = { data: [{ venue_name: 'Butiken', provider_name: 'Kassa', health: 'ok' }] }
    const connected = await loadAgentPicture(fakeSupabase(tables({ pos_connections })).client, COMPANY, USER, withoutConnector, NOW)
    expect(sourceOf(connected, 'pos')).toMatchObject({ state: 'connected', detail: 'Butiken (Kassa)' })
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

  /** Every source's own read, failed: none may then read as not connected, and none may go missing. */
  const BROKEN: Record<string, Handler> = {
    whatsapp_phone_links: { error: { message: 'boom' } },
    digital_mailbox_connections: { error: { message: 'boom' } },
    mail_connections: { error: { message: 'boom' } },
    stripe_connections: { error: { message: 'boom' } },
    pos_connections: { error: { message: 'boom' } },
    shopify_connections: { error: { message: 'boom' } },
    woocommerce_connections: { error: { message: 'boom' } },
    zettle_connections: { error: { message: 'boom' } },
  }
  const READ_FAILED: Array<PictureSource['key']> = ['whatsapp', 'kivra', 'billo', 'gmail', 'stripe', 'pos', 'shopify', 'woocommerce', 'zettle']

  it('shows a source whose status could not be read as unknown: not as not connected, and not left out', async () => {
    enabled.add('mail')
    const withConnector: AgentPicturePorts = { ...ports(), posConnector: () => true }
    const picture = await loadAgentPicture(fakeSupabase(tables(BROKEN)).client, COMPANY, USER, withConnector, NOW)
    for (const key of READ_FAILED) expect(sourceOf(picture, key), key).toMatchObject({ key, state: 'unknown', detail: null, last_delivered_at: null })
    // Nothing is offered to connect while it is not known what is connected.
    expect(picture.sources.flatMap((g) => g.items).filter((item) => item.state === 'not_connected')).toEqual([])
    // The sources whose reads answered are as they were.
    expect(sourceOf(picture, 'bank:cash-1')).toMatchObject({ state: 'connected' })
    expect(sourceOf(picture, 'inbox')).toMatchObject({ state: 'connected' })
  })

  it('shows each of them as unknown when its read alone fails, and the others as they are', async () => {
    const stripe = await loadAgentPicture(fakeSupabase(tables({ stripe_connections: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(stripe, 'stripe')).toMatchObject({ state: 'unknown', href: '/import?mode=stripe' })
    expect(sourceOf(stripe, 'kivra')).toMatchObject({ state: 'connected' })

    const whatsapp = await loadAgentPicture(fakeSupabase(tables({ whatsapp_phone_links: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(whatsapp, 'whatsapp')).toMatchObject({ state: 'unknown', detail: null })
  })

  it('shows Kivra and Billo as unknown only where the company is offered to receive through them', async () => {
    const broken = { digital_mailbox_connections: { error: { message: 'boom' } } }
    mailboxAvailabilityMock.mockReturnValue({ kivra: { receive: true, send: false }, billo: { receive: false, send: false } })
    const one = await loadAgentPicture(fakeSupabase(tables(broken)).client, COMPANY, USER, ports(), NOW)
    expect(mailboxAvailabilityMock).toHaveBeenCalledWith(COMPANY)
    expect(sourceOf(one, 'kivra')).toMatchObject({ state: 'unknown' })
    expect(sourceOf(one, 'billo')).toBeUndefined()

    // A read that answers reads no availability: the connections say what there is.
    mailboxAvailabilityMock.mockClear()
    await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(mailboxAvailabilityMock).not.toHaveBeenCalled()
  })

  it('keeps a source that answered nothing as it was: no mail and no venue is no card, and a cash register without a connector is not read as unknown', async () => {
    enabled.add('mail')
    const none = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(none, 'gmail')).toBeUndefined()
    expect(sourceOf(none, 'pos')).toBeUndefined()
    const failedWithoutConnector = await loadAgentPicture(fakeSupabase(tables({ pos_connections: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(failedWithoutConnector, 'pos')).toBeUndefined()
  })

  it('tells an inbox that could not be read from a company without one', async () => {
    // The address's own reader answers nothing for both.
    inboxAddressMock.mockResolvedValue(null)
    const without = fakeSupabase(tables({ company_inboxes: { data: [] } }))
    expect(sourceOf(await loadAgentPicture(without.client, COMPANY, USER, ports(), NOW), 'inbox')).toMatchObject({ state: 'not_connected' })
    const asked = without.calls.find((c) => c.table === 'company_inboxes')!
    expect(filtered(asked, 'eq', 'company_id', COMPANY)).toBe(true)
    expect(filtered(asked, 'eq', 'status', 'active')).toBe(true)

    const unreadable = await loadAgentPicture(fakeSupabase(tables({ company_inboxes: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(unreadable, 'inbox')).toMatchObject({ state: 'unknown' })

    // The company has an inbox, and its address was not read.
    const addressFailed = await loadAgentPicture(fakeSupabase(tables({ company_inboxes: { data: [{ id: 'inbox-1' }] } })).client, COMPANY, USER, ports(), NOW)
    expect(sourceOf(addressFailed, 'inbox')).toMatchObject({ state: 'unknown' })
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

  it('says what waits on the company\'s people from the door\'s counters, and nothing when they are not wired or fail', async () => {
    const waiting = vi.fn().mockResolvedValue({ questions: 2, proposals: 3 })
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, { ...ports(), waiting }, NOW)
    expect(picture.company.waiting).toEqual({ questions: 2, proposals: 3 })
    expect(waiting).toHaveBeenCalledTimes(1)
    // The loader counts nothing itself: no count of open questions or waiting proposals is read here.
    expect(calls.filter((c) => c.table === 'company_questions' || c.table === 'pending_operations').every((c) => c.ops.some((op) => op.method === 'gte' && op.args[0] === 'created_at'))).toBe(true)

    const unwired = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(unwired.company.waiting).toBeNull()

    const failing = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, { ...ports(), waiting: vi.fn().mockRejectedValue(new Error('boom')) }, NOW)
    expect(failing.company.waiting).toBeNull()
    // The rest still answers.
    expect(failing.company.name).toBe('Exempelbolaget AB')
    expect(failing.company.counts.vouchers).toBe(4912)
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

  it('counts the knowledge items the agent gets today: the general ones and the ones the profile names', async () => {
    const { client, calls } = fakeSupabase(tables())
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    // Both general items, and the one industry item of the profile that is in the list (a retired one is not).
    // The company form item, the other industry and what the community shared are not active.
    expect(picture.company.knowledge).toEqual({
      items: 3,
      active: ['horizontal/swedish-vat', 'horizontal/swedish-payroll', 'vertical/konsult-it'],
    })
    expect(calls.find((c) => c.table === 'agent_profiles')!.ops.find((op) => op.method === 'select')!.args[0]).toBe('vertical_atoms, modifier_atoms')
  })

  it('counts a company-form item the profile names and an item the company installed', async () => {
    const company_skills = { data: [{ atom_id: 'vertical/e-handel' }] }
    const agent_profiles = { data: { vertical_atoms: null, modifier_atoms: ['modifier/holding-ab'] } }
    const picture = await loadAgentPicture(fakeSupabase(tables({ agent_profiles, company_skills })).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.knowledge).toEqual({
      items: 4,
      active: ['horizontal/swedish-vat', 'horizontal/swedish-payroll', 'modifier/holding-ab', 'vertical/e-handel'],
    })
  })

  it('counts the general items alone for a company with no profile', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ agent_profiles: { data: null } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.knowledge).toEqual({ items: 2, active: ['horizontal/swedish-vat', 'horizontal/swedish-payroll'] })
  })

  it('leaves out an item written for another legal form, as the catalogue does', async () => {
    // The holding item is aktiebolag law: an enskild firma whose profile names it does not get it.
    const companies: Handler = (call) => {
      const columns = call.ops.find((op) => op.method === 'select')?.args[0]
      return columns === 'name' ? { data: { name: 'X' } } : { data: { entity_type: 'enskild_firma', team_id: null, tic_snapshot_fetched_at: null } }
    }
    const agent_profiles = { data: { vertical_atoms: null, modifier_atoms: ['modifier/holding-ab'] } }
    const picture = await loadAgentPicture(fakeSupabase(tables({ companies, agent_profiles })).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.knowledge).toEqual({ items: 2, active: ['horizontal/swedish-vat', 'horizontal/swedish-payroll'] })
  })

  it('reads the company\'s own items once, and of each only which item it points at', async () => {
    const { client, calls } = fakeSupabase(tables())
    await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    const own = calls.filter((c) => c.table === 'company_skills')
    expect(own).toHaveLength(1)
    // No item's text, and no column the count does not read.
    expect(own[0].ops.find((op) => op.method === 'select')!.args[0]).toBe('atom_id')
    expect(filtered(own[0], 'eq', 'company_id', COMPANY)).toBe(true)
    expect(own[0].ops.find((op) => op.method === 'not')!.args).toEqual(['atom_id', 'is', null])
    // The registry once, by which item and of which kind.
    const registry = calls.filter((c) => c.table === 'agent_atom_registry')
    expect(registry).toHaveLength(1)
    expect(registry[0].ops.find((op) => op.method === 'select')!.args[0]).toBe('id, tier')
    // The company's own row once for the count: its legal form and its team in one read.
    const companyReads = calls.filter((c) => c.table === 'companies' && c.ops.some((op) => op.method === 'select' && typeof op.args[0] === 'string' && op.args[0].includes('entity_type')))
    expect(companyReads).toHaveLength(1)
    expect(companyReads[0].ops.find((op) => op.method === 'select')!.args[0]).toBe('entity_type, team_id')
    expect(filtered(companyReads[0], 'eq', 'id', COMPANY)).toBe(true)
  })

  it('counts an item the company\'s team installed, read by the team the company\'s own row names', async () => {
    const companies: Handler = (call) => {
      const columns = call.ops.find((op) => op.method === 'select')?.args[0]
      return columns === 'name' ? { data: { name: 'X' } } : { data: { entity_type: 'aktiebolag', team_id: 'team-1', tic_snapshot_fetched_at: null } }
    }
    const company_skills: Handler = (call) => (filtered(call, 'eq', 'team_id', 'team-1') ? { data: [{ atom_id: 'vertical/e-handel' }] } : { data: [] })
    const { client, calls } = fakeSupabase(tables({ companies, company_skills, agent_profiles: { data: null } }))
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(picture.company.knowledge).toEqual({ items: 3, active: ['horizontal/swedish-vat', 'horizontal/swedish-payroll', 'vertical/e-handel'] })
    const reads = calls.filter((c) => c.table === 'company_skills')
    expect(reads).toHaveLength(2)
    for (const read of reads) expect(read.ops.find((op) => op.method === 'select')!.args[0]).toBe('atom_id')
  })

  it('reads the registry by the filters the catalogue\'s own list is read by', async () => {
    const filters = (call: Call) => call.ops.filter((op) => op.method !== 'select' && op.method !== 'order' && op.method !== 'range')
    const catalogue = fakeSupabase(tables())
    await loadKnowledgeOptions(catalogue.client, COMPANY)
    const picture = fakeSupabase(tables())
    await loadAgentPicture(picture.client, COMPANY, USER, ports(), NOW)
    const ofCatalogue = catalogue.calls.find((c) => c.table === 'agent_atom_registry')!
    const ofPicture = picture.calls.find((c) => c.table === 'agent_atom_registry')!
    expect(filters(ofPicture).length).toBeGreaterThan(0)
    expect(filters(ofPicture)).toEqual(filters(ofCatalogue))
  })

  it('says unknown, and guesses nothing, when the profile, the list or the installed items cannot be read', async () => {
    const brokenReads: Array<Record<string, Handler>> = [
      { agent_profiles: { error: { message: 'boom' } } },
      { agent_atom_registry: { error: { message: 'boom' } } },
      { company_skills: { error: { message: 'boom' } } },
    ]
    for (const broken of brokenReads) {
      const picture = await loadAgentPicture(fakeSupabase(tables(broken)).client, COMPANY, USER, ports(), NOW)
      expect(picture.company.knowledge).toEqual({ items: null, active: null })
      expect(picture.company.counts.vouchers).toBe(4912)
    }
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
      subject_tail: null,
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
      // The account's last four characters, so two accounts with one name read apart.
      subject_tail: '7466',
      difference: null,
    })
  })

  it('leaves a bank account\'s result without its last four characters when the accounts cannot be read', async () => {
    const cash_accounts: Handler = (call) =>
      call.ops.some((op) => op.method === 'select' && op.args[0] === 'id, iban, kind, card_last4') ? { error: { message: 'boom' } } : { data: [] }
    const picture = await loadAgentPicture(fakeSupabase(tables({ cash_accounts })).client, COMPANY, USER, ports(), NOW)
    expect(picture.company.checks!.lines.find((l) => l.check_id === 'bank_balance_vs_bank')).toMatchObject({ subject: 'Företagskonto', subject_tail: null })
    expect(JSON.stringify(picture)).not.toContain('5000')
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
    const entered = vi.fn()
    const ledgerRead = <T,>(read: () => Promise<T>): Promise<T> => {
      entered()
      return read()
    }
    await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, { ...ports(), ledgerRead }, NOW)
    expect(entered).toHaveBeenCalledTimes(1)

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

/** A connection row as the key table holds it. */
const keyRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: OAUTH_KEY_NAME,
  client: 'claude',
  last_used_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  user_id: USER,
  service_account_id: null,
  company_id: COMPANY,
  ...over,
})
/** The key table answering `rows` for the company, and nothing for the person's keys elsewhere. */
const homedKeys = (rows: unknown[]): Handler => (call) => (filtered(call, 'eq', 'company_id') ? { data: rows } : { data: [] })

describe('loadAgentPicture: agents', () => {
  it('lists one card per product, each with its connections and what they did today', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list).toEqual([
      {
        id: 'claude',
        kind: 'claude',
        name: null,
        service_account: null,
        labels: ['Claude (Anthropic)'],
        connections: [
          {
            id: 'key-claude',
            kind: 'claude',
            name: null,
            service_account: null,
            last_used_at: '2026-03-02T08:59:30.000Z',
            calls_today: 2,
            last_call_at: '2026-03-02T08:59:30.000Z',
            connected_at: '2026-01-04T00:00:00.000Z',
            is_own: true,
            owner_name: null,
          },
        ],
      },
      {
        id: 'key:key-manual',
        kind: 'key',
        name: 'Nattjobbet',
        service_account: null,
        labels: ['Nattjobbet'],
        connections: [
          {
            id: 'key-manual',
            kind: 'key',
            name: 'Nattjobbet',
            service_account: null,
            last_used_at: null,
            calls_today: 0,
            last_call_at: null,
            connected_at: '2026-01-05T00:00:00.000Z',
            is_own: true,
            owner_name: null,
          },
        ],
      },
    ])
    expect(picture.agents!.more).toBe(0)
    // The memory count the picture read in its own part rides along with the activity.
    expect(picture.agents!.activity).toMatchObject({ day: '2026-03-02', now: NOW.toISOString(), capped: false, memory_facts: 23, work: { by_connection: {}, by_label: {} } })
  })

  it('puts every connection the screen names by the same kind on one card, the newest first', async () => {
    const api_keys = homedKeys([
      keyRow('claude-old', { last_used_at: '2026-02-01T00:00:00.000Z' }),
      keyRow('local-1', { client: 'local', last_used_at: '2026-02-10T00:00:00.000Z' }),
      keyRow('claude-new', { last_used_at: '2026-02-20T00:00:00.000Z' }),
      // A sign-in from before the client was recorded: an MCP client the screen cannot name.
      keyRow('mcp-1', { client: null }),
      keyRow('mcp-2', { client: null, last_used_at: '2026-01-15T00:00:00.000Z' }),
      keyRow('claude-unused'),
    ])
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list.map((card) => [card.id, card.connections.map((c) => c.id)])).toEqual([
      ['claude', ['claude-new', 'claude-old', 'claude-unused']],
      ['local', ['local-1']],
      ['mcp', ['mcp-2', 'mcp-1']],
    ])
    expect(picture.agents!.more).toBe(0)
  })

  it('keeps a hand-made key and a partner\'s key as cards of their own', async () => {
    const api_keys = homedKeys([
      keyRow('k1', { name: 'Nattjobbet', client: null }),
      keyRow('k2', { name: 'Nattjobbet', client: null }),
      keyRow('p1', { client: 'partner:byran' }),
      keyRow('p2', { client: 'partner:byran' }),
      keyRow('p3', { client: 'partner:okand' }),
    ])
    service = fakeSupabase({ oauth_partner_clients: { data: [{ slug: 'byran', name: 'Byrån', created_at: '2026-01-01T00:00:00.000Z' }] } })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list.map((card) => [card.id, card.kind, card.name, card.connections.length, card.labels])).toEqual([
      // Two keys with one name are two cards, and neither owns the name as a label.
      ['key:k1', 'key', 'Nattjobbet', 1, []],
      ['key:k2', 'key', 'Nattjobbet', 1, []],
      ['key:p1', 'partner', 'Byrån', 1, []],
      ['key:p2', 'partner', 'Byrån', 1, []],
      // A partner whose name could not be read is named by its kind, and its label is not known.
      ['partner', 'partner', null, 1, []],
    ])
  })

  it('puts a service account\'s connections on one card per account, named by the account', async () => {
    const account = (id: string, accountId: string) => keyRow(id, { name: `nyckel ${id}`, client: null, service_account_id: accountId })
    const api_keys = homedKeys([account('k1', 'sa-1'), account('k2', 'sa-2'), account('k3', 'sa-1')])
    service = fakeSupabase({ service_accounts: { data: [{ id: 'sa-1', name: 'Accounteds agent' }] } })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list.map((card) => [card.id, card.kind, card.name, card.service_account, card.connections.map((c) => c.id), card.labels])).toEqual([
      ['account:sa-1', 'key', null, 'Accounteds agent', ['k1', 'k3'], ['Accounteds agent']],
      // An account whose name could not be read keeps its key's name: the card is still an account's, and owns no label.
      ['account:sa-2', 'key', null, 'nyckel k2', ['k2'], []],
    ])
    expect(picture.agents!.list[0].connections[0]).toMatchObject({ kind: 'key', name: 'nyckel k1', service_account: 'Accounteds agent', owner_name: null })
    const names = service.calls.find((c) => c.table === 'service_accounts')!
    expect(filtered(names, 'eq', 'company_id', COMPANY)).toBe(true)
    expect(names.ops.find((op) => op.method === 'in')!.args).toEqual(['id', ['sa-1', 'sa-2']])
  })

  it('says whose a colleague\'s connection is, and never whose the person\'s own or an account\'s is', async () => {
    const api_keys = homedKeys([
      keyRow('mine'),
      keyRow('hers', { user_id: 'user-2' }),
      keyRow('unnamed', { user_id: 'user-3' }),
      keyRow('sponsored', { name: 'nyckel', client: null, user_id: 'user-2', service_account_id: 'sa-1' }),
    ])
    service = fakeSupabase({
      profiles: { data: [{ id: 'user-2', full_name: ' Anna Ek ', email: 'anna@example.com' }, { id: 'user-3', full_name: null, email: 'bo@example.com' }] },
      service_accounts: { data: [{ id: 'sa-1', name: 'Lönesystemet' }] },
    })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    const connections = picture.agents!.list.flatMap((card) => card.connections)
    expect(connections.map((c) => [c.id, c.is_own, c.owner_name])).toEqual([
      ['mine', true, null],
      ['hers', false, 'Anna Ek'],
      ['unnamed', false, 'bo@example.com'],
      ['sponsored', false, null],
    ])
    // Read by the ids of the other people whose connections were listed, once each.
    const owners = service.calls.find((c) => c.table === 'profiles')!
    expect(owners.ops.find((op) => op.method === 'select')!.args[0]).toBe('id, full_name, email')
    expect(owners.ops.find((op) => op.method === 'in')!.args).toEqual(['id', ['user-2', 'user-3']])
  })

  it('leaves a colleague unnamed when the names cannot be read, and reads no names when every connection is the person\'s own', async () => {
    service = fakeSupabase({ profiles: { error: { message: 'boom' } } })
    const api_keys = homedKeys([keyRow('hers', { user_id: 'user-2' })])
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list[0].connections[0]).toMatchObject({ id: 'hers', is_own: false, owner_name: null })

    service = fakeSupabase({})
    await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    expect(service.calls.some((c) => c.table === 'profiles')).toBe(false)
  })

  it('hands out nothing of what only put a connection on its card', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
    for (const connection of picture.agents!.list.flatMap((card) => card.connections)) {
      expect(Object.keys(connection).sort()).toEqual(['calls_today', 'connected_at', 'id', 'is_own', 'kind', 'last_call_at', 'last_used_at', 'name', 'owner_name', 'service_account'])
    }
  })

  it('gives a card the labels its connections alone write, and none for a client that registered itself', async () => {
    const api_keys = homedKeys([
      keyRow('claude-1'),
      keyRow('claude-2'),
      keyRow('chatgpt-1', { client: 'chatgpt' }),
      keyRow('registered-1', { client: 'registered:0d6f6f0e-0000-4000-8000-000000000001' }),
      keyRow('old-1', { client: null }),
    ])
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list.map((card) => [card.id, card.labels])).toEqual([
      ['claude', ['Claude (Anthropic)']],
      ['chatgpt', ['ChatGPT (OpenAI)']],
      // The registered client and the old sign-in share a card: the label of the old one is the card's alone.
      ['mcp', ['MCP-klient (OAuth)']],
    ])
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
    const elsewhere = (id: string) => keyRow(id, { client: 'chatgpt', company_id: 'company-2' })
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
    // No company list reaches every company; a list reaches the ones on it. Both are ChatGPT: one card.
    expect(picture.agents!.list.map((card) => [card.id, card.connections.map((c) => c.id).sort()])).toEqual([['chatgpt', ['listed', 'open']]])
    const lists = service.calls.find((c) => c.table === 'api_key_companies')!
    expect(lists.ops.find((op) => op.method === 'in')!.args).toEqual(['api_key_id', ['open', 'listed', 'other']])
  })

  it('hands out no last use for a connection made in another company, and keeps it for one made here', async () => {
    const used = '2026-03-01T15:00:00.000Z'
    const api_keys: Handler = (call) =>
      filtered(call, 'eq', 'company_id') ? { data: [keyRow('here', { last_used_at: used })] } : { data: [keyRow('away', { client: 'chatgpt', company_id: 'company-2', last_used_at: used })] }
    // This company's own log holds a call of neither.
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    const connections = picture.agents!.list.flatMap((card) => card.connections)
    expect(connections.find((c) => c.id === 'here')).toMatchObject({ last_used_at: used })
    expect(connections.find((c) => c.id === 'here')).not.toHaveProperty('elsewhere')
    // The key's own last use may be the other company's: it does not leave the server.
    expect(connections.find((c) => c.id === 'away')).toMatchObject({ last_used_at: null, last_call_at: null, elsewhere: true })
    // The time is in the answer once: for the connection made here.
    expect(JSON.stringify(picture.agents).split(used)).toHaveLength(2)

    // A call in this company's own log is this company's to show.
    const event_log = { data: [{ created_at: '2026-02-27T10:00:00.000Z', actor_id: 'away' }] }
    const called = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log })).client, COMPANY, USER, ports(), NOW)
    expect(called.agents!.list.flatMap((card) => card.connections).find((c) => c.id === 'away')).toMatchObject({ last_used_at: null, last_call_at: '2026-02-27T10:00:00.000Z', elsewhere: true })
  })

  it('leaves out connections homed elsewhere when their company lists cannot be read', async () => {
    const api_keys: Handler = (call) => (filtered(call, 'eq', 'company_id') ? { data: [] } : { data: [keyRow('open', { company_id: 'company-2' })] })
    service = fakeSupabase({ api_key_companies: { error: { message: 'boom' } } })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list).toEqual([])
  })

  it('lists six cards, the ones that worked last first, and counts the cards past them, not the connections', async () => {
    const key = (n: number) => keyRow(`k${n}`, { name: `Nyckel ${n}`, client: null, last_used_at: `2026-02-0${n}T00:00:00.000Z` })
    // Eight named keys are eight cards; four Claude sign-ins are one more.
    const claude = [1, 2, 3, 4].map((n) => keyRow(`c${n}`, { last_used_at: `2026-01-0${n}T00:00:00.000Z` }))
    const api_keys = homedKeys([...[1, 2, 3, 4, 5, 6, 7, 8].map(key), ...claude])
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.list.map((card) => card.id)).toEqual(['key:k8', 'key:k7', 'key:k6', 'key:k5', 'key:k4', 'key:k3'])
    expect(picture.agents!.more).toBe(3)

    // Twelve connections of two products are two cards, and nothing is past them.
    const few = homedKeys([...claude, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => keyRow(`g${n}`, { client: 'chatgpt' }))])
    const two = await loadAgentPicture(fakeSupabase(tables({ api_keys: few, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(two.agents!.list.map((card) => [card.id, card.connections.length])).toEqual([['claude', 4], ['chatgpt', 8]])
    expect(two.agents!.more).toBe(0)
  })

  it('works out which labels a card owns over every card, the ones past the listed six too', async () => {
    const key = (n: number) => keyRow(`k${n}`, { name: n === 8 ? 'Samma' : `Nyckel ${n}`, client: null, last_used_at: `2026-02-0${n}T00:00:00.000Z` })
    const api_keys = homedKeys([...[2, 3, 4, 5, 6, 7, 8].map(key), keyRow('k1', { name: 'Samma', client: null, last_used_at: '2026-02-01T00:00:00.000Z' })])
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys, event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.more).toBe(2)
    // k8 is listed and k1 is not: both can have written "Samma", so the listed card does not own it.
    expect(picture.agents!.list.find((card) => card.id === 'key:k8')!.labels).toEqual([])
    expect(picture.agents!.list.find((card) => card.id === 'key:k7')!.labels).toEqual(['Nyckel 7'])
  })

  it('keeps the cards when the tool call log cannot be read, and says the activity is unknown', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ event_log: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.activity).toBeNull()
    expect(picture.agents!.list.map((a) => a.id)).toEqual(['claude', 'key:key-manual'])
  })

  it('answers unknown agents when the connections cannot be read, and the rest still renders', async () => {
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys: { error: { message: 'boom' } } })).client, COMPANY, USER, ports(), NOW)
    expect(picture.agents).toBeNull()
    expect(picture.company.name).toBe('Exempelbolaget AB')
    expect(sourceOf(picture, 'bank:cash-1')).toBeDefined()
  })
})

/** A key as the key table holds it, for the tests that answer a read by its filters. */
interface StoredKey {
  id: string
  name: string
  client: string | null
  last_used_at: string | null
  created_at: string
  user_id: string
  service_account_id: string | null
  company_id: string | null
  revoked_at: string | null
}
const stored = (id: string, over: Partial<StoredKey> = {}): StoredKey => ({
  id,
  name: OAUTH_KEY_NAME,
  client: 'claude',
  last_used_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  user_id: USER,
  service_account_id: null,
  company_id: COMPANY,
  revoked_at: null,
  ...over,
})
/** Whether a stored key passes the filters of one read: eq, in, is and not-is, as the loader writes them. */
function passes(row: StoredKey, ops: Call['ops']): boolean {
  const value = (column: unknown): unknown => (typeof column === 'string' && Object.hasOwn(row, column) ? row[column as keyof StoredKey] : undefined)
  return ops.every((op) => {
    const [column, first, second] = op.args
    if (op.method === 'eq' || op.method === 'is') return value(column) === first
    if (op.method === 'in') return Array.isArray(first) && first.includes(value(column))
    if (op.method === 'not') return first === 'is' ? value(column) !== second : true
    return true
  })
}
type Role = 'owner' | 'member' | 'viewer'
/** The key table through the person's own access: an owner reads the company's keys and their own, anyone else only their own. */
const keysAs = (db: readonly StoredKey[], role: Role): Handler => (call) => ({
  data: db.filter((row) => (role === 'owner' ? row.company_id === COMPANY || row.user_id === USER : row.user_id === USER)).filter((row) => passes(row, call.ops)),
})
/** The key table through the service role: every key that passes the read's filters. */
const everyKey = (db: readonly StoredKey[]): Handler => (call) => ({ data: db.filter((row) => passes(row, call.ops)) })
interface Membership {
  user_id: string
  company_id: string
}
const membersOf = (rows: readonly Membership[]): Handler => (call) => {
  const company = call.ops.find((op) => op.method === 'eq' && op.args[0] === 'company_id')?.args[1]
  return { data: rows.filter((row) => row.company_id === company) }
}
interface KeyCompany {
  api_key_id: string
  company_id: string
}
const companyLists = (rows: readonly KeyCompany[]): Handler => (call) => {
  const wanted = call.ops.find((op) => op.method === 'in' && op.args[0] === 'api_key_id')?.args[1]
  return { data: rows.filter((row) => Array.isArray(wanted) && wanted.includes(row.api_key_id)) }
}

describe('loadAgentPicture: the connections the person may not list', () => {
  // A colleague and a firm's consultant are members here; the stranger is not.
  const MEMBERS: Membership[] = [
    { user_id: USER, company_id: COMPANY },
    { user_id: 'colleague', company_id: COMPANY },
    { user_id: 'consultant', company_id: COMPANY },
    { user_id: 'consultant', company_id: 'firm' },
    { user_id: 'stranger', company_id: 'elsewhere' },
  ]
  const OTHERS: StoredKey[] = [
    stored('colleague-here', { user_id: 'colleague' }),
    stored('colleague-revoked', { user_id: 'colleague', revoked_at: '2026-02-01T00:00:00.000Z' }),
    // Made in the firm's own company: no company list reaches every company the consultant is a member of.
    stored('consultant-open', { user_id: 'consultant', company_id: 'firm' }),
    stored('consultant-listed-here', { user_id: 'consultant', company_id: 'firm' }),
    stored('consultant-listed-away', { user_id: 'consultant', company_id: 'firm' }),
    // A service account's key reaches its own company alone.
    stored('account-here', { name: 'nyckel', client: null, user_id: 'colleague', service_account_id: 'sa-1' }),
    stored('account-of-the-firm', { name: 'nyckel', client: null, user_id: 'consultant', service_account_id: 'sa-9', company_id: 'firm' }),
    // Another company's keys, of someone who is no member here.
    stored('stranger-open', { user_id: 'stranger', company_id: 'elsewhere' }),
    stored('stranger-listed-here', { user_id: 'stranger', company_id: 'elsewhere' }),
  ]
  const LISTS: KeyCompany[] = [
    { api_key_id: 'consultant-listed-here', company_id: COMPANY },
    { api_key_id: 'consultant-listed-here', company_id: 'firm' },
    { api_key_id: 'consultant-listed-away', company_id: 'firm' },
    { api_key_id: 'stranger-listed-here', company_id: COMPANY },
  ]

  async function pictureAs(role: Role, own: readonly StoredKey[]) {
    const db: StoredKey[] = [...own, ...OTHERS]
    service = fakeSupabase({
      company_members: membersOf(MEMBERS),
      api_keys: everyKey(db),
      api_key_companies: companyLists(LISTS),
      service_accounts: { data: [{ id: 'sa-1', name: 'Lönesystemet' }] },
      profiles: { data: [{ id: 'colleague', full_name: 'Anna Ek', email: 'anna@example.com' }] },
    })
    const picture = await loadAgentPicture(fakeSupabase(tables({ api_keys: keysAs(db, role), event_log: { data: [] } })).client, COMPANY, USER, ports(), NOW)
    return picture
  }
  const listedIds = (picture: Awaited<ReturnType<typeof pictureAs>>): string[] =>
    picture.agents!.list.flatMap((card) => card.connections.map((connection) => connection.id)).sort()

  it('counts for an owner the connections made in another company that reach this one', async () => {
    const picture = await pictureAs('owner', [stored('mine')])
    // The owner lists every key homed in the company.
    expect(listedIds(picture)).toEqual(['account-here', 'colleague-here', 'mine'])
    // The consultant's sign-in without a company list, and the one whose list names this company.
    expect(picture.agents!.others).toBe(2)
  })

  it('counts for a member with keys of their own every other connection that reaches the company', async () => {
    const picture = await pictureAs('member', [stored('mine'), stored('mine-elsewhere', { company_id: 'firm' })])
    expect(listedIds(picture)).toEqual(['mine', 'mine-elsewhere'])
    // The colleague's, the service account's and the consultant's two: not the member's own, listed or not.
    expect(picture.agents!.others).toBe(4)
  })

  it('counts them for a read-only member who has no connection, instead of answering nothing', async () => {
    const picture = await pictureAs('viewer', [])
    expect(picture.agents!.list).toEqual([])
    expect(picture.agents!.others).toBe(4)
  })

  it('never counts a revoked key, a key whose list names other companies, another company\'s service account or a stranger\'s key', async () => {
    const picture = await pictureAs('viewer', [])
    const reads = service.calls.filter((c) => c.table === 'api_keys')
    // Two reads of key ids: the company's service-account keys, and the keys of the company's members.
    expect(reads).toHaveLength(2)
    for (const read of reads) {
      expect(read.ops.find((op) => op.method === 'select')!.args[0]).toBe('id')
      expect(read.ops.find((op) => op.method === 'is' && op.args[0] === 'revoked_at')!.args).toEqual(['revoked_at', null])
    }
    const ofAccounts = reads.find((c) => c.ops.some((op) => op.method === 'not'))!
    expect(filtered(ofAccounts, 'eq', 'company_id', COMPANY)).toBe(true)
    const ofMembers = reads.find((c) => c.ops.some((op) => op.method === 'in'))!
    expect(ofMembers.ops.find((op) => op.method === 'in')!.args).toEqual(['user_id', [USER, 'colleague', 'consultant']])
    expect(ofMembers.ops.find((op) => op.method === 'is' && op.args[0] === 'service_account_id')!.args).toEqual(['service_account_id', null])
    expect(filtered(service.calls.find((c) => c.table === 'company_members')!, 'eq', 'company_id', COMPANY)).toBe(true)
    // The company lists are asked for the members' keys alone: the stranger's is not among them.
    const lists = service.calls.find((c) => c.table === 'api_key_companies')!
    expect(lists.ops.find((op) => op.method === 'in')!.args).toEqual(['api_key_id', ['colleague-here', 'consultant-open', 'consultant-listed-here', 'consultant-listed-away']])
    expect(picture.agents!.others).toBe(4)
  })

  it('hands out the number and nothing else about another person\'s connection', async () => {
    const picture = await pictureAs('member', [stored('mine')])
    const answer = JSON.stringify(picture)
    for (const key of OTHERS) expect(answer).not.toContain(key.id)
    for (const word of ['colleague', 'consultant', 'stranger', 'Anna Ek', 'Lönesystemet', 'sa-1']) expect(answer).not.toContain(word)
    expect(Object.keys(picture.agents!).sort()).toEqual(['activity', 'list', 'more', 'others'])
  })

  it('answers zero when nobody else has a connection, and unknown when the count cannot be read', async () => {
    service = fakeSupabase({ company_members: membersOf(MEMBERS), api_keys: everyKey([stored('mine')]), api_key_companies: companyLists([]) })
    const alone = await loadAgentPicture(fakeSupabase(tables({ api_keys: keysAs([stored('mine')], 'owner') })).client, COMPANY, USER, ports(), NOW)
    expect(alone.agents!.others).toBe(0)

    const brokenReads: Array<Record<string, Handler>> = [
      { company_members: { error: { message: 'boom' } }, api_keys: everyKey(OTHERS), api_key_companies: companyLists(LISTS) },
      { company_members: membersOf(MEMBERS), api_keys: { error: { message: 'boom' } }, api_key_companies: companyLists(LISTS) },
      { company_members: membersOf(MEMBERS), api_keys: everyKey(OTHERS), api_key_companies: { error: { message: 'boom' } } },
    ]
    for (const broken of brokenReads) {
      service = fakeSupabase(broken)
      const picture = await loadAgentPicture(fakeSupabase(tables()).client, COMPANY, USER, ports(), NOW)
      expect(picture.agents!.others).toBeNull()
      // The connections the person may list are still answered.
      expect(picture.agents!.list.map((card) => card.id)).toEqual(['claude', 'key:key-manual'])
    }
  })
})

describe('loadAgentCards', () => {
  it('answers every card the person may list, the ones past the listed six too, without reading the log', async () => {
    const key = (n: number) => keyRow(`k${n}`, { name: `Nyckel ${n}`, client: null, last_used_at: `2026-02-0${n}T00:00:00.000Z` })
    const api_keys = homedKeys([...[1, 2, 3, 4, 5, 6, 7, 8].map(key), keyRow('c1'), keyRow('c2')])
    const { client, calls } = fakeSupabase(tables({ api_keys }))
    const cards = await loadAgentCards(client, COMPANY, USER)
    expect(cards.map((card) => [card.id, card.connections.map((c) => c.id), card.labels])).toEqual([
      ['key:k8', ['k8'], ['Nyckel 8']],
      ['key:k7', ['k7'], ['Nyckel 7']],
      ['key:k6', ['k6'], ['Nyckel 6']],
      ['key:k5', ['k5'], ['Nyckel 5']],
      ['key:k4', ['k4'], ['Nyckel 4']],
      ['key:k3', ['k3'], ['Nyckel 3']],
      ['key:k2', ['k2'], ['Nyckel 2']],
      ['key:k1', ['k1'], ['Nyckel 1']],
      ['claude', ['c1', 'c2'], ['Claude (Anthropic)']],
    ])
    // Only the connections: the keys homed in the company and the person's own.
    expect([...new Set(calls.map((c) => c.table))]).toEqual(['api_keys'])
    for (const read of calls) expect(filtered(read, 'eq', 'company_id', COMPANY) || filtered(read, 'eq', 'user_id', USER)).toBe(true)
    expect(cards.flatMap((card) => card.connections).every((c) => c.calls_today === 0 && c.last_call_at === null)).toBe(true)
  })

  it('throws when the connections cannot be read', async () => {
    await expect(loadAgentCards(fakeSupabase(tables({ api_keys: { error: { message: 'boom' } } })).client, COMPANY, USER)).rejects.toThrow('connections read failed: boom')
  })
})

describe('loadAgentPicture: what the connections did today', () => {
  const staged = { data: [{ actor_id: 'key-claude', actor_label: 'Claude (Anthropic)' }, { actor_id: 'key-claude', actor_label: 'Claude (Anthropic)' }, { actor_id: null, actor_label: 'Nattjobbet' }] }
  const asked = { data: [{ actor_id: 'key-claude', actor_label: 'Claude (Anthropic)' }] }

  it('counts the questions asked and the proposals prepared today by who staged them, and reads only that', async () => {
    const { client, calls } = fakeSupabase(tables({ company_questions: asked, pending_operations: staged }))
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(picture.agents!.activity!.work).toEqual({
      by_connection: { 'key-claude': { questions: 1, proposals: 2 } },
      by_label: { Nattjobbet: { questions: 0, proposals: 1 } },
    })

    const questions = calls.find((c) => c.table === 'company_questions')!
    expect(questions.ops.find((op) => op.method === 'select')!.args[0]).toBe('actor_id, actor_label')
    expect(filtered(questions, 'eq', 'company_id', COMPANY)).toBe(true)
    // From midnight in Stockholm, and not a question its asker took back.
    expect(questions.ops.find((op) => op.method === 'gte')!.args).toEqual(['created_at', '2026-03-01T23:00:00.000Z'])
    expect(questions.ops.find((op) => op.method === 'or')!.args).toEqual(['close_reason.is.null,close_reason.neq.withdrawn'])

    const proposals = calls.find((c) => c.table === 'pending_operations')!
    expect(proposals.ops.find((op) => op.method === 'select')!.args[0]).toBe('actor_id, actor_label')
    expect(filtered(proposals, 'eq', 'company_id', COMPANY)).toBe(true)
    // Staged by a connection, today, and not replaced by a newer proposal.
    expect(proposals.ops.find((op) => op.method === 'in')!.args).toEqual(['actor_type', ['api_key', 'mcp_oauth', 'service_account']])
    expect(proposals.ops.find((op) => op.method === 'gte')!.args).toEqual(['created_at', '2026-03-01T23:00:00.000Z'])
    expect(proposals.ops.find((op) => op.method === 'or')!.args).toEqual(['rejection_category.is.null,rejection_category.neq.superseded'])
    expect(proposals.ops.find((op) => op.method === 'range')!.args).toEqual([0, 999])
  })

  it('reads no questions for a company without the question list, and still counts its proposals', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'company-2')
    const { client, calls } = fakeSupabase(tables({ company_questions: asked, pending_operations: staged }))
    const picture = await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(calls.some((c) => c.table === 'company_questions')).toBe(false)
    expect(picture.agents!.activity!.work).toEqual({
      by_connection: { 'key-claude': { questions: 0, proposals: 2 } },
      by_label: { Nattjobbet: { questions: 0, proposals: 1 } },
    })
  })

  it('says the work is unknown when it cannot be read, and keeps the cards and their calls', async () => {
    const brokenReads: Array<Parameters<typeof tables>[0]> = [
      { company_questions: { error: { message: 'boom' } } },
      { pending_operations: { error: { message: 'boom' } } },
    ]
    for (const broken of brokenReads) {
      const picture = await loadAgentPicture(fakeSupabase(tables(broken)).client, COMPANY, USER, ports(), NOW)
      expect(picture.agents!.activity).toMatchObject({ work: null, actors: { 'key-claude': { calls_today: 2 } } })
      expect(picture.agents!.list.map((card) => card.id)).toEqual(['claude', 'key:key-manual'])
    }
  })
})

describe('loadAgentPicture: the whole answer', () => {
  it('filters every read on the company, with the named exceptions', async () => {
    const all = tables()
    const { client, calls, tablesRead } = fakeSupabase(all)
    await loadAgentPicture(client, COMPANY, USER, ports(), NOW)
    expect(calls.length).toBeGreaterThan(15)
    // No table is read that this test does not know about.
    expect(tablesRead().filter((table) => !(table in all))).toEqual([])
    for (const call of calls) {
      const byCompany = filtered(call, 'eq', 'company_id', COMPANY)
      if (call.table === 'companies') expect(filtered(call, 'eq', 'id', COMPANY)).toBe(true)
      else if (call.table === 'whatsapp_phone_links') expect(filtered(call, 'eq', 'user_id', USER)).toBe(true)
      else if (call.table === 'api_keys') expect(byCompany || filtered(call, 'eq', 'user_id', USER)).toBe(true)
      // The knowledge registry is the same for every company.
      else if (call.table === 'agent_atom_registry') expect(byCompany).toBe(false)
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
      agent_memory: { count: 7 },
      company_questions: { data: [{ actor_id: 'a', actor_label: 'Claude (Anthropic)' }] },
      pending_operations: { data: [{ actor_id: 'a', actor_label: 'Claude (Anthropic)' }] },
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
      memory_facts: 7,
      actors: {
        a: { calls_today: 2, last_call_at: '2026-03-02T08:59:30.000Z' },
        b: { calls_today: 1, last_call_at: '2026-03-02T08:00:00.000Z' },
        c: { calls_today: 0, last_call_at: '2026-03-01T10:00:00.000Z' },
      },
      work: { by_connection: { a: { questions: 1, proposals: 1 } }, by_label: {} },
    })
    // One read of the log, one count of the memory, and the day's questions and proposals.
    expect(calls.map((c) => c.table).sort()).toEqual(['agent_memory', 'company_questions', 'event_log', 'pending_operations'])
    for (const table of ['company_questions', 'pending_operations']) {
      const work = calls.find((c) => c.table === table)!
      expect(filtered(work, 'eq', 'company_id', COMPANY)).toBe(true)
      // Only who staged the row: not a word of a question or a proposal.
      expect(work.ops.find((op) => op.method === 'select')!.args[0]).toBe('actor_id, actor_label')
    }
    expect(filtered(calls.find((c) => c.table === 'agent_memory')!, 'eq', 'company_id', COMPANY)).toBe(true)
    const read = calls.find((c) => c.table === 'event_log')!
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
    const pages = calls.filter((c) => c.table === 'event_log')
    expect(pages).toHaveLength(5)
    expect(pages.map((c) => c.ops.find((op) => op.method === 'range')!.args)).toEqual([[0, 199], [200, 399], [400, 599], [600, 799], [800, 999]])
    expect(activity.actors.a.calls_today).toBe(1000)
    expect(activity.capped).toBe(true)
  })

  it('says the memory count is unknown when it cannot be read, and still answers the log', async () => {
    const { client } = fakeSupabase({ event_log: { data: [] }, agent_memory: { error: { message: 'boom' } } })
    const activity = await loadAgentActivity(client, COMPANY, NOW)
    expect(activity.memory_facts).toBeNull()
    expect(activity.actors).toEqual({})
  })

  it('says the day\'s work is unknown when it cannot be read, and still answers the log', async () => {
    const { client } = fakeSupabase({ event_log: { data: [{ created_at: '2026-03-02T08:00:00.000Z', actor_id: 'a' }] }, agent_memory: { count: 1 }, pending_operations: { error: { message: 'boom' } } })
    const activity = await loadAgentActivity(client, COMPANY, NOW)
    expect(activity.work).toBeNull()
    expect(activity.actors.a.calls_today).toBe(1)
  })

  it('throws when the log cannot be read', async () => {
    const { client } = fakeSupabase({ event_log: { error: { message: 'boom' } } })
    await expect(loadAgentActivity(client, COMPANY, NOW)).rejects.toThrow('tool call log read failed: boom')
  })
})
