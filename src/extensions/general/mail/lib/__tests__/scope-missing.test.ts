/**
 * Grants saved without the Gmail scope.
 *
 * While the consent request also asked for `openid email`, a person could
 * untick Gmail on Google's consent screen and approve the rest, and the grant
 * was saved as an active mailbox. Production held three such rows. They can
 * never search: every press failed on them with a refusal that looked like a
 * Gmail outage. They are healed by code, not by a data repair: the listing
 * shows them as needing a reconnect without writing anything, and the next
 * search parks them the way a revoked grant is parked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GMAIL_READONLY_SCOPE } from '../google-oauth'
import { listActiveConnections, listConnections } from '../connections'

const SIGN_IN_ONLY = ['openid', 'https://www.googleapis.com/auth/userinfo.email']

function connection(id: string, scopes: string[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    company_id: 'co-1',
    provider: 'gmail',
    email_address: `${id}@example.se`,
    encrypted_refresh_token: 'enc',
    encrypted_access_token: null,
    access_token_expires_at: null,
    scope_label: null,
    status: 'active',
    scopes,
    last_searched_at: null,
    last_error_code: null,
    updated_at: `2026-09-01T10:00:00.00000${id.length}+00:00`,
    ...overrides,
  }
}

/** Answers every select with `rows`; records each update with its filters. */
function mockSupabase(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  const client = {
    from() {
      const filters: Array<[string, unknown]> = []
      let update: Record<string, unknown> | null = null
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        order: vi.fn(() => chain),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        }),
        update: vi.fn((values: Record<string, unknown>) => {
          update = values
          updates.push({ values, filters })
          return chain
        }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(update ? { error: null } : { data: rows, error: null }).then(resolve),
      }
      return chain
    },
  }
  return { client: client as never, updates }
}

beforeEach(() => vi.clearAllMocks())

describe('listConnections (GET /connections)', () => {
  it('shows a grant without the Gmail scope as needing a reconnect, and writes nothing', async () => {
    const { client, updates } = mockSupabase([connection('c1', SIGN_IN_ONLY)])

    const [row] = await listConnections(client, 'co-1')

    expect(row).toMatchObject({ id: 'c1', status: 'needs_reconsent', lastErrorCode: 'scope_missing' })
    expect(updates).toEqual([])
  })

  it('keeps the reviewer demo row, which carries exactly gmail.readonly, active', async () => {
    const { client } = mockSupabase([connection('demo', [GMAIL_READONLY_SCOPE])])
    const [row] = await listConnections(client, 'co-1')
    expect(row).toMatchObject({ status: 'active', lastErrorCode: null })
  })

  it('keeps an older grant that carries gmail.readonly next to the sign-in scopes active', async () => {
    const { client } = mockSupabase([connection('old', ['openid', GMAIL_READONLY_SCOPE, SIGN_IN_ONLY[1]])])
    const [row] = await listConnections(client, 'co-1')
    expect(row.status).toBe('active')
  })

  it('never reads an empty scope list as a missing scope', async () => {
    // Empty means Google did not state the scopes: the one requested.
    const { client } = mockSupabase([connection('c1', [])])
    const [row] = await listConnections(client, 'co-1')
    expect(row.status).toBe('active')
  })

  it('reports a row that is already parked exactly as it is stored', async () => {
    const { client } = mockSupabase([
      connection('c1', [GMAIL_READONLY_SCOPE], { status: 'needs_reconsent', last_error_code: 'invalid_grant' }),
    ])
    const [row] = await listConnections(client, 'co-1')
    expect(row).toMatchObject({ status: 'needs_reconsent', lastErrorCode: 'invalid_grant' })
  })

  it('leaves providers other than Gmail out of the Gmail scope rule', async () => {
    const { client } = mockSupabase([connection('m1', ['Mail.Read'], { provider: 'microsoft' })])
    const [row] = await listConnections(client, 'co-1')
    expect(row.status).toBe('active')
  })

  it('never answers with a token or the scope list', async () => {
    const { client } = mockSupabase([connection('c1', SIGN_IN_ONLY)])
    const [row] = await listConnections(client, 'co-1')
    expect(JSON.stringify(row)).not.toContain('enc')
    expect(row).not.toHaveProperty('scopes')
  })
})

describe('listActiveConnections (what a search may use)', () => {
  it('parks a grant without the Gmail scope as needs_reconsent and leaves it out', async () => {
    const scopeLess = connection('c1', SIGN_IN_ONLY)
    const { client, updates } = mockSupabase([scopeLess, connection('demo', [GMAIL_READONLY_SCOPE])])

    const usable = await listActiveConnections(client, 'co-1')

    expect(usable.map((c) => c.id)).toEqual(['demo'])
    expect(updates).toHaveLength(1)
    expect(updates[0].values).toMatchObject({ status: 'needs_reconsent', last_error_code: 'scope_missing' })
    // Only the row as it was read: a reconnect landing in between wins.
    expect(updates[0].filters).toEqual(
      expect.arrayContaining([
        ['id', 'c1'],
        ['updated_at', scopeLess.updated_at],
      ]),
    )
  })

  it('writes nothing when every grant can read Gmail', async () => {
    const { client, updates } = mockSupabase([
      connection('demo', [GMAIL_READONLY_SCOPE]),
      connection('unstated', []),
    ])

    const usable = await listActiveConnections(client, 'co-1')

    expect(usable.map((c) => c.id)).toEqual(['demo', 'unstated'])
    expect(updates).toEqual([])
  })
})
