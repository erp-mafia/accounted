/**
 * Connecting a mailbox is audited like disconnecting one: when it started
 * feeding underlag into the books and who granted it, with safe columns only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { saveConnection } from '../connections'

function mockSupabase(options: { upsertError?: { message: string }; auditError?: { message: string } } = {}) {
  const upserts: Array<{ row: Record<string, unknown>; options: unknown }> = []
  const audits: Array<Record<string, unknown>> = []
  const client = {
    from(table: string) {
      if (table === 'audit_log') {
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            audits.push(row)
            return Promise.resolve({ error: options.auditError ?? null })
          }),
        }
      }
      const chain: Record<string, unknown> = {}
      chain.upsert = vi.fn((row: Record<string, unknown>, opts: unknown) => {
        upserts.push({ row, options: opts })
        return chain
      })
      chain.select = vi.fn(() => chain)
      chain.single = vi.fn(() =>
        Promise.resolve(
          options.upsertError ? { data: null, error: options.upsertError } : { data: { id: 'conn-9' }, error: null },
        ),
      )
      return chain
    },
  }
  return { client: client as never, upserts, audits }
}

const params = {
  companyId: 'co-1',
  userId: 'user-1',
  provider: 'gmail' as const,
  emailAddress: '  Ekonomi@Nordvik.se ',
  refreshToken: 'refresh-plain',
  accessToken: 'access-plain',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '33'.repeat(32))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('saveConnection', () => {
  it('audits who connected which mailbox, with the scopes Google granted', async () => {
    const { client, audits, upserts } = mockSupabase()

    await saveConnection(client, params)

    expect(upserts[0].options).toEqual({ onConflict: 'company_id,provider,email_address' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      user_id: 'user-1',
      company_id: 'co-1',
      action: 'INSERT',
      table_name: 'mail_connections',
      record_id: 'conn-9',
      new_state: {
        email_address: 'ekonomi@nordvik.se',
        provider: 'gmail',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      },
    })
    expect(String(audits[0].description)).toContain('ekonomi@nordvik.se')
  })

  it('never copies a token into the audit trail, plain or encrypted', async () => {
    const { client, audits, upserts } = mockSupabase()

    await saveConnection(client, params)

    const stored = upserts[0].row
    const blob = JSON.stringify(audits[0])
    expect(blob).not.toContain('refresh-plain')
    expect(blob).not.toContain('access-plain')
    expect(blob).not.toContain(String(stored.encrypted_refresh_token))
    expect(blob).not.toContain('encrypted_')
    // And the row itself stores ciphertext, never the plain token.
    expect(stored.encrypted_refresh_token).not.toBe('refresh-plain')
  })

  it('writes no audit entry for a grant that could not be saved', async () => {
    const { client, audits } = mockSupabase({ upsertError: { message: 'duplicate key' } })
    await expect(saveConnection(client, params)).rejects.toThrow('duplicate key')
    expect(audits).toEqual([])
  })

  it('keeps the saved grant when only the audit entry fails', async () => {
    const { client, audits } = mockSupabase({ auditError: { message: 'audit down' } })
    await expect(saveConnection(client, params)).resolves.toBeUndefined()
    expect(audits).toHaveLength(1)
  })
})
