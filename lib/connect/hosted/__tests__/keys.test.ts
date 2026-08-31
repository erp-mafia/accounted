import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateConnectorKey, hashConnectorKey, isConnectorKeyFormat, validateConnectorKey } from '../keys'

function supabaseWithRpc(result: { data?: unknown; error?: unknown }): { supabase: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

const ROW = {
  connector_key_id: '11111111-1111-4111-8111-111111111111',
  org_number: '5561234567',
  instance_url: 'https://bokforing.example.se',
  scopes: ['bank_sync', 'skatteverket'],
  status: 'active',
  current_period_end: '2027-01-01T00:00:00.000Z',
  rate_limited: false,
}

describe('connector key primitives', () => {
  it('generates a gnubok_ck_ key with a display prefix and a SHA-256 hash', () => {
    const { key, hash, prefix } = generateConnectorKey()
    expect(key.startsWith('gnubok_ck_')).toBe(true)
    expect(key.length).toBeGreaterThan(40)
    expect(prefix).toBe(key.slice(0, 18))
    expect(hash).toBe(hashConnectorKey(key))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(generateConnectorKey().key).not.toBe(key)
  })

  it('recognises the key format', () => {
    expect(isConnectorKeyFormat(generateConnectorKey().key)).toBe(true)
    expect(isConnectorKeyFormat('gnubok_sk_abcdefghijklmnopqrstuvwxyz')).toBe(false)
    expect(isConnectorKeyFormat('gnubok_ck_short')).toBe(false)
  })
})

describe('validateConnectorKey', () => {
  it('rejects a malformed key without touching the database', async () => {
    const { supabase, rpc } = supabaseWithRpc({ data: [ROW] })
    expect(await validateConnectorKey('nope', supabase)).toMatchObject({ ok: false, status: 401, code: 'CONNECTOR_KEY_INVALID' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('hashes the key and calls the atomic RPC', async () => {
    const { key, hash } = generateConnectorKey()
    const { supabase, rpc } = supabaseWithRpc({ data: [ROW] })
    const result = await validateConnectorKey(key, supabase)
    expect(rpc).toHaveBeenCalledWith('validate_and_increment_connector_key', { p_key_hash: hash })
    expect(result).toEqual({
      ok: true,
      key: {
        id: ROW.connector_key_id,
        orgNumber: '5561234567',
        instanceUrl: 'https://bokforing.example.se',
        scopes: ['bank_sync', 'skatteverket'],
        status: 'active',
        currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      },
    })
  })

  it('maps no row (unknown/revoked) to 401, but an RPC error to 503', async () => {
    const { key } = generateConnectorKey()
    expect(await validateConnectorKey(key, supabaseWithRpc({ data: [] }).supabase)).toMatchObject({ ok: false, status: 401 })
    // NEVER 401 on a database error: the instance sync deletes its whole
    // connector grant cache on 401/403, so a hosted pooler blip answered as
    // 401 would destroy a paying instance's 72h offline grace. 503 lands in
    // the sync's keep-grants branch.
    expect(await validateConnectorKey(key, supabaseWithRpc({ error: { message: 'boom' } }).supabase)).toMatchObject({
      ok: false,
      status: 503,
      code: 'CONNECTOR_VALIDATION_UNAVAILABLE',
    })
  })

  it('maps a suspended key to 403 and a rate-limited one to 429', async () => {
    const { key } = generateConnectorKey()
    expect(
      await validateConnectorKey(key, supabaseWithRpc({ data: [{ ...ROW, status: 'suspended' }] }).supabase),
    ).toMatchObject({ ok: false, status: 403, code: 'CONNECTOR_KEY_SUSPENDED' })
    expect(
      await validateConnectorKey(key, supabaseWithRpc({ data: [{ ...ROW, rate_limited: true }] }).supabase),
    ).toMatchObject({ ok: false, status: 429, code: 'CONNECTOR_RATE_LIMITED' })
  })
})
