import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

/**
 * Migration 20260901081417_multi_user_paywall.sql: the multi-user seat gate.
 *
 *   - seed_trial_capability_grants() seeds the eighth key ('multi_user')
 *   - company_multi_user_ok(company, grace_days): entitled-or-in-grace
 *   - resolve_active_company_gated(grace_days): resolution that skips
 *     non-owner memberships in frozen companies and reports
 *     has_locked_membership when nothing resolved because of the gate
 *
 * TS twin: lib/entitlements/multi-user-state.ts; keep semantics aligned.
 */

const GRACE_DAYS = 20

async function setMultiUserExpiry(companyId: string, interval: string): Promise<void> {
  // Push every grant on the company into the past/future in one stroke, so a
  // freshly trial-seeded company can be placed in grace or frozen.
  await getPool().query(
    `UPDATE public.capability_grants
        SET expires_at = now() + $2::interval
      WHERE company_id = $1`,
    [companyId, interval],
  )
}

async function multiUserOk(companyId: string): Promise<boolean> {
  const res = await getPool().query<{ ok: boolean }>(
    `SELECT public.company_multi_user_ok($1, $2) AS ok`,
    [companyId, GRACE_DAYS],
  )
  return res.rows[0]!.ok
}

async function setActivePreference(userId: string, companyId: string | null): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

type GatedRow = {
  company_id: string | null
  locale: string | null
  used_fallback: boolean
  has_locked_membership: boolean
}

async function resolveGatedAs(userId: string): Promise<GatedRow | undefined> {
  return withUserContext(userId, async (client) => {
    const res = await client.query<GatedRow>(
      `SELECT * FROM public.resolve_active_company_gated($1)`,
      [GRACE_DAYS],
    )
    return res.rows[0]
  })
}

