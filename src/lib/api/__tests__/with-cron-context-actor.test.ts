import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))

import { withCronContext, cronCommitActor } from '../with-cron-context'
import { getActor, defaultCommitMethod } from '@/lib/bookkeeping/actor-context'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'

const request = () => new Request('https://example.test/api/x/cron')

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Every commit a cron job makes runs inside a 'cron' actor scope labelled with
 * the job, so commitEntry() and the posting RPC doors stamp
 * journal_entries.committed_actor_type = 'cron' and the job name instead of
 * NULL (and the audit_log COMMIT row stops defaulting to 'user').
 */
describe('withCronContext commit actor', () => {
  it('runs the handler as a cron actor named after the job', async () => {
    const res = await withCronContext('cron.accrual_postings', async () =>
      NextResponse.json({ actor: getActor() ?? null }),
    )(request())

    await expect(res.json()).resolves.toEqual({
      actor: { type: 'cron', label: 'cron.accrual_postings' },
    })
  })

  it('keeps the scope across awaits inside the job', async () => {
    const res = await withCronContext('cron.recurring_invoices', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      await Promise.resolve()
      return NextResponse.json({ actor: getActor() ?? null })
    })(request())

    await expect(res.json()).resolves.toEqual({
      actor: { type: 'cron', label: 'cron.recurring_invoices' },
    })
  })

  it('lets a path inside the job that opens its own scope record its own actor', async () => {
    const res = await withCronContext('cron.pending_operations_expire', async () => {
      const inner = await runWithActor({ type: 'user' }, async () => getActor())
      return NextResponse.json({ inner, outer: getActor() ?? null })
    })(request())

    await expect(res.json()).resolves.toEqual({
      inner: { type: 'user' },
      outer: { type: 'cron', label: 'cron.pending_operations_expire' },
    })
  })

  it('leaves no scope behind after the run', async () => {
    await withCronContext('cron.bank_sync', async () => NextResponse.json({}))(request())
    expect(getActor()).toBeUndefined()
  })

  it('records no commit_method for a cron commit', () => {
    expect(defaultCommitMethod(cronCommitActor('cron.bank_sync'))).toBeNull()
  })
})
