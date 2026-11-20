import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20261030040401_annual_report_auditor_pateckning: the
// two revisorspåteckning columns on annual_report_profiles accept the values
// the app writes (lib/bokslut/arsredovisning/workflow-schemas.ts
// AUDITOR_OPINIONS) through the member's own session, and refuse anything
// else, so a value the iXBRL mapping does not know never reaches a filing.

async function upsertProfile(
  userId: string,
  companyId: string,
  fiscalPeriodId: string,
  values: { auditor_firm_name?: string | null; auditor_opinion?: string | null },
) {
  return withUserContext(userId, (client) =>
    client.query<{ auditor_firm_name: string | null; auditor_opinion: string | null }>(
      `INSERT INTO public.annual_report_profiles
         (company_id, fiscal_period_id, user_id, auditor_firm_name, auditor_opinion)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, fiscal_period_id) DO UPDATE
       SET auditor_firm_name = EXCLUDED.auditor_firm_name,
           auditor_opinion = EXCLUDED.auditor_opinion
       RETURNING auditor_firm_name, auditor_opinion`,
      [companyId, fiscalPeriodId, userId, values.auditor_firm_name ?? null, values.auditor_opinion ?? null],
    ),
  )
}

describe('annual_report_profiles revisorspåteckning columns', () => {
  it('stores every opinion the app knows and a firm name, through the member session', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    for (const opinion of [
      'unmodified',
      'modified',
      'avstyrkt_rr_br',
      'avstyrkt_rr',
      'avstyrkt_br',
      'avstyrkt_rr_varken_br',
      'avstyrkt_br_varken_rr',
      'varken_rr_br',
      'varken_rr',
      'varken_br',
    ]) {
      const result = await upsertProfile(userId, companyId, fiscalPeriodId, {
        auditor_firm_name: 'Revisionsbyrån AB',
        auditor_opinion: opinion,
      })
      expect(result.rows[0]).toEqual({ auditor_firm_name: 'Revisionsbyrån AB', auditor_opinion: opinion })
    }
  })

  it('keeps both columns optional', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const result = await upsertProfile(userId, companyId, fiscalPeriodId, {})
    expect(result.rows[0]).toEqual({ auditor_firm_name: null, auditor_opinion: null })
  })

  it('refuses an opinion outside the list', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(
      upsertProfile(userId, companyId, fiscalPeriodId, { auditor_opinion: 'clean' }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a blank or over-long firm name', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(
      upsertProfile(userId, companyId, fiscalPeriodId, { auditor_firm_name: '   ' }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      upsertProfile(userId, companyId, fiscalPeriodId, { auditor_firm_name: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

// ---- the påteckning frozen on the revisor's slot ----------------------------
//
// The revisor's påteckning (opinion, revisionsbolag) is written onto the
// revisor's slot in the update that signs it, and frozen with the signed row,
// so a signed or filed version keeps rendering the påteckning it was given
// (BFL 7 kap. 1 §). Only a signed revisor slot carries it.

/** Lock a version for signature the way the app does (service role RPC), binding the roster's pending slots. */
async function lockForSignature(owner: { userId: string; companyId: string; fiscalPeriodId: string }): Promise<string> {
  const confirmed = await getPool().query<{ at: string }>(
    `INSERT INTO public.annual_report_profiles
       (company_id, fiscal_period_id, user_id, is_in_liquidation, signer_roster_confirmed_at)
     VALUES ($1, $2, $3, false, now())
     ON CONFLICT (company_id, fiscal_period_id) DO UPDATE SET signer_roster_confirmed_at = now()
     RETURNING signer_roster_confirmed_at::text AS at`,
    [owner.companyId, owner.fiscalPeriodId, owner.userId],
  )
  const summary = {
    stage: 'signing',
    ok: true,
    error_count: 0,
    warning_count: 0,
    issues: [],
    digital_filing_eligible: true,
    digital_issues: [],
    profile: { company_id: owner.companyId, fiscal_period_id: owner.fiscalPeriodId, signer_roster_confirmed_at: confirmed.rows[0].at },
    disclosures: {},
    eligibility: {},
  }
  const report = {
    accounting_framework: 'k2',
    company: { name: 'Test AB', org_number: '556012-5790' },
    fiscal_period: { id: owner.fiscalPeriodId, period_start: '2025-01-01', period_end: '2025-12-31' },
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: owner.userId, role: 'service_role' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [owner.userId])
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
    await client.query('SET LOCAL ROLE service_role')
    const version = await client.query<{ id: string }>(
      `SELECT id FROM public.create_annual_report_version_with_signatures(
         $1, $2, '1.0', 'k2', 'ready_for_signature', $3::jsonb, $4::jsonb, $5, '2024-09-12',
         'k2-ab-risbs-2024-09-12', $6::jsonb, $7
       )`,
      [
        owner.companyId,
        owner.fiscalPeriodId,
        JSON.stringify(report),
        JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
        'b'.repeat(64),
        JSON.stringify(summary),
        owner.userId,
      ],
    )
    await client.query('COMMIT')
    return version.rows[0].id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function rosterSlot(owner: { userId: string; companyId: string; fiscalPeriodId: string }, role: string, name: string) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.arsredovisning_signature_requests (id, user_id, company_id, fiscal_period_id, role, signer_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, owner.userId, owner.companyId, owner.fiscalPeriodId, role, name],
  )
  return id
}

/** Sign a slot with paper evidence, optionally writing the påteckning in the same update. */
function signSlot(
  slotId: string,
  versionId: string,
  userId: string,
  pateckning: { opinion: string | null; firm: string | null } = { opinion: null, firm: null },
) {
  return getPool().query(
    `UPDATE public.arsredovisning_signature_requests
     SET status = 'signed', signed_at = now(), annual_report_version_id = $2,
         signing_method = 'paper_original', evidence_reference = 'archive:A-1',
         evidence_recorded_by = $3, evidence_recorded_at = now(),
         pateckning_opinion = $4, pateckning_firm_name = $5
     WHERE id = $1`,
    [slotId, versionId, userId, pateckning.opinion, pateckning.firm],
  )
}

describe('arsredovisning_signature_requests: the påteckning frozen on the revisor slot', () => {
  it('lets only a signed revisor slot carry it, always with the opinion, then freezes it', async () => {
    const owner = await seedCompany()
    const boardId = await rosterSlot(owner, 'Styrelseledamot', 'Anna Andersson')
    const revisorId = await rosterSlot(owner, 'Auktoriserad revisor', 'Rita Revisor')

    // A pending slot carries no påteckning.
    await expect(
      getPool().query(`UPDATE public.arsredovisning_signature_requests SET pateckning_opinion = 'unmodified' WHERE id = $1`, [revisorId]),
    ).rejects.toMatchObject({ code: '23514' })

    const versionId = await lockForSignature(owner)

    // A board slot never carries one.
    await expect(signSlot(boardId, versionId, owner.userId, { opinion: 'unmodified', firm: null })).rejects.toMatchObject({ code: '23514' })
    await signSlot(boardId, versionId, owner.userId)

    // A revisor slot carries the opinion, never a firm alone, and only a known opinion.
    await expect(signSlot(revisorId, versionId, owner.userId, { opinion: null, firm: 'Revisionsbyrån AB' })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(signSlot(revisorId, versionId, owner.userId, { opinion: 'clean', firm: null })).rejects.toMatchObject({ code: '23514' })
    await signSlot(revisorId, versionId, owner.userId, { opinion: 'avstyrkt_br', firm: 'Revisionsbyrån AB' })

    const frozen = await getPool().query<{ pateckning_opinion: string; pateckning_firm_name: string }>(
      'SELECT pateckning_opinion, pateckning_firm_name FROM public.arsredovisning_signature_requests WHERE id = $1',
      [revisorId],
    )
    expect(frozen.rows[0]).toEqual({ pateckning_opinion: 'avstyrkt_br', pateckning_firm_name: 'Revisionsbyrån AB' })
    const version = await getPool().query<{ status: string }>('SELECT status FROM public.annual_report_versions WHERE id = $1', [versionId])
    expect(version.rows[0].status).toBe('signed')

    // Signed is final: the påteckning cannot be edited afterwards.
    await expect(
      getPool().query(`UPDATE public.arsredovisning_signature_requests SET pateckning_opinion = 'unmodified' WHERE id = $1`, [revisorId]),
    ).rejects.toThrow(/cannot modify a signed signature request/i)
  })
})
