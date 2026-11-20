/**
 * The exit check of the Profiles and Suggestions design's step 3, as one
 * pg-real walk through production code (src/lib/suggestions and the commit
 * executors), against the real schema:
 *
 *   "Registering the first employee puts 'Slå på Lön?' in Att göra and in
 *    the customer's agent briefing; the user accepts it, which switches
 *    payroll on and writes a receipt and a dated line in behandlingshistorik."
 *
 *   1. A company whose profile leaves Lön off (Aktiebolag utan anställda)
 *      registers an employee through createEmployee, the one write every door
 *      uses; its employee.created event reaches the first-employee detector,
 *      which stages "Slå på Lön?" as the system, once.
 *   2. listOpenSuggestions (what Att göra and the briefing read) shows it.
 *   3. The owner's agent approves it with a key (commitPendingOperation, as
 *      the MCP approve tool does): set_company_package_choice writes the
 *      choice with who decided, the resolved capabilities say payroll is on,
 *      the suggestion is accepted, and behandlingshistorik carries the dated
 *      "Paket påslaget" line naming the key.
 *   4. A second suggestion answered "Inte nu" through the shared reject write
 *      is snoozed, and the detector does not stage it again.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in tests/pg/phase1-exit-check.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test). The detectors are run through runEventDetectors, the function the
 * bus subscription calls (src/lib/suggestions/handler.ts), so the walk does
 * not depend on lib/init loading every extension in this process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { createEmployee } from '@/lib/salary/employee-commands'
import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { listOpenSuggestions } from '@/lib/suggestions/list'
import { runEventDetectors } from '@/lib/suggestions/handler'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { rejectPendingOperations } from '@/lib/pending-operations/reject'
import { generateBehandlingshistorik } from '@/lib/reports/behandlingshistorik'
import type { PendingOperation } from '@/types'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})

afterEach(() => {
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

async function companyWithoutPayroll() {
  const seeded = await seedCompany()
  await getPool().query(
    `UPDATE public.companies SET profile_id = 'limited-company-no-employees', profile_version = 1 WHERE id = $1`,
    [seeded.companyId],
  )
  return seeded
}

async function registerEmployee(companyId: string, userId: string): Promise<string> {
  const result = await createEmployee(createServiceClientNoCookies(), {
    companyId,
    userId,
    input: {
      first_name: 'Anna',
      last_name: 'Andersson',
      employment_start: '2026-10-01',
      personnummer_encrypted: encryptPersonnummer('190001010000'),
      personnummer_last4: '0000',
    },
  })
  if (!result.ok) throw new Error(`createEmployee refused: ${result.code}`)
  return result.data.employee_id as string
}

async function pendingOperation(id: string): Promise<PendingOperation> {
  const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [id])
  return rows[0] as PendingOperation
}

describe('suggestions exit check: Slå på Lön?, staged by an event, accepted through the agent', () => {
  it('stages it once, shows it, and an approval switches payroll on with a receipt and a dated line', async () => {
    const { userId, companyId, fiscalPeriodId } = await companyWithoutPayroll()
    const supabase = createServiceClientNoCookies()
    expect((await loadCompanyCapabilities(supabase, companyId))!.packages.find((p) => p.id === 'payroll')!.availability).toBe('off')

    // 1. The event wakes the detector; a second employee does not stage it again.
    for (let i = 0; i < 2; i++) {
      const employeeId = i === 0 ? await registerEmployee(companyId, userId) : randomUUID()
      await runEventDetectors({ type: 'employee.created', payload: { employeeId, userId, companyId } })
    }
    const { rows: staged } = await getPool().query(
      `SELECT id, operation_type, actor_type, actor_label, title, risk_level, params, status
         FROM public.pending_operations WHERE company_id = $1`,
      [companyId],
    )
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatchObject({
      operation_type: 'enable_package',
      actor_type: 'system',
      actor_label: 'Accounted',
      title: 'Slå på Lön?',
      risk_level: 'low',
      status: 'pending',
      params: { package_id: 'payroll', source: 'suggestion', suggestion_key: 'enable_package:payroll' },
    })

    // 2. What Att göra and the agent briefing read.
    const open = await listOpenSuggestions(supabase, companyId)
    expect(open).toEqual([
      expect.objectContaining({
        pending_operation_id: staged[0].id,
        detector: 'first-employee',
        package_id: 'payroll',
        title: 'Slå på Lön?',
        reason: expect.stringMatching(/^Du har registrerat en anställd\./),
      }),
    ])

    // 3. The owner's agent relays the yes with the owner's key.
    const result = await commitPendingOperation(supabase, userId, companyId, await pendingOperation(staged[0].id), {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude' },
    })
    expect(result).toMatchObject({ status: 'committed', data: { package_id: 'payroll', enabled: true, changed: true } })

    const { rows: choice } = await getPool().query(
      `SELECT enabled, source, decided_by, decided_actor_type, decided_actor_label, pending_operation_id
         FROM public.company_capability_config WHERE company_id = $1 AND capability_key = 'package:payroll'`,
      [companyId],
    )
    expect(choice).toEqual([
      {
        enabled: true,
        source: 'suggestion',
        decided_by: userId,
        decided_actor_type: 'api_key',
        decided_actor_label: 'Claude',
        pending_operation_id: staged[0].id,
      },
    ])
    expect((await loadCompanyCapabilities(supabase, companyId))!.packages.find((p) => p.id === 'payroll')!.availability).toBe('on')
    const { rows: suggestion } = await getPool().query(
      `SELECT state FROM public.company_suggestions WHERE company_id = $1 AND suggestion_key = 'enable_package:payroll'`,
      [companyId],
    )
    expect(suggestion).toEqual([{ state: 'accepted' }])
    expect(await listOpenSuggestions(supabase, companyId)).toEqual([])
    expect((await pendingOperation(staged[0].id)).status).toBe('committed')

    // The dated line in behandlingshistorik, naming the key that relayed it.
    const report = await generateBehandlingshistorik(supabase, companyId, { periodId: fiscalPeriodId, categories: ['installningar'] })
    const line = report!.events.find((e) => e.code === 'package.switched_on')
    expect(line).toMatchObject({
      category: 'installningar',
      event: 'Paket påslaget',
      object: 'Lön',
      details: ['Källa: godkänt förslag'],
      actor: expect.objectContaining({ type: 'api_key' }),
      source: 'audit_log',
    })
    expect(line!.occurred_at.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('"Inte nu" through the shared reject write snoozes it, and the detector leaves it alone', async () => {
    const { userId, companyId } = await companyWithoutPayroll()
    const supabase = createServiceClientNoCookies()
    const event = { type: 'pos.connected' as const, payload: { connectionId: randomUUID(), provider: 'heynow', userId, companyId } }
    await runEventDetectors(event)
    const [open] = await listOpenSuggestions(supabase, companyId)
    expect(open).toMatchObject({ suggestion_key: 'enable_package:pos-and-webshop', title: 'Slå på Kassa och webbshop?' })

    const rejected = await rejectPendingOperations(supabase, {
      companyId,
      ids: [open.pending_operation_id],
      category: 'other',
      reason: 'Inte nu',
      actor: { userId, type: 'user' },
      channel: 'app',
    })
    expect(rejected).toMatchObject({ ok: true, outcomes: [{ outcome: 'rejected' }] })
    const { rows } = await getPool().query(
      `SELECT state, snoozed_until > now() + interval '29 days' AS a_month_out
         FROM public.company_suggestions WHERE company_id = $1`,
      [companyId],
    )
    expect(rows).toEqual([{ state: 'snoozed', a_month_out: true }])

    await runEventDetectors(event)
    const { rows: ops } = await getPool().query(`SELECT count(*)::int AS n FROM public.pending_operations WHERE company_id = $1`, [companyId])
    expect(ops).toEqual([{ n: 1 }])
    expect(await listOpenSuggestions(supabase, companyId)).toEqual([])
  })
})
