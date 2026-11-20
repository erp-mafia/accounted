import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { actorRpcParams, isMissingRpcSignature, rpcWithActor } from '../actor-rpc'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'

type RpcResult = { data: unknown; error: { code?: string; message: string } | null }

function clientAnswering(...answers: RpcResult[]) {
  const rpc = vi.fn()
  for (const answer of answers) rpc.mockResolvedValueOnce(answer)
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

const PARAMS = { p_company_id: 'company-1', p_entry_id: 'entry-1' }
const MISSING = { code: 'PGRST202', message: 'Could not find the function public.correct_entry_metadata(...) in the schema cache' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('actorRpcParams', () => {
  it('maps an actor onto the two RPC parameters, a missing label to null', () => {
    expect(actorRpcParams({ type: 'api_key', label: 'Bokföringsagent' })).toEqual({
      p_actor_type: 'api_key',
      p_actor_label: 'Bokföringsagent',
    })
    expect(actorRpcParams({ type: 'user' })).toEqual({ p_actor_type: 'user', p_actor_label: null })
  })

  it('is null without an actor: nothing to record', () => {
    expect(actorRpcParams(undefined)).toBeNull()
  })
})

describe('isMissingRpcSignature', () => {
  it('recognises PostgREST PGRST202 and Postgres 42883 only', () => {
    expect(isMissingRpcSignature({ code: 'PGRST202' })).toBe(true)
    expect(isMissingRpcSignature({ code: '42883' })).toBe(true)
    expect(isMissingRpcSignature({ code: 'P0001' })).toBe(false)
    expect(isMissingRpcSignature({ code: 'PGRST203' })).toBe(false)
    expect(isMissingRpcSignature(null)).toBe(false)
  })
})

describe('rpcWithActor', () => {
  it('sends the actor of the current scope beside the parameters', async () => {
    const { client, rpc } = clientAnswering({ data: { log_id: 'log-1' }, error: null })

    const answer = await runWithActor({ type: 'mcp_oauth', label: 'Claude' }, () =>
      rpcWithActor(client, 'correct_entry_metadata', PARAMS),
    )

    expect(answer).toEqual({ data: { log_id: 'log-1' }, error: null })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('correct_entry_metadata', {
      ...PARAMS,
      p_actor_type: 'mcp_oauth',
      p_actor_label: 'Claude',
    })
  })

  it('sends no actor parameters outside an actor scope (the function defaults apply)', async () => {
    const { client, rpc } = clientAnswering({ data: { ok: true }, error: null })

    await rpcWithActor(client, 'correct_entry_metadata', PARAMS)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('correct_entry_metadata', PARAMS)
  })

  it('takes an explicit actor over the scope', async () => {
    const { client, rpc } = clientAnswering({ data: null, error: null })

    await runWithActor({ type: 'user' }, () =>
      rpcWithActor(client, 'request_sie_import_undo', PARAMS, { type: 'cron', label: 'cron.x' }),
    )

    expect(rpc).toHaveBeenCalledWith('request_sie_import_undo', { ...PARAMS, p_actor_type: 'cron', p_actor_label: 'cron.x' })
  })

  it('retries once without the actor parameters when the database does not have them yet (PGRST202)', async () => {
    const { client, rpc } = clientAnswering(
      { data: null, error: MISSING },
      { data: { log_id: 'log-2' }, error: null },
    )

    const answer = await runWithActor({ type: 'api_key', label: 'CI key' }, () =>
      rpcWithActor(client, 'correct_entry_metadata', PARAMS),
    )

    expect(answer).toEqual({ data: { log_id: 'log-2' }, error: null })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenNthCalledWith(1, 'correct_entry_metadata', {
      ...PARAMS,
      p_actor_type: 'api_key',
      p_actor_label: 'CI key',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'correct_entry_metadata', PARAMS)
  })

  it('also retries on 42883 and returns the retry answer, a refusal included', async () => {
    const refusal = { code: 'P0001', message: 'Perioden är stängd eller låst' }
    const { client, rpc } = clientAnswering(
      { data: null, error: { code: '42883', message: 'function does not exist' } },
      { data: null, error: refusal },
    )

    const answer = await runWithActor({ type: 'user' }, () => rpcWithActor(client, 'correct_entry_lines_inline', PARAMS))

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(answer).toEqual({ data: null, error: refusal })
  })

  it('never retries any other error', async () => {
    const refusal = { code: 'P0001', message: 'Endast bokförda verifikat kan rättas' }
    const { client, rpc } = clientAnswering({ data: null, error: refusal })

    const answer = await runWithActor({ type: 'user' }, () => rpcWithActor(client, 'correct_entry_metadata', PARAMS))

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(answer.error).toEqual(refusal)
  })

  it('retries at most once', async () => {
    const { client, rpc } = clientAnswering({ data: null, error: MISSING }, { data: null, error: MISSING })

    const answer = await runWithActor({ type: 'user' }, () => rpcWithActor(client, 'correct_entry_metadata', PARAMS))

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(answer.error).toEqual(MISSING)
  })
})