describe('multi-user paywall (pg)', () => {
  describe('trial seeding', () => {
    it('a new company is trial-seeded with multi_user among the paid keys', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      const res = await getPool().query<{ capability_key: string; source: string }>(
        `SELECT capability_key, source FROM public.capability_grants
          WHERE company_id = $1 AND capability_key = 'multi_user'`,
        [companyId],
      )
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0]!.source).toBe('trial')
    })
  })

  describe('company_multi_user_ok', () => {
    it('true while the trial grant is active', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      expect(await multiUserOk(companyId)).toBe(true)
    })

    it('true during the grace window (lapsed 5 days ago)', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      await setMultiUserExpiry(companyId, '-5 days')
      expect(await multiUserOk(companyId)).toBe(true)
    })

    it('false once the lapse is older than the grace window (25 days)', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      await setMultiUserExpiry(companyId, '-25 days')
      expect(await multiUserOk(companyId)).toBe(false)
    })

    it('false when the company has no multi_user grants at all', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      await getPool().query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [
        companyId,
      ])
      expect(await multiUserOk(companyId)).toBe(false)
    })

    it('a team-scoped grant covers the team companies (byrå partner shape)', async () => {
      const userId = await insertAuthUser()
      const teamRes = await getPool().query<{ id: string }>(
        `INSERT INTO public.teams (name, created_by) VALUES ('PG Byrå', $1) RETURNING id`,
        [userId],
      )
      const teamId = teamRes.rows[0]!.id
      const companyId = await insertCompany({ createdBy: userId })
      await getPool().query(`UPDATE public.companies SET team_id = $2 WHERE id = $1`, [
        companyId,
        teamId,
      ])
      await setMultiUserExpiry(companyId, '-25 days') // company-scoped: frozen
      await getPool().query(
        `INSERT INTO public.capability_grants (team_id, capability_key, source, expires_at)
         VALUES ($1, 'multi_user', 'manual', NULL)`,
        [teamId],
      )
      expect(await multiUserOk(companyId)).toBe(true)
    })
  })

  describe('company_multi_user_state (20260901083726 hardening)', () => {
    async function stateOf(companyId: string): Promise<{ state: string; grace_ends_at: string | null }> {
      const res = await getPool().query<{ state: string; grace_ends_at: string | null }>(
        `SELECT * FROM public.company_multi_user_state($1, $2)`,
        [companyId, GRACE_DAYS],
      )
      return res.rows[0]!
    }

    it('entitled while a grant is active, grace with the deadline after a lapse, frozen past it', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      expect((await stateOf(companyId)).state).toBe('entitled')

      await setMultiUserExpiry(companyId, '-5 days')
      const grace = await stateOf(companyId)
      expect(grace.state).toBe('grace')
      expect(grace.grace_ends_at).not.toBeNull()

      await setMultiUserExpiry(companyId, '-25 days')
      const frozen = await stateOf(companyId)
      expect(frozen.state).toBe('frozen')
      expect(frozen.grace_ends_at).toBeNull()
    })

    it('frozen with no rows at all (never granted)', async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId })
      await getPool().query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [
        companyId,
      ])
      expect((await stateOf(companyId)).state).toBe('frozen')
    })

    it('a byrå team is auto-granted multi_user on creation, entitling its client companies', async () => {
      const userId = await insertAuthUser()
      const teamRes = await getPool().query<{ id: string }>(
        `INSERT INTO public.teams (name, created_by, kind) VALUES ('PG Byrå Auto', $1, 'byra') RETURNING id`,
        [userId],
      )
      const teamId = teamRes.rows[0]!.id
      // The trg_seed_byra_team_multi_user trigger wrote the standing grant.
      const grant = await getPool().query(
        `SELECT 1 FROM public.capability_grants
          WHERE team_id = $1 AND capability_key = 'multi_user' AND expires_at IS NULL`,
        [teamId],
      )
      expect(grant.rows).toHaveLength(1)

      // A client company under the team is entitled with ZERO company-scoped
      // rows (byrå companies get no trial: 20260826130300).
      const companyId = await insertCompany({ createdBy: userId })
      await getPool().query(`UPDATE public.companies SET team_id = $2 WHERE id = $1`, [
        companyId,
        teamId,
      ])
      await getPool().query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [
        companyId,
      ])
      expect((await stateOf(companyId)).state).toBe('entitled')
    })
  })

  describe('resolve_active_company_gated', () => {
    it('an OWNER resolves their frozen company (owners are never locked out)', async () => {
      const ownerId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: ownerId })
      await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
      await setMultiUserExpiry(companyId, '-25 days')
      await setActivePreference(ownerId, companyId)

      const row = await resolveGatedAs(ownerId)
      expect(row?.company_id).toBe(companyId)
      expect(row?.used_fallback).toBe(false)
      expect(row?.has_locked_membership).toBe(false)
    })

    it('a NON-OWNER with only a frozen membership resolves nothing and is reported locked', async () => {
      const ownerId = await insertAuthUser()
      const memberId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: ownerId })
      await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
      await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
      await setMultiUserExpiry(companyId, '-25 days')
      await setActivePreference(memberId, companyId)

      const row = await resolveGatedAs(memberId)
      expect(row?.company_id).toBeNull()
      expect(row?.has_locked_membership).toBe(true)
    })

    it('a NON-OWNER still resolves during the grace window', async () => {
      const ownerId = await insertAuthUser()
      const memberId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: ownerId })
      await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
      await insertCompanyMember({ companyId, userId: memberId, role: 'admin' })
      await setMultiUserExpiry(companyId, '-5 days')
      await setActivePreference(memberId, companyId)

      const row = await resolveGatedAs(memberId)
      expect(row?.company_id).toBe(companyId)
      expect(row?.has_locked_membership).toBe(false)
    })

    it('a stale preference at a frozen company falls back to an accessible one (write-back signal)', async () => {
      const ownerId = await insertAuthUser()
      const userId = await insertAuthUser()
      const frozenCo = await insertCompany({ createdBy: ownerId })
      await insertCompanyMember({ companyId: frozenCo, userId: ownerId, role: 'owner' })
      await insertCompanyMember({ companyId: frozenCo, userId, role: 'member' })
      await setMultiUserExpiry(frozenCo, '-25 days')
      const ownedCo = await insertCompany({ createdBy: userId })
      await insertCompanyMember({ companyId: ownedCo, userId, role: 'owner' })
      await setActivePreference(userId, frozenCo)

      const row = await resolveGatedAs(userId)
      expect(row?.company_id).toBe(ownedCo)
      // used_fallback=true is what makes the middleware persist the
      // accessible company back to user_preferences, so RLS
      // (current_active_company_id) converges on the same answer.
      expect(row?.used_fallback).toBe(true)
      expect(row?.has_locked_membership).toBe(false)
    })
  })
})
