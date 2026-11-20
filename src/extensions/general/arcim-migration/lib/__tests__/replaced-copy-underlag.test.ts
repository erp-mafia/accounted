import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      warn: logWarn,
      error: logError,
    }),
  }
})

import { countUnderlagOnReplacedCopies } from '../replaced-copy-underlag'

function rpcAnswering(answer: { data?: unknown; error?: unknown } | Error) {
  const rpc = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return { data: answer.data ?? null, error: answer.error ?? null }
  })
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

/**
 * The count behind the migration workspace's offer to run "Hämta underlag"
 * again (#51): live verifikat without underlag whose reversed copy from an
 * earlier import holds it. The predicate itself is tested against Postgres
 * (tests/pg/underlag-left-on-replaced-copies.pg.test.ts); here, the one read
 * and the soft failure.
 */
describe('countUnderlagOnReplacedCopies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers the count the database gives for the company', async () => {
    const { supabase, rpc } = rpcAnswering({ data: 12 })

    expect(await countUnderlagOnReplacedCopies(supabase, 'company-1')).toBe(12)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('underlag_left_on_replaced_copies', { p_company_id: 'company-1' })
  })

  it('answers 0 when no verifikat is in that state', async () => {
    const { supabase } = rpcAnswering({ data: 0 })

    expect(await countUnderlagOnReplacedCopies(supabase, 'company-1')).toBe(0)
    expect(logError).not.toHaveBeenCalled()
  })

  it('answers 0 and logs the failure when the read fails', async () => {
    const { supabase } = rpcAnswering({
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    })

    expect(await countUnderlagOnReplacedCopies(supabase, 'company-1')).toBe(0)
    expect(logError).toHaveBeenCalledWith(
      'replaced-copy underlag count failed',
      expect.objectContaining({ message: 'canceling statement due to statement timeout', code: '57014' }),
      { companyId: 'company-1' },
    )
  })

  it('only warns while the function is not migrated yet', async () => {
    const { supabase } = rpcAnswering({ error: { message: 'Could not find the function', code: 'PGRST202' } })

    expect(await countUnderlagOnReplacedCopies(supabase, 'company-1')).toBe(0)
    expect(logWarn).toHaveBeenCalledWith(
      'replaced-copy underlag count skipped, function not migrated yet',
      { companyId: 'company-1', code: 'PGRST202' },
    )
    expect(logError).not.toHaveBeenCalled()
  })

  it('answers 0 when the call itself throws', async () => {
    const { supabase } = rpcAnswering(new Error('fetch failed'))

    expect(await countUnderlagOnReplacedCopies(supabase, 'company-1')).toBe(0)
    expect(logError).toHaveBeenCalledWith(
      'replaced-copy underlag count failed',
      expect.objectContaining({ message: 'fetch failed' }),
      { companyId: 'company-1' },
    )
  })

  it('reads anything but a positive whole number as no prompt', async () => {
    for (const data of [null, -1, 2.5, '3', { count: 3 }]) {
      const { supabase } = rpcAnswering({ data })
      expect(await countUnderlagOnReplacedCopies(supabase, 'company-1')).toBe(0)
    }
  })
})
