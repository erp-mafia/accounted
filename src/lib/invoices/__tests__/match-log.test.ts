import { beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { logMatchEvent } from '../match-log'

function client(answer: { error: unknown } | Error) {
  const insert = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  return { supabase: { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient, insert }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('logMatchEvent', () => {
  it('writes the audit row and logs nothing when it lands', async () => {
    const { supabase, insert } = client({ error: null })
    await logMatchEvent(supabase, 'user-1', 'tx-1', 'matched', { invoiceId: 'inv-1', matchConfidence: 1, matchMethod: 'manual' })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-1', transaction_id: 'tx-1', action: 'matched', invoice_id: 'inv-1' }))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('reports a refused insert, which supabase-js answers with an error instead of a throw', async () => {
    const { supabase } = client({ error: { code: '23514', message: 'violates check constraint "payment_match_log_action_check"' } })
    await expect(logMatchEvent(supabase, 'user-1', 'tx-1', 'auto_matched')).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledWith('payment match audit row not written', expect.objectContaining({ transactionId: 'tx-1', action: 'auto_matched', code: '23514' }))
  })

  it('never throws, and reports a thrown insert too', async () => {
    const { supabase } = client(new Error('fetch failed'))
    await expect(logMatchEvent(supabase, 'user-1', 'tx-1', 'unmatched')).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledWith('payment match audit row not written', expect.any(Error), expect.objectContaining({ transactionId: 'tx-1', action: 'unmatched' }))
  })
})
