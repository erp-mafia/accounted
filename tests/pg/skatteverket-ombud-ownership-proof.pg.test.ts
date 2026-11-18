/**
 * Ombud connection on a contested org number (product decision 2026-11-08,
 * migration 20261108074117_skatteverket_audit_auth_mode.sql), against real
 * Postgres: the real connection-store reads company_settings, companies,
 * company_members and skatteverket_api_audit_log through supabase-js.
 *
 *   - a sole live claimant is clear without any proof, as before, and a row a
 *     company left on a number it no longer claims is never clear;
 *   - among several claimants only the company where a current member's own
 *     BankID session read the skattekonto for that number is clear;
 *   - no row a tenant could produce without Skatteverket accepting the person
 *     counts: a read on Accounted's certificate, a refused read, a read for
 *     another number, a read by someone who is no longer a member, a row from
 *     before auth_mode existed;
 *   - proof is per company: a member of two companies on one number proves
 *     only the one they connected, and two proven claimants are both held back;
 *   - the audit writer records auth_mode, the column takes nothing else, and
 *     the row stays immutable.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts.
 */
import { randomInt } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getOmbudClaimStandings } from '@/extensions/general/skatteverket/lib/connection-store'
import { writeSkatteverketAudit } from '@/extensions/general/skatteverket/lib/audit'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
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

beforeAll(() => {
  // connection-store builds its service client from these.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://pg-real.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'pg-real-service-role'
})

