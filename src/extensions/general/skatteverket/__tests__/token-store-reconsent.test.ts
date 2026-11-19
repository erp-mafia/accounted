import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mock = createTableMockSupabase()
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => mock.supabase,
}))

import { deleteTokens, markNeedsReconsent, storeTokens } from '../lib/token-store'

const anySupabase = {} as never

describe('markNeedsReconsent', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    process.env.SKATTEVERKET_TOKEN_ENCRYPTION_KEY = 'test-encryption-key'
    mock.reset()
  })

  it('flags only the stored token the verdict was reached on: its row id and refresh_count', async () => {
    // A job that lost a refresh race decided on row-a at refresh_count 0; the
    // winner, or a new BankID consent (which starts at 0 again), has replaced
    // the row meanwhile. storeTokens deletes and inserts, so the live row has
    // another id and the write misses it.
    await markNeedsReconsent(anySupabase, 'user-1', 'company-1', 'SESSION_EXPIRED', { rowId: 'row-a', refreshCount: 0 })

    expect(mock.payloads('skatteverket_tokens', 'update')).toEqual([
      { status: 'needs_reconsent', last_error_code: 'SESSION_EXPIRED', last_error_at: expect.any(String) },
    ])
    expect(mock.findCalls('skatteverket_tokens', 'eq')).toEqual([
      ['user_id', 'user-1'],
      ['company_id', 'company-1'],
      ['id', 'row-a'],
      ['refresh_count', 0],
    ])
  })

  it('flags the row whatever its version when the verdict names none (a scope the token never had)', async () => {
    await markNeedsReconsent(anySupabase, 'user-1', 'company-1', 'MISSING_SCOPE')

    expect(mock.findCalls('skatteverket_tokens', 'eq')).toEqual([
      ['user_id', 'user-1'],
      ['company_id', 'company-1'],
    ])
  })
})

describe('the stored token version', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    process.env.SKATTEVERKET_TOKEN_ENCRYPTION_KEY = 'test-encryption-key'
    mock.reset()
  })

  it('storeTokens answers the id of the row it inserted, so a call made with the new token can name it', async () => {
    const id = await storeTokens(anySupabase, 'user-1', {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Date.parse('2026-11-13T12:00:00Z'),
      refresh_count: 2,
      scope: 'momsdeklaration',
    }, 'company-1')

    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(mock.payloads('skatteverket_tokens', 'insert')).toEqual([expect.objectContaining({ id, refresh_count: 2 })])
  })

  it('deletes only the named row when a verdict is about one stored token, and every row of the pair otherwise', async () => {
    await deleteTokens(anySupabase, 'user-1', 'company-1', 'row-revoked')
    expect(mock.findCalls('skatteverket_tokens', 'eq')).toEqual([
      ['user_id', 'user-1'],
      ['company_id', 'company-1'],
      ['id', 'row-revoked'],
    ])

    mock.reset()
    await deleteTokens(anySupabase, 'user-1', 'company-1')
    expect(mock.findCalls('skatteverket_tokens', 'eq')).toEqual([['user_id', 'user-1'], ['company_id', 'company-1']])
  })

  it('throws when the delete fails: the token is still stored, and nobody may be told it is gone', async () => {
    // The answer's error was dropped, so the revoked-token path's catch never
    // saw a failed delete and the disconnect route answered success.
    mock.setTable('skatteverket_tokens', { error: { message: 'connection reset' } })
    await expect(deleteTokens(anySupabase, 'user-1', 'company-1', 'row-revoked')).rejects.toThrow(
      'Failed to delete Skatteverket tokens: connection reset',
    )
  })
})
