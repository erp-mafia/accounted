/**
 * Disconnecting a mailbox is a control change over how underlag reaches the
 * books, so it has to be reconstructable (BFNAR 2013:2 kap 8). What must NOT
 * happen is the audit entry preserving the credential the delete existed to
 * destroy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { disconnect } from '../connections'

function mockSupabase(
  existing: Record<string, unknown> | null,
  deleteError: { message: string } | null = null,
) {
  const inserted: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select']) chain[m] = vi.fn(() => chain)
      let eqCalls = 0
      chain.eq = vi.fn(() => {
        eqCalls++
        // The delete chain resolves after its second .eq(); the select chain
        // ends in .maybeSingle() instead.
        return chain.deleting && eqCalls >= 2
          ? Promise.resolve({ error: deleteError })
          : chain
      })
      chain.maybeSingle = vi.fn(() => Promise.resolve({ data: existing, error: null }))
      chain.delete = vi.fn(() => {
        deleted.push(table)
        ;(chain as Record<string, unknown>).deleting = true
        eqCalls = 0
        return chain
      })
      chain.insert = vi.fn((row: Record<string, unknown>) => {
        if (table === 'audit_log') inserted.push(row)
        return Promise.resolve({ error: null })
      })
      return chain
    },
  }
  return { client: client as never, inserted, deleted }
}

beforeEach(() => vi.clearAllMocks())

describe('disconnect', () => {
  it('records who disconnected which mailbox, and when', async () => {
    const { client, inserted, deleted } = mockSupabase({
      email_address: 'ekonomi@nordvik.se',
      provider: 'gmail',
    })
    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(deleted).toContain('mail_connections')
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

  it('never copies the credential into the audit trail', async () => {
    // The whole point of disconnecting is that the refresh token is gone.
    // A write_audit_log trigger would have carried it into a second table.
    const { client, inserted } = mockSupabase({
      email_address: 'ekonomi@nordvik.se',
      provider: 'gmail',
      encrypted_refresh_token: 'SECRET',
    })
    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    const blob = JSON.stringify(inserted[0])
    expect(blob).not.toContain('SECRET')
    expect(blob).not.toContain('encrypted_refresh_token')
  })

  it('does not claim a disconnect that the database refused', async () => {
    // An audit entry saying the mailbox was disconnected, while the credential
    // is still live, is worse than no entry at all.
    const { client, inserted } = mockSupabase(
      { email_address: 'ekonomi@nordvik.se', provider: 'gmail' },
      { message: 'permission denied' },
    )
    await expect(disconnect(client, 'co-1', 'conn-1', 'user-1')).rejects.toThrow('permission denied')
    expect(inserted).toEqual([])
  })

  it('writes nothing when there was no such connection', async () => {
    const { client, inserted } = mockSupabase(null)
    await disconnect(client, 'co-1', 'missing', 'user-1')
    expect(inserted).toEqual([])
  })
})
