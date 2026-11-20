import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The board's BankID signing (20261025200200): 'bankid' on a signature slot
 * is the evidence record_signing_signature writes, never one typed by hand,
 * and the staged MCP door's pending type is accepted. The helpers below are
 * those of annual-report-versions.pg.test.ts.
 */

async function withCommittedRoleContext<T>(
  userId: string,
  role: 'authenticated' | 'service_role',
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role])
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function reportData(fiscalPeriodId: string) {
  return {
    accounting_framework: 'k2',
    company: { name: 'Test AB', org_number: '556012-5790' },
    fiscal_period: {
      id: fiscalPeriodId,
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    },
  }
}

async function createVersion(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  hash?: string
  status?: 'draft' | 'ready_for_signature'
}) {
  let validationSummary: Record<string, unknown> = {
    stage: 'draft',
    ok: true,
    error_count: 0,
    warning_count: 0,
    issues: [],
  }
  if (params.status === 'ready_for_signature') {
    const profile = await getPool().query<{ signer_roster_confirmed_at: string }>(
      `INSERT INTO public.annual_report_profiles
         (company_id, fiscal_period_id, user_id, is_in_liquidation, signer_roster_confirmed_at)
       VALUES ($1, $2, $3, false, now())
       ON CONFLICT (company_id, fiscal_period_id) DO UPDATE
       SET signer_roster_confirmed_at = now()
       RETURNING signer_roster_confirmed_at::text`,
      [params.companyId, params.fiscalPeriodId, params.userId],
    )
    validationSummary = {
      stage: 'signing',
      ok: true,
      error_count: 0,
      warning_count: 0,
      issues: [],
      digital_filing_eligible: true,
      digital_issues: [],
      profile: {
        company_id: params.companyId,
        fiscal_period_id: params.fiscalPeriodId,
        signer_roster_confirmed_at: profile.rows[0].signer_roster_confirmed_at,
      },
      disclosures: {},
      eligibility: {},
    }
  }
  const rpcName =
    params.status === 'ready_for_signature'
      ? 'create_annual_report_version_with_signatures'
      : 'create_annual_report_version'
  return withCommittedRoleContext(
    params.userId,
    params.status === 'ready_for_signature' ? 'service_role' : 'authenticated',
    (client) =>
    client.query<{
      id: string
      version_number: number
      status: string
    }>(
      `SELECT id, version_number, status
       FROM public.${rpcName}(
         $1, $2, '1.0', 'k2', $3, $4::jsonb, $5::jsonb, $6, '2024-09-12',
         'k2-ab-risbs-2024-09-12', $7::jsonb, $8
       )`,
      [
        params.companyId,
        params.fiscalPeriodId,
        params.status ?? 'draft',
        JSON.stringify(reportData(params.fiscalPeriodId)),
        JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
        params.hash ?? 'a'.repeat(64),
        JSON.stringify(validationSummary),
        params.userId,
      ],
    ),
  )
}

async function readySlot(): Promise<{ owner: Awaited<ReturnType<typeof seedCompany>>; slotId: string }> {
  const owner = await seedCompany()
  await getPool().query(
    `INSERT INTO public.arsredovisning_signature_requests (id, user_id, company_id, fiscal_period_id, role, signer_name)
     VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')`,
    [randomUUID(), owner.userId, owner.companyId, owner.fiscalPeriodId],
  )
  const version = await createVersion({ ...owner, status: 'ready_for_signature' })
  const slot = await getPool().query<{ id: string }>(
    `SELECT id FROM public.arsredovisning_signature_requests WHERE annual_report_version_id = $1`,
    [version.rows[0].id],
  )
  return { owner, slotId: slot.rows[0]!.id }
}

describe('arsredovisning BankID board signing', () => {
  it('refuses a bankid slot without the signing request behind it, also with NULL data', async () => {
    const { slotId } = await readySlot()
    await expect(getPool().query(
      `UPDATE public.arsredovisning_signature_requests
          SET status = 'signed', signed_at = now(), signing_method = 'bankid',
              evidence_reference = 'receipt:typed-by-hand', evidence_recorded_at = now()
        WHERE id = $1`,
      [slotId],
    )).rejects.toThrow(/arsredovisning_signature_bankid_is_recorded_signing/)
    await expect(getPool().query(
      `UPDATE public.arsredovisning_signature_requests
          SET status = 'signed', signed_at = now(), signing_method = 'bankid',
              evidence_reference = 'receipt:typed-by-hand', evidence_recorded_at = now(),
              bankid_signature_data = '{"given_name": "Anna"}'::jsonb
        WHERE id = $1`,
      [slotId],
    )).rejects.toThrow(/arsredovisning_signature_bankid_is_recorded_signing/)
  })

  it('takes bankid evidence that names the signing request and signer', async () => {
    const { slotId } = await readySlot()
    const result = await getPool().query(
      `UPDATE public.arsredovisning_signature_requests
          SET status = 'signed', signed_at = now(), signing_method = 'bankid',
              evidence_reference = 'receipt:signing/' || $2 || '/' || $3, evidence_recorded_at = now(),
              bankid_signature_data = jsonb_build_object('signing_request_id', $2::text, 'signing_signer_id', $3::text)
        WHERE id = $1`,
      [slotId, randomUUID(), randomUUID()],
    )
    expect(result.rowCount).toBe(1)
  })

  it('leaves the other methods as they were', async () => {
    const { slotId } = await readySlot()
    const result = await getPool().query(
      `UPDATE public.arsredovisning_signature_requests
          SET status = 'signed', signed_at = now(), signing_method = 'advanced_e_signature',
              evidence_reference = 'document:abc', evidence_recorded_at = now()
        WHERE id = $1`,
      [slotId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('accepts request_arsredovisning_signatures as a pending operation type', async () => {
    const c = await seedCompany()
    await expect(getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, 'request_arsredovisning_signatures', 'pg') RETURNING id`,
      [c.userId, c.companyId],
    )).resolves.toMatchObject({ rowCount: 1 })
  })
})
