/**
 * Disconnecting a mailbox is a control change over how underlag reaches the
 * books, so it has to be reconstructable (BFNAR 2013:2 kap 8). What must NOT
 * happen is the audit entry preserving the credential the delete existed to
 * destroy.
 *
 * Deleting our row destroys only our copy of the grant; Google keeps it live
 * until it is revoked there. So the grant is revoked first, best effort, and
 * the audit entry says whether Google confirmed it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockRevoke } = vi.hoisted(() => ({ mockRevoke: vi.fn() }))
vi.mock('../google-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../google-oauth')>()),
  revokeGoogleToken: (...args: unknown[]) => mockRevoke(...args),
}))

import { disconnect } from '../connections'
import { encryptToken } from '../crypto'

interface MockOptions {
  existing: Record<string, unknown> | null
  deleteError?: { message: string } | null
  /** Other active connections reading the same mailbox. */
  sharedCount?: number
  sharedError?: { message: string } | null
}

/** Records every statement in order, so the tests can say what ran before what. */
function mockSupabase(options: MockOptions, steps: string[] = []) {
  const inserted: Array<Record<string, unknown>> = []
  const client = {
    from(table: string) {
      let deleting = false
      let eqCalls = 0
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.eq = vi.fn(() => {
        eqCalls++
        // The delete resolves after its second .eq(); the reads go on.
        if (deleting && eqCalls >= 2) {
          steps.push('delete')
          return Promise.resolve({ error: options.deleteError ?? null })
        }
        return chain
      })
      // The shared-grant check is the only chain that ends in .neq().
      chain.neq = vi.fn(() => {
        steps.push('count_shared')
        return Promise.resolve({ count: options.sharedCount ?? 0, error: options.sharedError ?? null })
      })
      chain.maybeSingle = vi.fn(() => {
        steps.push('read')
        return Promise.resolve({ data: options.existing, error: null })
      })
      chain.delete = vi.fn(() => {
        deleting = true
        eqCalls = 0
        return chain
      })
      chain.insert = vi.fn((row: Record<string, unknown>) => {
        if (table === 'audit_log') {
          steps.push('audit')
          inserted.push(row)
        }
        return Promise.resolve({ error: null })
      })
      return chain
    },
  }
  return { client: client as never, inserted, steps }
}

let storedToken: string

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '11'.repeat(32))
  storedToken = encryptToken('refresh-token-1')
  mockRevoke.mockResolvedValue({ outcome: 'revoked', status: 200, error: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    email_address: 'ekonomi@nordvik.se',
    provider: 'gmail',
    encrypted_refresh_token: storedToken,
    ...overrides,
  }
}

describe('disconnect', () => {
  it('records who disconnected which mailbox, and when', async () => {
    const { client, inserted, steps } = mockSupabase({ existing: row() })
    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(steps).toContain('delete')
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      user_id: 'user-1',
      company_id: 'co-1',
      action: 'DELETE',
      table_name: 'mail_connections',
      record_id: 'conn-1',
    })
    expect(String(inserted[0].description)).toContain('ekonomi@nordvik.se')
  })

  it('revokes the grant at Google before the row goes, and records that Google confirmed it', async () => {
    const steps: string[] = []
    mockRevoke.mockImplementation(async () => {
      // The token only exists while the row does.
      steps.push('revoke')
      return { outcome: 'revoked', status: 200, error: null }
    })
    const { client, inserted } = mockSupabase({ existing: row() }, steps)

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(mockRevoke).toHaveBeenCalledWith('refresh-token-1')
    expect(steps.indexOf('revoke')).toBeGreaterThan(-1)
    expect(steps.indexOf('revoke')).toBeLessThan(steps.indexOf('delete'))
    expect(inserted[0].new_state).toEqual({ provider_revocation: 'revoked' })
  })

  it('still disconnects when Google does not confirm, and records that it did not', async () => {
    // A slow or broken Google must never keep a person from disconnecting:
    // destroying our copy is the part we control.
    mockRevoke.mockResolvedValue({ outcome: 'failed', status: null, error: 'TimeoutError' })
    const { client, inserted, steps } = mockSupabase({ existing: row() })

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(steps).toContain('delete')
    expect(inserted[0].new_state).toEqual({ provider_revocation: 'failed' })
  })

  it('records a grant Google no longer had as already invalid', async () => {
    mockRevoke.mockResolvedValue({ outcome: 'already_invalid', status: 400, error: 'invalid_token' })
    const { client, inserted } = mockSupabase({ existing: row() })

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(inserted[0].new_state).toEqual({ provider_revocation: 'already_invalid' })
  })

  it('leaves the Google grant alone while another company still reads the same mailbox', async () => {
    // One account, one OAuth client, one grant: revoking it here would cut
    // the other company off at its next search, without anyone asking.
    const { client, inserted, steps } = mockSupabase({ existing: row(), sharedCount: 1 })

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(mockRevoke).not.toHaveBeenCalled()
    expect(steps).toContain('delete')
    expect(inserted[0].new_state).toEqual({ provider_revocation: 'shared' })
  })

  it('does not revoke on a guess when it cannot tell whether the grant is shared', async () => {
    const { client, inserted, steps } = mockSupabase({
      existing: row(),
      sharedError: { message: 'statement timeout' },
    })

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(mockRevoke).not.toHaveBeenCalled()
    expect(steps).toContain('delete')
    expect(inserted[0].new_state).toEqual({ provider_revocation: 'failed' })
  })

  it('asks Google nothing when there is no token left to revoke with', async () => {
    const { client, inserted } = mockSupabase({ existing: row({ encrypted_refresh_token: '' }) })

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(mockRevoke).not.toHaveBeenCalled()
    expect(inserted[0].new_state).toEqual({ provider_revocation: 'no_token' })
  })

  it('never copies the credential into the audit trail', async () => {
    // The whole point of disconnecting is that the refresh token is gone.
    // A write_audit_log trigger would have carried it into a second table.
    const { client, inserted } = mockSupabase({ existing: row() })
    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    const blob = JSON.stringify(inserted[0])
    expect(blob).not.toContain(storedToken)
    expect(blob).not.toContain('refresh-token-1')
    expect(blob).not.toContain('encrypted_refresh_token')
  })

  it('does not claim a disconnect that the database refused', async () => {
    // An audit entry saying the mailbox was disconnected, while the row is
    // still there, is worse than no entry at all.
    const { client, inserted } = mockSupabase({
      existing: row(),
      deleteError: { message: 'permission denied' },
    })
    await expect(disconnect(client, 'co-1', 'conn-1', 'user-1')).rejects.toThrow('permission denied')
    expect(inserted).toEqual([])
  })

  it('writes nothing and asks Google nothing when there was no such connection', async () => {
    const { client, inserted } = mockSupabase({ existing: null })
    await disconnect(client, 'co-1', 'missing', 'user-1')
    expect(inserted).toEqual([])
    expect(mockRevoke).not.toHaveBeenCalled()
  })
})