afterEach(() => {
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

/** A fresh aktiebolag number no other test uses: stored as NNNNNN-NNNN, read as 16NNNNNNNNNN. */
function freshOrgNumber(): { stored: string; redovisare: string } {
  const digits = `559${String(randomInt(0, 10_000_000)).padStart(7, '0')}`
  return { stored: `${digits.slice(0, 6)}-${digits.slice(6)}`, redovisare: `16${digits}` }
}

/** A live company claiming `orgNumber`, with `members` (the first one created it). */
async function claimant(orgNumber: string, members: string[]): Promise<string> {
  const companyId = await insertCompany({ createdBy: members[0]!, entityType: 'aktiebolag' })
  for (const userId of members) await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, org_number)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, $3)`,
    [members[0], companyId, orgNumber],
  )
  return companyId
}

/** One audit row as the transport writes it, auth_mode included. */
async function auditRow(row: {
  companyId: string
  userId: string | null
  redovisare: string
  authMode: 'user' | 'system' | null
  endpoint?: string
  outcome?: string
  status?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.skatteverket_api_audit_log
       (company_id, user_id, endpoint, ag_registered_id, outcome, response_status, auth_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.companyId,
      row.userId,
      row.endpoint ?? 'skattekonto/saldo',
      row.redovisare,
      row.outcome ?? 'ok',
      row.status ?? 200,
      row.authMode,
    ],
  )
}

async function standings(claims: Array<{ companyId: string; orgNumber: string }>) {
  return Object.fromEntries(await getOmbudClaimStandings(claims))
}

describe('ombud claim on a contested org number (pg)', () => {
  it('a sole live claimant is clear without proof; an archived copy does not contest it', async () => {
    const org = freshOrgNumber()
    const owner = await insertAuthUser()
    const live = await claimant(org.stored, [owner])
    const archived = await claimant(org.stored, [owner])
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [archived])

    expect(await standings([{ companyId: live, orgNumber: org.redovisare }])).toEqual({ [live]: 'clear' })
  })

  it("the company whose member read the skattekonto on their own BankID is clear; the stranger who typed the number is not", async () => {
    const org = freshOrgNumber()
    const owner = await insertAuthUser()
    const stranger = await insertAuthUser()
    const real = await claimant(org.stored, [owner])
    const typo = await claimant(org.stored, [stranger])
    await auditRow({ companyId: real, userId: owner, redovisare: org.redovisare, authMode: 'user' })

    expect(
      await standings([
        { companyId: real, orgNumber: org.redovisare },
        { companyId: typo, orgNumber: org.redovisare },
      ]),
    ).toEqual({ [real]: 'clear', [typo]: 'unproven' })
  })

  it('nothing a tenant can produce without Skatteverket accepting the person counts as proof', async () => {
    const org = freshOrgNumber()
    const other = freshOrgNumber()
    const stranger = await insertAuthUser()
    const formerMember = await insertAuthUser()
    const owner = await insertAuthUser()
    await claimant(org.stored, [owner])
    const typo = await claimant(org.stored, [stranger])
    const base = { companyId: typo, redovisare: org.redovisare }
    // Accounted's own certificate answered: no person was asked.
    await auditRow({ ...base, userId: stranger, authMode: 'system' })
    // Skatteverket refused the stranger's own session.
    await auditRow({ ...base, userId: stranger, authMode: 'user', outcome: 'auth_error', status: 403 })
    // No skattekonto for the identity: not a 2xx.
    await auditRow({ ...base, userId: stranger, authMode: 'user', outcome: 'skv_error', status: 404 })
    // The stranger's own number, read in this company.
    await auditRow({ ...base, redovisare: other.redovisare, userId: stranger, authMode: 'user' })
    // A read that is not a skattekonto read.
    await auditRow({ ...base, userId: stranger, authMode: 'user', endpoint: 'system-connection/deeplink' })
    // Someone who is not (or no longer) a member.
    await auditRow({ ...base, userId: formerMember, authMode: 'user' })
    // A row from before auth_mode was recorded.
    await auditRow({ ...base, userId: stranger, authMode: null })

    expect(await standings([{ companyId: typo, orgNumber: org.redovisare }])).toEqual({ [typo]: 'unproven' })
  })

  it('proof is per company: a member of two companies on one number proves only the one they connected', async () => {
    const org = freshOrgNumber()
    const accountant = await insertAuthUser()
    const copyA = await claimant(org.stored, [accountant])
    const copyB = await claimant(org.stored, [accountant])
    await auditRow({ companyId: copyA, userId: accountant, redovisare: org.redovisare, authMode: 'user' })
    const claims = [
      { companyId: copyA, orgNumber: org.redovisare },
      { companyId: copyB, orgNumber: org.redovisare },
    ]

    expect(await standings(claims)).toEqual({ [copyA]: 'clear', [copyB]: 'unproven' })

    // Connecting the second company too proves it as well: the grant can then follow neither.
    await auditRow({
      companyId: copyB,
      userId: accountant,
      redovisare: org.redovisare,
      authMode: 'user',
      endpoint: 'skattekonto/transaktioner',
    })
    expect(await standings(claims)).toEqual({ [copyA]: 'proven_twice', [copyB]: 'proven_twice' })
  })

  it('a row left on a number the company no longer answers for never picks up the sole claimant\'s standing', async () => {
    const victim = freshOrgNumber()
    const own = freshOrgNumber()
    const tenant = await insertAuthUser()
    const owner = await insertAuthUser()
    // The tenant's connection row was made on the victim's number, then the
    // tenant moved its settings to its own number; the victim joined later.
    const moved = await claimant(own.stored, [tenant])
    const real = await claimant(victim.stored, [owner])

    expect(
      await standings([
        { companyId: moved, orgNumber: victim.redovisare },
        { companyId: real, orgNumber: victim.redovisare },
      ]),
    ).toEqual({ [moved]: 'unproven', [real]: 'clear' })
  })

  it('a row whose company now answers for another number is held back on a contested old number', async () => {
    const org = freshOrgNumber()
    const moved = freshOrgNumber()
    const owner = await insertAuthUser()
    const a = await claimant(org.stored, [owner])
    await claimant(org.stored, [await insertAuthUser()])
    const switched = await claimant(moved.stored, [owner])
    await auditRow({ companyId: switched, userId: owner, redovisare: org.redovisare, authMode: 'user' })

    // `switched` holds a connection row recorded for `org` but no longer claims it.
    expect(
      await standings([
        { companyId: a, orgNumber: org.redovisare },
        { companyId: switched, orgNumber: org.redovisare },
      ]),
    ).toEqual({ [a]: 'unproven', [switched]: 'unproven' })
  })
})

describe('skatteverket_api_audit_log.auth_mode (pg)', () => {
  it('the audit writer records which credentials the call ran on', async () => {
    const owner = await insertAuthUser()
    const org = freshOrgNumber()
    const companyId = await claimant(org.stored, [owner])
    for (const authMode of ['user', 'system'] as const) {
      await writeSkatteverketAudit(
        { companyId, userId: owner },
        { endpoint: 'skattekonto/saldo', authMode, agRegistreradId: org.redovisare, outcome: 'ok', responseStatus: 200 },
      )
    }
    const { rows } = await getPool().query<{ auth_mode: string | null }>(
      `SELECT auth_mode FROM public.skatteverket_api_audit_log WHERE company_id = $1 ORDER BY auth_mode`,
      [companyId],
    )
    expect(rows.map((row) => row.auth_mode)).toEqual(['system', 'user'])
  })

  it('takes user, system or nothing, and the row stays immutable', async () => {
    const owner = await insertAuthUser()
    const org = freshOrgNumber()
    const companyId = await claimant(org.stored, [owner])
    await expect(
      auditRow({ companyId, userId: owner, redovisare: org.redovisare, authMode: 'robot' as never }),
    ).rejects.toThrow(/check constraint/)
    await auditRow({ companyId, userId: owner, redovisare: org.redovisare, authMode: 'system' })
    await expect(
      getPool().query(
        `UPDATE public.skatteverket_api_audit_log SET auth_mode = 'user' WHERE company_id = $1`,
        [companyId],
      ),
    ).rejects.toThrow(/cannot be modified or deleted/)
  })
})
