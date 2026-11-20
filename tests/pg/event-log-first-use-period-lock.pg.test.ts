/**
 * period.locked reaches event_log with no module-level init anywhere.
 *
 * Entry points no longer call ensureInitialized(): eventBus.emit() waits for
 * the registered loader of lib/init (the event_log handler, the webhook
 * fan-out, every extension) on the first event and resolves only after the
 * handlers ran (lib/initialized.ts; instrumentation.ts registers the loader
 * in the app, tests/pg/setup.ts here). The 2026-09-30 audit found period.locked missing for
 * 636 of 758 locks, because the lock route never wired the bus. This drives
 * that route against real Postgres in a cold module graph with the real
 * lib/init: importing the route must not load lib/init, and the event_log row
 * must be committed by the time the handler has returned its response.
 *
 * The session wrapper (auth, MFA, active company) is reduced to handing the
 * route a client signed in as the owner; the event_log handler and the
 * webhook fan-out get a service_role client (tests/pg/sql-supabase-client.ts).
 * Its own file: a cold graph per scenario, as on a cold start.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'
import { sqlClient } from './sql-supabase-client'

const state = vi.hoisted(() => ({
  initLoads: 0,
  session: null as unknown,
  service: null as unknown,
  userId: '',
  companyId: '',
}))

// Counts loads of the real lib/init; only the loader tests/pg/setup.ts
// registers imports it.
vi.mock('@/lib/init', async (importOriginal) => {
  state.initLoads++
  return importOriginal()
})
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: () => state.service,
}))
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
  createServiceClient: () => state.service,
  // No request scope: extension handlers get no context, as in a cron.
  createClient: async () => {
    throw new Error('no request scope in this test')
  },
}))
vi.mock('@/lib/api/with-route-context', async () => {
  const { createLogger } = await import('@/lib/logger')
  return {
    withRouteContext:
      (_operation: string, handler: (...args: unknown[]) => Promise<Response>) =>
      (request: Request, routeContext: unknown) =>
        handler(
          request,
          {
            user: { id: state.userId },
            supabase: state.session as SupabaseClient,
            companyId: state.companyId,
            log: createLogger('pg-first-use'),
            requestId: 'pg-first-use',
          },
          routeContext,
        ),
  }
})

describe('period.locked on first use', () => {
  it('the lock route writes the event_log row before it returns, and loads lib/init only on the event', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    state.userId = userId
    state.companyId = companyId
    state.session = sqlClient('authenticated', userId)
    state.service = sqlClient('service_role', null)

    const { POST } = await import('@/app/api/bookkeeping/fiscal-periods/[id]/lock/route')
    expect(state.initLoads).toBe(0)

    const response = await POST(
      new Request(`http://localhost/api/bookkeeping/fiscal-periods/${fiscalPeriodId}/lock`, { method: 'POST' }),
      { params: Promise.resolve({ id: fiscalPeriodId }) },
    )

    expect(response.status).toBe(200)
    expect(state.initLoads).toBe(1)
    const { rows } = await getPool().query(
      `SELECT event_type, entity_id, user_id FROM public.event_log WHERE company_id = $1 ORDER BY sequence`,
      [companyId],
    )
    expect(rows).toEqual([{ event_type: 'period.locked', entity_id: fiscalPeriodId, user_id: userId }])
    const locked = await getPool().query(`SELECT locked_at FROM public.fiscal_periods WHERE id = $1`, [fiscalPeriodId])
    expect(locked.rows[0].locked_at).not.toBeNull()
  })
})
