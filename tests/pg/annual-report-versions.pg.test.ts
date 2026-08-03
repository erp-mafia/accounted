import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

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

async function waitForAdvisoryLock(
  pid: number,
  maxAttempts = 150,
  intervalMs = 20,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await getPool().query<{ wait_event: string | null }>(
      `SELECT wait_event
       FROM pg_stat_activity
       WHERE pid = $1`,
      [pid],
    )
    if (result.rows[0]?.wait_event === 'advisory') return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    `Backend ${pid} did not wait for the annual-report advisory lock after ${maxAttempts * intervalMs}ms`,
  )
}

describe('annual report profile and version enforcement', () => {
  it('isolates profiles by membership and rejects cross-company period links', async () => {
    const owner = await seedCompany()
    const strangerId = await insertAuthUser()
    const viewerId = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role)
       VALUES ($1, $2, 'viewer')`,
      [owner.companyId, viewerId],
    )
    const profileId = randomUUID()
    await getPool().query(
      `INSERT INTO public.annual_report_profiles
         (id, company_id, fiscal_period_id, user_id, is_public_limited_company)
       VALUES ($1, $2, $3, $4, false)`,
      [profileId, owner.companyId, owner.fiscalPeriodId, owner.userId],
    )

    const ownerView = await withUserContext(owner.userId, (client) =>
      client.query('SELECT id FROM public.annual_report_profiles WHERE id = $1', [profileId]),
    )
    expect(ownerView.rows).toHaveLength(1)
    const strangerView = await withUserContext(strangerId, (client) =>
      client.query('SELECT id FROM public.annual_report_profiles WHERE id = $1', [profileId]),
    )
    expect(strangerView.rows).toHaveLength(0)
    const viewerView = await withUserContext(viewerId, (client) =>
      client.query('SELECT id FROM public.annual_report_profiles WHERE id = $1', [profileId]),
    )
    expect(viewerView.rows).toHaveLength(1)
    await expect(
      withUserContext(viewerId, (client) =>
        client.query(
          `UPDATE public.annual_report_profiles
           SET is_public_limited_company = true
           WHERE id = $1`,
          [profileId],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 })

    const second = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.annual_report_profiles
           (company_id, fiscal_period_id, user_id)
         VALUES ($1, $2, $3)`,
        [owner.companyId, second.fiscalPeriodId, owner.userId],
      ),
    ).rejects.toThrow(/does not belong to annual report company/i)
  })

  it('allocates sequential versions, deduplicates content, and finalizes a draft atomically', async () => {
    const owner = await seedCompany()
    const first = await createVersion(owner)
    expect(first.rows[0]).toMatchObject({ version_number: 1, status: 'draft' })

    const signatureId = randomUUID()
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')`,
      [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
    )

    const finalized = await createVersion({ ...owner, status: 'ready_for_signature' })
    expect(finalized.rows[0]).toMatchObject({
      id: first.rows[0].id,
      version_number: 1,
      status: 'ready_for_signature',
    })
    const boundSignature = await getPool().query(
      `SELECT annual_report_version_id
       FROM public.arsredovisning_signature_requests
       WHERE id = $1`,
      [signatureId],
    )
    expect(boundSignature.rows[0].annual_report_version_id).toBe(first.rows[0].id)

    const second = await createVersion({ ...owner, hash: 'b'.repeat(64) })
    expect(second.rows[0]).toMatchObject({ version_number: 2, status: 'draft' })
  })

  it('does not finalize a version without a signer roster', async () => {
    const owner = await seedCompany()
    await expect(
      createVersion({ ...owner, status: 'ready_for_signature' }),
    ).rejects.toThrow(/requires at least one signer slot/i)
  })

  it('keeps finalization behind the trusted service boundary and rejects forged validation', async () => {
    const owner = await seedCompany()
    await expect(
      withUserContext(owner.userId, (client) =>
        client.query(
          `SELECT * FROM public.create_annual_report_version_with_signatures(
             $1, $2, '1.0', 'k2', 'ready_for_signature', $3::jsonb, $4::jsonb,
             $5, '2024-09-12', 'k2-ab-risbs-2024-09-12', $6::jsonb, $7
           )`,
          [
            owner.companyId,
            owner.fiscalPeriodId,
            JSON.stringify(reportData(owner.fiscalPeriodId)),
            JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
            'd'.repeat(64),
            JSON.stringify({ ok: true, issues: [] }),
            owner.userId,
          ],
        ),
      ),
    ).rejects.toThrow(/permission denied|trusted application service/i)

    await expect(
      withCommittedRoleContext(owner.userId, 'service_role', (client) =>
        client.query(
          `SELECT * FROM public.create_annual_report_version_with_signatures(
             $1, $2, '1.0', 'k2', 'ready_for_signature', $3::jsonb, $4::jsonb,
             $5, '2024-09-12', 'k2-ab-risbs-2024-09-12', $6::jsonb, $7
           )`,
          [
            owner.companyId,
            owner.fiscalPeriodId,
            JSON.stringify(reportData(owner.fiscalPeriodId)),
            JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
            'e'.repeat(64),
            JSON.stringify({ ok: true, issues: [] }),
            owner.userId,
          ],
        ),
      ),
    ).rejects.toThrow(/complete server validation snapshot/i)
  })

  it('keeps signature evidence transitions behind the trusted service boundary', async () => {
    const owner = await seedCompany()
    const signatureId = randomUUID()

    const directInsert = await withUserContext(owner.userId, (client) =>
      client.query(
        `INSERT INTO public.arsredovisning_signature_requests
           (id, user_id, company_id, fiscal_period_id, role, signer_name)
         VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')
         RETURNING id`,
        [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
      ),
    )
    expect(directInsert.rowCount).toBe(1)
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')`,
      [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
    )
    const version = await createVersion({ ...owner, status: 'ready_for_signature' })

    const directUpdate = await withUserContext(owner.userId, (client) =>
      client.query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now(),
             signing_method = 'paper_original', evidence_reference = 'archive:A-1',
             evidence_recorded_by = $2, evidence_recorded_at = now()
         WHERE id = $1
         RETURNING id`,
        [signatureId, owner.userId],
      ),
    )
    expect(directUpdate.rowCount).toBe(0)

    const directDelete = await withUserContext(owner.userId, (client) =>
      client.query(
        `DELETE FROM public.arsredovisning_signature_requests
         WHERE id = $1
         RETURNING id`,
        [signatureId],
      ),
    )
    expect(directDelete.rowCount).toBe(0)

    await expect(
      withUserContext(owner.userId, (client) =>
        client.query(
          `INSERT INTO public.arsredovisning_signature_requests
             (user_id, company_id, fiscal_period_id, role, signer_name, status,
              annual_report_version_id, signed_at, signing_method, evidence_reference,
              evidence_recorded_by, evidence_recorded_at)
           VALUES ($1, $2, $3, 'VD', 'Erik Eriksson', 'signed', $4, now(),
                   'paper_original', 'archive:A-2', $1, now())`,
          [owner.userId, owner.companyId, owner.fiscalPeriodId, version.rows[0].id],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/i)
  })

  it('limits authenticated roster edits to blank pending unbound inserts and deletes', async () => {
    const owner = await seedCompany()
    const signatureId = randomUUID()

    const inserted = await withCommittedRoleContext(owner.userId, 'authenticated', (client) =>
      client.query(
        `INSERT INTO public.arsredovisning_signature_requests
           (id, user_id, company_id, fiscal_period_id, role, signer_name)
         VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')
         RETURNING id`,
        [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
      ),
    )
    expect(inserted.rowCount).toBe(1)

    await expect(
      withUserContext(owner.userId, (client) =>
        client.query(
          `INSERT INTO public.arsredovisning_signature_requests
             (user_id, company_id, fiscal_period_id, role, signer_name, evidence_reference)
           VALUES ($1, $2, $3, 'VD', 'Erik Eriksson', 'archive:A-2')`,
          [owner.userId, owner.companyId, owner.fiscalPeriodId],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/i)

    const updated = await withUserContext(owner.userId, (client) =>
      client.query(
        `UPDATE public.arsredovisning_signature_requests
         SET signer_name = 'Changed signer'
         WHERE id = $1
         RETURNING id`,
        [signatureId],
      ),
    )
    expect(updated.rowCount).toBe(0)

    const deleted = await withCommittedRoleContext(owner.userId, 'authenticated', (client) =>
      client.query(
        `DELETE FROM public.arsredovisning_signature_requests
         WHERE id = $1
         RETURNING id`,
        [signatureId],
      ),
    )
    expect(deleted.rowCount).toBe(1)
  })

  it('invalidates representative confirmation when the draft signer roster changes', async () => {
    const owner = await seedCompany()
    await getPool().query(
      `INSERT INTO public.annual_report_profiles
         (company_id, fiscal_period_id, user_id, signer_roster_confirmed_at)
       VALUES ($1, $2, $3, now())`,
      [owner.companyId, owner.fiscalPeriodId, owner.userId],
    )
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, 'Styrelseledamot', 'Anna Andersson')`,
      [owner.userId, owner.companyId, owner.fiscalPeriodId],
    )
    const profile = await getPool().query<{ signer_roster_confirmed_at: string | null }>(
      `SELECT signer_roster_confirmed_at::text
       FROM public.annual_report_profiles
       WHERE company_id = $1 AND fiscal_period_id = $2`,
      [owner.companyId, owner.fiscalPeriodId],
    )
    expect(profile.rows[0].signer_roster_confirmed_at).toBeNull()
  })

  it('does not allow callers to bypass signer preparation with the draft RPC', async () => {
    const owner = await seedCompany()
    await expect(
      withUserContext(owner.userId, (client) =>
        client.query(
          `SELECT * FROM public.create_annual_report_version(
             $1, $2, '1.0', 'k2', 'ready_for_signature', $3::jsonb, $4::jsonb,
             $5, '2024-09-12', 'k2-ab-risbs-2024-09-12', $6::jsonb, $7
           )`,
          [
            owner.companyId,
            owner.fiscalPeriodId,
            JSON.stringify(reportData(owner.fiscalPeriodId)),
            JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
            'c'.repeat(64),
            JSON.stringify({ ok: true, issues: [] }),
            owner.userId,
          ],
        ),
      ),
    ).rejects.toThrow(/only permits draft status/i)
  })

  it('requires ready_for_signature status at the trusted finalization boundary', async () => {
    const owner = await seedCompany()

    await expect(
      withCommittedRoleContext(owner.userId, 'service_role', (client) =>
        client.query(
          `SELECT * FROM public.create_annual_report_version_with_signatures(
             $1, $2, '1.0', 'k2', 'draft', $3::jsonb, $4::jsonb,
             $5, '2024-09-12', 'k2-ab-risbs-2024-09-12', $6::jsonb, $7
           )`,
          [
            owner.companyId,
            owner.fiscalPeriodId,
            JSON.stringify(reportData(owner.fiscalPeriodId)),
            JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
            'f'.repeat(64),
            JSON.stringify({}),
            owner.userId,
          ],
        ),
      ),
    ).rejects.toThrow(/requires ready_for_signature status/i)
  })

  it('keeps version content immutable and blocks member deletion', async () => {
    const owner = await seedCompany()
    const version = await createVersion(owner)

    await expect(
      withUserContext(owner.userId, (client) =>
        client.query(
          `UPDATE public.annual_report_versions
           SET report_data = '{"changed":true}'::jsonb
           WHERE id = $1`,
          [version.rows[0].id],
        ),
      ),
    ).rejects.toThrow(/content is immutable/i)

    const deleted = await withUserContext(owner.userId, (client) =>
      client.query('DELETE FROM public.annual_report_versions WHERE id = $1 RETURNING id', [
        version.rows[0].id,
      ]),
    )
    expect(deleted.rowCount).toBe(0)
    await expect(
      getPool().query('DELETE FROM public.annual_report_versions WHERE id = $1', [
        version.rows[0].id,
      ]),
    ).rejects.toThrow(/retained as immutable accounting information/i)
    await expect(
      getPool().query('DELETE FROM public.fiscal_periods WHERE id = $1', [
        owner.fiscalPeriodId,
      ]),
    ).rejects.toThrow()
  })

  it('requires version-bound signature evidence and freezes signed rows', async () => {
    const owner = await seedCompany()
    const signatureId = randomUUID()
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')`,
      [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
    )
    const version = await createVersion({ ...owner, status: 'ready_for_signature' })

    await expect(
      getPool().query(
        `UPDATE public.annual_report_versions
         SET status = 'signed'
         WHERE id = $1`,
        [version.rows[0].id],
      ),
    ).rejects.toThrow(/before every locked signer has signed/i)

    await expect(
      getPool().query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now(), annual_report_version_id = $2
         WHERE id = $1`,
        [signatureId, version.rows[0].id],
      ),
    ).rejects.toThrow(/signature_evidence_consistency|check constraint/i)

    await expect(
      getPool().query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now() - interval '1 day',
             signing_method = 'paper_original', evidence_reference = 'archive:A-1',
             evidence_recorded_by = $2, evidence_recorded_at = now()
         WHERE id = $1`,
        [signatureId, owner.userId],
      ),
    ).rejects.toThrow(/signature date must be between version finalization and today/i)

    await expect(
      getPool().query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now() + interval '1 day',
             signing_method = 'paper_original', evidence_reference = 'archive:A-1',
             evidence_recorded_by = $2, evidence_recorded_at = now()
         WHERE id = $1`,
        [signatureId, owner.userId],
      ),
    ).rejects.toThrow(/signature date must be between version finalization and today/i)

    await getPool().query(
      `UPDATE public.arsredovisning_signature_requests
       SET status = 'signed', signed_at = now(), annual_report_version_id = $2,
           signing_method = 'paper_original', evidence_reference = 'archive:A-1',
           evidence_recorded_by = $3, evidence_recorded_at = now()
       WHERE id = $1`,
      [signatureId, version.rows[0].id, owner.userId],
    )
    const signedVersion = await getPool().query(
      'SELECT status FROM public.annual_report_versions WHERE id = $1',
      [version.rows[0].id],
    )
    expect(signedVersion.rows[0].status).toBe('signed')
    await expect(
      getPool().query(
        `UPDATE public.arsredovisning_signature_requests
         SET evidence_reference = 'changed' WHERE id = $1`,
        [signatureId],
      ),
    ).rejects.toThrow(/cannot modify a signed signature request/i)
  })

  it('rejects signature evidence after the linked version stops accepting signatures', async () => {
    const owner = await seedCompany()
    const signatureId = randomUUID()
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')`,
      [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
    )
    const version = await createVersion({ ...owner, status: 'ready_for_signature' })
    await getPool().query(
      `UPDATE public.annual_report_versions
       SET status = 'superseded'
       WHERE id = $1`,
      [version.rows[0].id],
    )

    await expect(
      getPool().query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now(),
             signing_method = 'paper_original', evidence_reference = 'archive:A-1',
             evidence_recorded_by = $2, evidence_recorded_at = now()
         WHERE id = $1`,
        [signatureId, owner.userId],
      ),
    ).rejects.toThrow(/annual report version is not ready for signature evidence/i)
  })

  it('supersedes an older signed version when a corrected version is locked', async () => {
    const owner = await seedCompany()
    const signatureId = randomUUID()
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson')`,
      [signatureId, owner.userId, owner.companyId, owner.fiscalPeriodId],
    )
    const first = await createVersion({ ...owner, status: 'ready_for_signature' })
    await getPool().query(
      `UPDATE public.arsredovisning_signature_requests
       SET status = 'signed', signed_at = now(),
           signing_method = 'paper_original', evidence_reference = 'archive:A-1',
           evidence_recorded_by = $2, evidence_recorded_at = now()
       WHERE id = $1`,
      [signatureId, owner.userId],
    )

    const correction = await createVersion({
      ...owner,
      hash: 'b'.repeat(64),
      status: 'ready_for_signature',
    })
    expect(correction.rows[0]).toMatchObject({ version_number: 2, status: 'ready_for_signature' })

    const previous = await getPool().query(
      'SELECT status FROM public.annual_report_versions WHERE id = $1',
      [first.rows[0].id],
    )
    expect(previous.rows[0].status).toBe('superseded')
  })

  it('rejects validation rows linked to another company version', async () => {
    const first = await seedCompany()
    const second = await seedCompany()
    const version = await createVersion(first)
    await expect(
      getPool().query(
        `INSERT INTO public.annual_report_validation_runs
           (company_id, fiscal_period_id, version_id, user_id, validation_layer, status)
         VALUES ($1, $2, $3, $4, 'local', 'passed')`,
        [second.companyId, second.fiscalPeriodId, version.rows[0].id, second.userId],
      ),
    ).rejects.toThrow(/belongs to another company or period/i)
  })

  it('keeps validation history insert-only for authenticated callers', async () => {
    const owner = await seedCompany()
    const version = await createVersion(owner)
    const validationId = randomUUID()

    const inserted = await withCommittedRoleContext(owner.userId, 'authenticated', (client) =>
      client.query(
        `INSERT INTO public.annual_report_validation_runs
           (id, company_id, fiscal_period_id, version_id, user_id, validation_layer, status)
         VALUES ($1, $2, $3, $4, $5, 'local', 'passed')
         RETURNING id`,
        [
          validationId,
          owner.companyId,
          owner.fiscalPeriodId,
          version.rows[0].id,
          owner.userId,
        ],
      ),
    )
    expect(inserted.rowCount).toBe(1)

    const updated = await withUserContext(owner.userId, (client) =>
      client.query(
        `UPDATE public.annual_report_validation_runs
         SET status = 'failed'
         WHERE id = $1
         RETURNING id`,
        [validationId],
      ),
    )
    expect(updated.rowCount).toBe(0)

    const deleted = await withUserContext(owner.userId, (client) =>
      client.query(
        `DELETE FROM public.annual_report_validation_runs
         WHERE id = $1
         RETURNING id`,
        [validationId],
      ),
    )
    expect(deleted.rowCount).toBe(0)
  })

  it('serializes concurrent final signatures and completes the version exactly once', async () => {
    const owner = await seedCompany()
    const firstSignatureId = randomUUID()
    const secondSignatureId = randomUUID()
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests
         (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES
         ($1, $3, $4, $5, 'Styrelseledamot', 'Anna Andersson'),
         ($2, $3, $4, $5, 'VD', 'Erik Eriksson')`,
      [
        firstSignatureId,
        secondSignatureId,
        owner.userId,
        owner.companyId,
        owner.fiscalPeriodId,
      ],
    )
    const version = await createVersion({ ...owner, status: 'ready_for_signature' })

    const firstClient = await getClient()
    const secondClient = await getClient()
    try {
      await firstClient.query('BEGIN')
      await secondClient.query('BEGIN')
      const secondPid = await secondClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')

      await firstClient.query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now(),
             signing_method = 'paper_original', evidence_reference = 'archive:A-1',
             evidence_recorded_by = $2, evidence_recorded_at = now()
         WHERE id = $1`,
        [firstSignatureId, owner.userId],
      )

      const secondUpdate = secondClient.query(
        `UPDATE public.arsredovisning_signature_requests
         SET status = 'signed', signed_at = now(),
             signing_method = 'paper_original', evidence_reference = 'archive:A-2',
             evidence_recorded_by = $2, evidence_recorded_at = now()
         WHERE id = $1`,
        [secondSignatureId, owner.userId],
      )
      await waitForAdvisoryLock(secondPid.rows[0].pid)
      await firstClient.query('COMMIT')
      await secondUpdate
      await secondClient.query('COMMIT')

      const signedVersion = await getPool().query<{ status: string }>(
        `SELECT status
         FROM public.annual_report_versions
         WHERE id = $1`,
        [version.rows[0].id],
      )
      expect(signedVersion.rows[0].status).toBe('signed')
    } catch (error) {
      await firstClient.query('ROLLBACK').catch(() => {})
      await secondClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      firstClient.release()
      secondClient.release()
    }
  })
})
