/**
 * Winding down against real Postgres (migration 20261016230000 and the
 * obligation probes, src/lib/modules/obligations.ts):
 *
 *   - set_company_package_choice switches a package off whatever is still
 *     open in it; the capabilities then read winding_down with the open
 *     obligations named, and off once they are settled;
 *   - every probe's query runs on the real schema: an empty company has no
 *     obligation in any package (a failed read would count as open), and the
 *     PostgREST shim answered every request;
 *   - the start gate reads the switch through RLS as a member (the session
 *     doors) and through the service role (v1, MCP, approvals).
 *
 * Only the HTTP hop to PostgREST is replaced (./postgrest-over-pg.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { loadOpenObligations } from '@/lib/modules/obligations'
import { PACKAGES } from '@/lib/modules/packages'
import type * as Gate from '@/lib/modules/package-gate'
import { seedCompany } from './fixtures'
import { getPool, runAsServiceRole } from './setup'
import { createPgRest, type PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

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

const memberShims: PgRest[] = []

/** A supabase-js client acting as a signed-in member, through RLS. */
function memberClient(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  memberShims.push(rest)
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    global: { fetch: rest.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

afterEach(() => {
  const unsupported = [...(shim.rest?.unsupported.splice(0) ?? []), ...memberShims.flatMap((r) => r.unsupported.splice(0))]
  memberShims.length = 0
  expect(unsupported).toEqual([])
})

async function switchPackage(companyId: string, userId: string, packageId: string, enabled: boolean) {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.set_company_package_choice($1, $2, $3, 'company', $4) AS result`,
      [companyId, packageId, enabled, userId],
    )
    return rows[0].result
  })
}

describe('winding down', () => {
  it('switches Lön off with a salary run still open: winding down until the run is gone, then off', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
       VALUES ($1, $2, $3, 2026, 10, '2026-10-25', 'draft')`,
      [runId, companyId, userId],
    )

    const result = await switchPackage(companyId, userId, 'payroll', false)
    expect(result).toMatchObject({ ok: true, unchanged: false, enabled: false })
    expect(result.code).toBeUndefined()

    const supabase = createServiceClientNoCookies()
    const winding = (await loadCompanyCapabilities(supabase, companyId))!.packages.find((p) => p.id === 'payroll')!
    expect(winding).toMatchObject({
      availability: 'winding_down',
      reasons: ['turned_off_by_company', 'open_obligations'],
      open_obligations: ['open_salary_runs'],
    })

    await getPool().query(`DELETE FROM public.salary_runs WHERE id = $1`, [runId])
    const settled = (await loadCompanyCapabilities(supabase, companyId))!.packages.find((p) => p.id === 'payroll')!
    expect(settled).toMatchObject({ availability: 'off', open_obligations: [] })

    const { rows: audit } = await getPool().query(
      `SELECT description FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_capability_config'`,
      [companyId],
    )
    expect(audit.map((r) => r.description)).toEqual(['Switched package off: payroll'])
  })

  it('runs every probe on the real schema: an empty company owes nothing in any package', async () => {
    const { companyId } = await seedCompany()
    const open = await loadOpenObligations(
      createServiceClientNoCookies(),
      companyId,
      PACKAGES.map((p) => p.id),
    )
    for (const pkg of PACKAGES.filter((p) => p.switchable)) expect(open[pkg.id], pkg.id).toEqual([])
  })
})

describe('the package start gate', () => {
  // tests/unit/setup.ts stubs the gate for unit tests only; pg-real loads the real one.
  it('reads the switch as the service role and as a member through RLS', async () => {
    const gate = await vi.importActual<typeof Gate>('@/lib/modules/package-gate')
    const { userId, companyId } = await seedCompany()

    expect(await gate.packageStartRefusal(createServiceClientNoCookies(), companyId, 'assets')).toBeNull()
    expect(await gate.packageStartRefusal(memberClient(userId), companyId, 'assets')).toBeNull()

    await switchPackage(companyId, userId, 'assets', false)
    for (const client of [createServiceClientNoCookies(), memberClient(userId)]) {
      expect(await gate.packageStartRefusal(client, companyId, 'assets')).toMatchObject({
        code: 'PACKAGE_OFF',
        details: { package_id: 'assets', reason: 'turned_off_by_company', resolution: 'Slå på Inventarier under Anpassa.' },
      })
    }

    await switchPackage(companyId, userId, 'assets', true)
    expect(await gate.packageStartRefusal(memberClient(userId), companyId, 'assets')).toBeNull()
  })

  it('refuses a start the profile leaves off, for a member', async () => {
    const gate = await vi.importActual<typeof Gate>('@/lib/modules/package-gate')
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `UPDATE public.companies SET profile_id = 'limited-company-no-employees', profile_version = 1 WHERE id = $1`,
      [companyId],
    )
    expect(await gate.packageStartRefusal(memberClient(userId), companyId, 'payroll')).toMatchObject({
      details: { reason: 'off_in_profile' },
    })
    expect(await gate.packageStartRefusal(memberClient(userId), companyId, 'customer-invoices')).toBeNull()
  })
})
