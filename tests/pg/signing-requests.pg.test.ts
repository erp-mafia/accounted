import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * BankID document signing (migration 20261025200000_signing_requests.sql):
 *
 *   - who reads and writes: members read their company's requests and
 *     signers (never the token hash, the BankID session or the lease), the
 *     private table and every write are the service role's;
 *   - a signature is recorded only through record_signing_signature, which
 *     checks the request, the session and the lock, consumes the BankID
 *     session, fills the årsredovisning slot and completes the request, and
 *     answers a refusal as {ok:false, code} without consuming anything;
 *   - signed rows are evidence: frozen, never deleted (nor the document under
 *     them), except by the sandbox teardown.
 */

type Seeded = { userId: string; companyId: string; fiscalPeriodId: string }
type Recorded = { ok: boolean; code?: string; signing_request_id?: string; signer_id?: string; signed_at?: string; completed?: boolean }

const sha = (seed: string) => createHash('sha256').update(seed).digest('hex')
const PN_HASH = sha('199001011239')
const session = () => `sess-${randomUUID()}`

async function insertPdf(owner: Seeded, fileName = 'hyresavtal.pdf'): Promise<{ id: string; sha256: string }> {
  const id = randomUUID()
  const hash = sha(`pdf-${id}`)
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, $4, 'application/pdf', 2048, $5, $6, 'file_upload')`,
    [id, owner.userId, owner.companyId, fileName, `documents/${owner.companyId}/${id}.pdf`, hash],
  )
  return { id, sha256: hash }
}

async function insertRequest(
  owner: Seeded,
  doc: { id: string; sha256: string },
  opts: { annualReportVersionId?: string; createdAt?: string; expiresAt?: string } = {},
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.signing_requests
       (company_id, created_by, created_via, document_id, document_sha256, title, annual_report_version_id, created_at, expires_at)
     VALUES ($1, $2, 'app', $3, $4, 'Hyresavtal', $5,
             COALESCE($6::timestamptz, now()), COALESCE($7::timestamptz, now() + interval '14 days'))
     RETURNING id`,
    [owner.companyId, owner.userId, doc.id, doc.sha256, opts.annualReportVersionId ?? null, opts.createdAt ?? null, opts.expiresAt ?? null],
  )
  return rows[0]!.id
}

async function insertSigner(
  owner: Seeded,
  requestId: string,
  opts: { position: number; userId?: string | null; lockKind?: 'none' | 'member' | 'personnummer'; sessionId?: string | null; slotId?: string | null; companyId?: string },
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.signing_request_signers
       (company_id, signing_request_id, position, name, email, user_id, lock_kind, annual_report_signature_id,
        token_hash, bankid_session_id, bankid_session_started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      opts.companyId ?? owner.companyId,
      requestId,
      opts.position,
      `Undertecknare ${opts.position}`,
      `signer-${opts.position}-${randomUUID()}@example.se`,
      opts.userId ?? null,
      opts.lockKind ?? 'none',
      opts.slotId ?? null,
      sha(`token-${randomUUID()}`),
      opts.sessionId ?? null,
      opts.sessionId ? new Date().toISOString() : null,
    ],
  )
  return rows[0]!.id
}

/** A personnummer lock as createSigningRequest stores it: the hash and a ciphertext. */
async function insertLock(signerId: string, companyId: string, hash: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.signing_signer_private (signer_id, company_id, lock_personnummer_hash, lock_personnummer_encrypted)
     VALUES ($1, $2, $3, '\\x0102'::bytea)`,
    [signerId, companyId, hash],
  )
}

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    given_name: 'Anna',
    surname: 'Andersson',
    personnummer_hash: PN_HASH,
    personnummer_masked: 'XXXXXXXX-1239',
    completed_at: new Date().toISOString(),
    user_visible_data: '# Signera dokument\n\nJag signerar *Hyresavtal* för Test AB.',
    signature_xml: Buffer.from('<Signature><SignedInfo/></Signature>').toString('base64'),
    ocsp_response: Buffer.from('ocsp-response').toString('base64'),
    ...overrides,
  }
}

/** record_signing_signature as lib/signing/ceremony.ts calls it: the service role, committed. */
async function record(signerId: string, sessionId: string | null, ev: Record<string, unknown> = evidence()): Promise<Recorded> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: Recorded }>(
      `SELECT public.record_signing_signature($1::uuid, $2::text, $3::jsonb) AS result`,
      [signerId, sessionId, JSON.stringify(ev)],
    )
    return rows[0]!.result
  })
}

async function consumed(sessionId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM public.bankid_consumed_sessions WHERE session_id = $1`, [sessionId])
  return rows[0]!.n
}

async function signerState(signerId: string) {
  const { rows } = await getPool().query<{
    status: string
    signed_at: Date | null
    bankid_given_name: string | null
    bankid_surname: string | null
    user_visible_data: string | null
    poll_lease_until: Date | null
    last_error_code: string | null
  }>(
    `SELECT status, signed_at, bankid_given_name, bankid_surname, user_visible_data, poll_lease_until, last_error_code
       FROM public.signing_request_signers WHERE id = $1`,
    [signerId],
  )
  return rows[0]
}

async function privateState(signerId: string) {
  const { rows } = await getPool().query<{
    signature_xml: string | null
    ocsp_response: string | null
    bankid_personnummer_hash: string | null
    personnummer_masked: string | null
    bankid_session_id: string | null
    lock_personnummer_hash: string | null
    lock_personnummer_encrypted: Buffer | null
  }>(
    `SELECT signature_xml, ocsp_response, bankid_personnummer_hash, personnummer_masked, bankid_session_id,
            lock_personnummer_hash, lock_personnummer_encrypted
       FROM public.signing_signer_private WHERE signer_id = $1`,
    [signerId],
  )
  return rows[0]
}

async function requestState(requestId: string) {
  const { rows } = await getPool().query<{ status: string; completed_at: Date | null }>(
    `SELECT status, completed_at FROM public.signing_requests WHERE id = $1`,
    [requestId],
  )
  return rows[0]
}

async function countWhere(table: string, column: string, id: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE ${column} = $1`, [id])
  return rows[0]!.n
}

/** A plain request over one PDF with `signers` signers, each in a BankID session of their own. */
async function plainRequest(signers = 2) {
  const owner = await seedCompany()
  const doc = await insertPdf(owner)
  const requestId = await insertRequest(owner, doc)
  const sessions = Array.from({ length: signers }, session)
  const signerIds: string[] = []
  for (const [i, sessionId] of sessions.entries()) signerIds.push(await insertSigner(owner, requestId, { position: i + 1, sessionId }))
  return { owner, doc, requestId, signerIds, sessions }
}

async function completedRequest() {
  const seeded = await plainRequest(2)
  for (const [i, signerId] of seeded.signerIds.entries()) {
    const result = await record(signerId, seeded.sessions[i]!, evidence({ personnummer_hash: sha(`pn-${i}-${randomUUID()}`) }))
    expect(result.ok).toBe(true)
  }
  return seeded
}

// ---------------------------------------------------------------------------
// The årsredovisning version, as tests/pg/annual-report-versions.pg.test.ts
// finalizes one: a confirmed roster, then the trusted service creates the
// ready_for_signature version and binds the pending slots to it.
// ---------------------------------------------------------------------------

async function withCommittedRoleContext<T>(
  userId: string,
  role: 'authenticated' | 'service_role',
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role })])
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
    fiscal_period: { id: fiscalPeriodId, period_start: '2025-01-01', period_end: '2025-12-31' },
  }
}

async function finalizedVersion(owner: Seeded, slotNames: string[]): Promise<{ versionId: string; slotIds: string[] }> {
  const slotIds: string[] = []
  for (const [i, name] of slotNames.entries()) {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.arsredovisning_signature_requests (id, user_id, company_id, fiscal_period_id, role, signer_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, owner.userId, owner.companyId, owner.fiscalPeriodId, i === 0 ? 'Styrelseledamot' : `Styrelseledamot ${i + 1}`, name],
    )
    slotIds.push(id)
  }
  const profile = await getPool().query<{ signer_roster_confirmed_at: string }>(
    `INSERT INTO public.annual_report_profiles
       (company_id, fiscal_period_id, user_id, is_in_liquidation, signer_roster_confirmed_at)
     VALUES ($1, $2, $3, false, now())
     ON CONFLICT (company_id, fiscal_period_id) DO UPDATE
     SET signer_roster_confirmed_at = now()
     RETURNING signer_roster_confirmed_at::text`,
    [owner.companyId, owner.fiscalPeriodId, owner.userId],
  )
  const validationSummary = {
    stage: 'signing',
    ok: true,
    error_count: 0,
    warning_count: 0,
    issues: [],
    digital_filing_eligible: true,
    digital_issues: [],
    profile: {
      company_id: owner.companyId,
      fiscal_period_id: owner.fiscalPeriodId,
      signer_roster_confirmed_at: profile.rows[0]!.signer_roster_confirmed_at,
    },
    disclosures: {},
    eligibility: {},
  }
  const version = await withCommittedRoleContext(owner.userId, 'service_role', (client) =>
    client.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM public.create_annual_report_version_with_signatures(
         $1, $2, '1.0', 'k2', 'ready_for_signature', $3::jsonb, $4::jsonb, $5, '2024-09-12',
         'k2-ab-risbs-2024-09-12', $6::jsonb, $7
       )`,
      [
        owner.companyId,
        owner.fiscalPeriodId,
        JSON.stringify(reportData(owner.fiscalPeriodId)),
        JSON.stringify({ entryPointId: 'k2-ab-risbs-2024-09-12' }),
        sha(`content-${randomUUID()}`),
        JSON.stringify(validationSummary),
        owner.userId,
      ],
    ),
  )
  expect(version.rows[0]!.status).toBe('ready_for_signature')
  return { versionId: version.rows[0]!.id, slotIds }
}

async function annualReportRequest(slotNames = ['Anna Andersson', 'Erik Eriksson']) {
  const owner = await seedCompany()
  const { versionId, slotIds } = await finalizedVersion(owner, slotNames)
  const doc = await insertPdf(owner, 'arsredovisning-2025.pdf')
  const requestId = await insertRequest(owner, doc, { annualReportVersionId: versionId })
  const sessions = slotIds.map(session)
  const signerIds: string[] = []
  for (const [i, slotId] of slotIds.entries()) {
    // The first signer is a member of the company, the second is not.
    signerIds.push(await insertSigner(owner, requestId, { position: i + 1, slotId, sessionId: sessions[i]!, userId: i === 0 ? owner.userId : null }))
  }
  return { owner, doc, versionId, slotIds, requestId, signerIds, sessions }
}

// ---------------------------------------------------------------------------

describe('signing_requests.pg: who reads and writes', () => {
  it("lets every member read the company's requests and signers, never the token hash, the session, the lease or the private table", async () => {
    const { owner, requestId, signerIds } = await plainRequest(2)
    await insertLock(signerIds[1]!, owner.companyId, PN_HASH)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: viewerId, role: 'viewer' })

    for (const userId of [owner.userId, viewerId]) {
      await withUserContext(userId, async (client) => {
        const requests = await client.query<{ id: string; status: string }>(
          `SELECT id, status, title, document_sha256, expires_at FROM public.signing_requests WHERE company_id = $1`,
          [owner.companyId],
        )
        expect(requests.rows).toEqual([expect.objectContaining({ id: requestId, status: 'open' })])
        const signers = await client.query<{ id: string }>(
          `SELECT id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id,
                  link_sent_at, last_reminded_at, status, bankid_session_started_at, signed_at, bankid_given_name,
                  bankid_surname, user_visible_data, declined_at, decline_reason, last_error_code, created_at, updated_at
             FROM public.signing_request_signers WHERE signing_request_id = $1`,
          [requestId],
        )
        expect(signers.rows.map((r) => r.id).sort()).toEqual([...signerIds].sort())
      })
      // One context per statement: a refused statement aborts its transaction.
      for (const sql of [
        `SELECT token_hash FROM public.signing_request_signers`,
        `SELECT bankid_session_id FROM public.signing_request_signers`,
        `SELECT poll_lease_until FROM public.signing_request_signers`,
        `SELECT * FROM public.signing_request_signers`,
        `SELECT signer_id FROM public.signing_signer_private`,
        `SELECT lock_personnummer_hash FROM public.signing_signer_private`,
      ]) {
        await withUserContext(userId, async (client) => {
          await expect(client.query(sql), sql).rejects.toThrow(/permission denied/i)
        })
      }
    }
  })

  it("hides a company's requests and signers from the owner of another company", async () => {
    const { requestId } = await plainRequest(1)
    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await withUserContext(otherOwner, async (client) => {
      expect((await client.query(`SELECT id FROM public.signing_requests WHERE id = $1`, [requestId])).rows).toEqual([])
      expect((await client.query(`SELECT id FROM public.signing_request_signers WHERE signing_request_id = $1`, [requestId])).rows).toEqual([])
    })
  })

  it('keeps every write with the service role: no INSERT, UPDATE or DELETE for a session, nothing at all for anon, and no RPC', async () => {
    const { owner, doc, requestId, signerIds, sessions } = await plainRequest(1)
    await insertLock(signerIds[0]!, owner.companyId, PN_HASH)
    const writes: Array<[string, unknown[]]> = [
      [
        `INSERT INTO public.signing_requests (company_id, created_by, created_via, document_id, document_sha256, title, expires_at)
         VALUES ($1, $2, 'app', $3, $4, 'Från en session', now() + interval '1 day')`,
        [owner.companyId, owner.userId, doc.id, doc.sha256],
      ],
      [`UPDATE public.signing_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [requestId]],
      [`DELETE FROM public.signing_requests WHERE id = $1`, [requestId]],
      [
        `INSERT INTO public.signing_request_signers (company_id, signing_request_id, position, name, token_hash)
         VALUES ($1, $2, 9, 'Från en session', $3)`,
        [owner.companyId, requestId, sha('session-insert')],
      ],
      [`UPDATE public.signing_request_signers SET email = 'ny@example.se' WHERE id = $1`, [signerIds[0]]],
      [`DELETE FROM public.signing_request_signers WHERE id = $1`, [signerIds[0]]],
      [`INSERT INTO public.signing_signer_private (signer_id, company_id) VALUES ($1, $2)`, [signerIds[0], owner.companyId]],
      [`UPDATE public.signing_signer_private SET lock_personnummer_hash = NULL WHERE signer_id = $1`, [signerIds[0]]],
      [`DELETE FROM public.signing_signer_private WHERE signer_id = $1`, [signerIds[0]]],
      [`SELECT public.record_signing_signature($1, $2, $3::jsonb)`, [signerIds[0], sessions[0], JSON.stringify(evidence())]],
    ]
    for (const [sql, args] of writes) {
      await withUserContext(owner.userId, async (client) => {
        await expect(client.query(sql, args), sql).rejects.toThrow(/permission denied/i)
      })
    }

    for (const sql of [
      `SELECT id FROM public.signing_requests`,
      `SELECT id FROM public.signing_request_signers`,
      `SELECT signer_id FROM public.signing_signer_private`,
      `SELECT public.record_signing_signature(gen_random_uuid(), 'x', '{}'::jsonb)`,
    ]) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE anon')
        await expect(client.query(sql), sql).rejects.toThrow(/permission denied/i)
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }

    expect(await requestState(requestId)).toMatchObject({ status: 'open' })
    expect(await consumed(sessions[0]!)).toBe(0)
  })
})

describe('signing_requests.pg: signers', () => {
  it('starts every signer pending: a signer is never inserted signed or declined', async () => {
    const { owner, requestId } = await plainRequest(0)
    await expect(
      getPool().query(
        `INSERT INTO public.signing_request_signers
           (company_id, signing_request_id, position, name, token_hash, status, signed_at, bankid_given_name, bankid_surname, user_visible_data)
         VALUES ($1, $2, 1, 'Anna', $3, 'signed', now(), 'Anna', 'Andersson', 'text')`,
        [owner.companyId, requestId, sha(randomUUID())],
      ),
    ).rejects.toThrow(/SIGNING_SIGNATURE_RPC_ONLY/)
    await expect(
      getPool().query(
        `INSERT INTO public.signing_request_signers (company_id, signing_request_id, position, name, token_hash, status, declined_at)
         VALUES ($1, $2, 1, 'Anna', $3, 'declined', now())`,
        [owner.companyId, requestId, sha(randomUUID())],
      ),
    ).rejects.toThrow(/SIGNING_SIGNATURE_RPC_ONLY/)
  })

  it("refuses a signer whose company is not the request's", async () => {
    const { owner, requestId } = await plainRequest(0)
    const other = await seedCompany()
    await expect(insertSigner(owner, requestId, { position: 1, companyId: other.companyId })).rejects.toThrow(/SIGNING_SIGNER_COMPANY_MISMATCH/)
  })

  it('takes a slot on an årsredovisning request only, and one on every signer of it', async () => {
    const { owner, requestId } = await plainRequest(0)
    await expect(insertSigner(owner, requestId, { position: 1, slotId: randomUUID() })).rejects.toThrow(/SIGNING_SIGNER_SLOT_MISMATCH/)
    const ar = await annualReportRequest(['Anna Andersson'])
    await expect(insertSigner(ar.owner, ar.requestId, { position: 2 })).rejects.toThrow(/SIGNING_SIGNER_SLOT_MISMATCH/)
  })

  it('refuses a service-role write that marks a signer signed outside record_signing_signature', async () => {
    const { signerIds } = await plainRequest(1)
    await expect(
      runAsServiceRole((client) =>
        client.query(
          `UPDATE public.signing_request_signers
              SET status = 'signed', signed_at = now(), bankid_given_name = 'Anna', bankid_surname = 'Andersson', user_visible_data = 'text'
            WHERE id = $1`,
          [signerIds[0]],
        ),
      ),
    ).rejects.toThrow(/SIGNING_SIGNATURE_RPC_ONLY/)
    expect(await signerState(signerIds[0]!)).toMatchObject({ status: 'pending', signed_at: null })
  })

  it('refuses a signature written to the private table outside record_signing_signature', async () => {
    const { owner, signerIds } = await plainRequest(2)
    await expect(
      runAsServiceRole((client) =>
        client.query(
          `INSERT INTO public.signing_signer_private (signer_id, company_id, bankid_personnummer_hash, signature_xml, ocsp_response, bankid_session_id)
           VALUES ($1, $2, $3, 'xml', 'ocsp', 'sess')`,
          [signerIds[0], owner.companyId, PN_HASH],
        ),
      ),
    ).rejects.toThrow(/SIGNING_SIGNATURE_RPC_ONLY/)
    await insertLock(signerIds[1]!, owner.companyId, PN_HASH)
    await expect(
      runAsServiceRole((client) =>
        client.query(
          `UPDATE public.signing_signer_private
              SET bankid_personnummer_hash = $2, signature_xml = 'xml', ocsp_response = 'ocsp', bankid_session_id = 'sess'
            WHERE signer_id = $1`,
          [signerIds[1], PN_HASH],
        ),
      ),
    ).rejects.toThrow(/SIGNING_SIGNATURE_RPC_ONLY/)
  })

  it('lets the server change a pending signer\'s link, session and address, never who the signer is', async () => {
    const { signerIds } = await plainRequest(1)
    const updated = await runAsServiceRole((client) =>
      client.query(
        `UPDATE public.signing_request_signers
            SET token_hash = $2, bankid_session_id = NULL, poll_lease_until = now(), email = 'ny@example.se', last_reminded_at = now()
          WHERE id = $1`,
        [signerIds[0], sha(randomUUID())],
      ),
    )
    expect(updated.rowCount).toBe(1)
    for (const set of [`name = 'Någon annan'`, `position = 7`, `lock_kind = 'personnummer'`, `role_label = 'VD'`, `signing_request_id = gen_random_uuid()`]) {
      await expect(getPool().query(`UPDATE public.signing_request_signers SET ${set} WHERE id = $1`, [signerIds[0]]), set).rejects.toThrow(/SIGNING_SIGNER_FROZEN/)
    }
  })
})

describe('signing_requests.pg: record_signing_signature', () => {
  it('records both signatures of a plain request and completes it with the last', async () => {
    const { requestId, signerIds, sessions } = await plainRequest(2)

    const first = await record(signerIds[0]!, sessions[0]!, evidence({ given_name: '  Anna ', surname: ' Andersson  ' }))
    expect(first).toMatchObject({ ok: true, signing_request_id: requestId, signer_id: signerIds[0], completed: false })
    expect(first.signed_at).toEqual(expect.any(String))
    expect(await requestState(requestId)).toMatchObject({ status: 'open', completed_at: null })

    const erikHash = sha('198112189876')
    const second = await record(
      signerIds[1]!,
      sessions[1]!,
      evidence({ given_name: 'Erik', surname: 'Eriksson', personnummer_hash: erikHash, personnummer_masked: 'XXXXXXXX-9876' }),
    )
    expect(second).toMatchObject({ ok: true, signing_request_id: requestId, signer_id: signerIds[1], completed: true })
    const request = await requestState(requestId)
    expect(request!.status).toBe('completed')
    expect(request!.completed_at).not.toBeNull()

    expect(await signerState(signerIds[0]!)).toMatchObject({
      status: 'signed',
      bankid_given_name: 'Anna',
      bankid_surname: 'Andersson',
      user_visible_data: '# Signera dokument\n\nJag signerar *Hyresavtal* för Test AB.',
      poll_lease_until: null,
      last_error_code: null,
    })
    expect((await signerState(signerIds[0]!))!.signed_at).not.toBeNull()
    expect(await signerState(signerIds[1]!)).toMatchObject({ status: 'signed', bankid_given_name: 'Erik', bankid_surname: 'Eriksson' })

    expect(await privateState(signerIds[0]!)).toMatchObject({
      signature_xml: evidence().signature_xml,
      ocsp_response: evidence().ocsp_response,
      bankid_personnummer_hash: PN_HASH,
      personnummer_masked: 'XXXXXXXX-1239',
      bankid_session_id: sessions[0],
    })
    expect(await privateState(signerIds[1]!)).toMatchObject({ bankid_personnummer_hash: erikHash, personnummer_masked: 'XXXXXXXX-9876', bankid_session_id: sessions[1] })
    expect(await consumed(sessions[0]!)).toBe(1)
    expect(await consumed(sessions[1]!)).toBe(1)
  })

  it('records a personnummer-locked signer whose BankID is that person, and drops the lock ciphertext', async () => {
    const { owner, requestId } = await plainRequest(0)
    const sessionId = session()
    const signerId = await insertSigner(owner, requestId, { position: 1, lockKind: 'personnummer', sessionId })
    await insertLock(signerId, owner.companyId, PN_HASH)

    expect(await record(signerId, sessionId)).toMatchObject({ ok: true, completed: true })
    expect(await privateState(signerId)).toMatchObject({
      lock_personnummer_hash: PN_HASH,
      lock_personnummer_encrypted: null,
      bankid_personnummer_hash: PN_HASH,
      bankid_session_id: sessionId,
    })
  })

  it('records a member-locked signer whose BankID login is that person', async () => {
    const { owner, requestId } = await plainRequest(0)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: memberId, role: 'member' })
    const memberHash = sha(`pn-member-${randomUUID()}`)
    await getPool().query(
      `INSERT INTO public.bankid_identities (user_id, personal_number_hash, personal_number_enc) VALUES ($1, $2, '\\x00'::bytea)`,
      [memberId, memberHash],
    )
    const sessionId = session()
    const signerId = await insertSigner(owner, requestId, { position: 1, userId: memberId, lockKind: 'member', sessionId })
    expect(await record(signerId, sessionId, evidence({ personnummer_hash: memberHash }))).toMatchObject({ ok: true, completed: true })
  })

  it('answers SIGNING_EVIDENCE_INCOMPLETE for any missing part of the evidence, consuming nothing', async () => {
    const { signerIds, sessions } = await plainRequest(1)
    const incomplete: Array<Record<string, unknown>> = [
      evidence({ personnummer_hash: null }),
      evidence({ personnummer_hash: 'not-a-hash' }),
      evidence({ personnummer_hash: PN_HASH.toUpperCase() }),
      evidence({ given_name: '   ' }),
      evidence({ surname: null }),
      evidence({ user_visible_data: '' }),
      evidence({ signature_xml: '' }),
      evidence({ ocsp_response: null }),
      evidence({ completed_at: '' }),
    ]
    for (const ev of incomplete) {
      expect(await record(signerIds[0]!, sessions[0]!, ev), JSON.stringify(ev).slice(0, 80)).toEqual({ ok: false, code: 'SIGNING_EVIDENCE_INCOMPLETE' })
    }
    expect(await record(signerIds[0]!, null)).toEqual({ ok: false, code: 'SIGNING_EVIDENCE_INCOMPLETE' })
    expect(await consumed(sessions[0]!)).toBe(0)
    expect(await signerState(signerIds[0]!)).toMatchObject({ status: 'pending' })
  })

  it('answers SIGNING_SIGNER_NOT_FOUND for an unknown signer', async () => {
    const sessionId = session()
    expect(await record(randomUUID(), sessionId)).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_FOUND' })
    expect(await consumed(sessionId)).toBe(0)
  })

  it('answers SIGNING_REQUEST_CLOSED for a cancelled, a declined, a completed and an expired request', async () => {
    const cancelled = await plainRequest(1)
    await getPool().query(`UPDATE public.signing_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [cancelled.requestId])
    expect(await record(cancelled.signerIds[0]!, cancelled.sessions[0]!)).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(await consumed(cancelled.sessions[0]!)).toBe(0)

    const declined = await plainRequest(2)
    await getPool().query(`UPDATE public.signing_requests SET status = 'declined', declined_at = now() WHERE id = $1`, [declined.requestId])
    expect(await record(declined.signerIds[1]!, declined.sessions[1]!)).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })

    const completed = await completedRequest()
    expect(await record(completed.signerIds[0]!, completed.sessions[0]!)).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })

    const owner = await seedCompany()
    const doc = await insertPdf(owner)
    const day = 24 * 60 * 60 * 1000
    const expiredId = await insertRequest(owner, doc, {
      createdAt: new Date(Date.now() - 20 * day).toISOString(),
      expiresAt: new Date(Date.now() - day).toISOString(),
    })
    const sessionId = session()
    const signerId = await insertSigner(owner, expiredId, { position: 1, sessionId })
    expect(await record(signerId, sessionId)).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(await consumed(sessionId)).toBe(0)
    expect(await signerState(signerId)).toMatchObject({ status: 'pending' })
  })

  it('answers SIGNING_SIGNER_NOT_PENDING for a signer who already signed', async () => {
    const { signerIds, sessions } = await plainRequest(2)
    expect((await record(signerIds[0]!, sessions[0]!)).ok).toBe(true)
    expect(await record(signerIds[0]!, sessions[0]!)).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
  })

  it('answers SIGNING_SESSION_MISMATCH for a session that is not the signer\'s latest, consuming neither', async () => {
    const { signerIds, sessions } = await plainRequest(1)
    const stale = session()
    expect(await record(signerIds[0]!, stale)).toEqual({ ok: false, code: 'SIGNING_SESSION_MISMATCH' })
    expect(await consumed(stale)).toBe(0)
    expect(await consumed(sessions[0]!)).toBe(0)

    const { owner, requestId } = await plainRequest(0)
    const idle = await insertSigner(owner, requestId, { position: 1, sessionId: null })
    expect(await record(idle, stale)).toEqual({ ok: false, code: 'SIGNING_SESSION_MISMATCH' })
  })

  it('answers SIGNING_SIGNER_MISMATCH for a personnummer lock signed with another BankID, and a lock that is missing', async () => {
    const { owner, requestId } = await plainRequest(0)
    const sessionId = session()
    const signerId = await insertSigner(owner, requestId, { position: 1, lockKind: 'personnummer', sessionId })
    await insertLock(signerId, owner.companyId, sha('198112189876'))
    expect(await record(signerId, sessionId, evidence({ personnummer_hash: PN_HASH }))).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    expect(await consumed(sessionId)).toBe(0)
    expect(await privateState(signerId)).toMatchObject({ signature_xml: null, lock_personnummer_encrypted: expect.any(Buffer) })

    const unlockedSession = session()
    const noLockRow = await insertSigner(owner, requestId, { position: 2, lockKind: 'personnummer', sessionId: unlockedSession })
    expect(await record(noLockRow, unlockedSession)).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    expect(await consumed(unlockedSession)).toBe(0)
  })

  it('answers SIGNING_SIGNER_MISMATCH for a member lock without a matching BankID login', async () => {
    const { owner, requestId } = await plainRequest(0)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: memberId, role: 'member' })
    const sessionId = session()
    const signerId = await insertSigner(owner, requestId, { position: 1, userId: memberId, lockKind: 'member', sessionId })
    // No BankID login at all.
    expect(await record(signerId, sessionId)).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    // A login, but of another person.
    await getPool().query(
      `INSERT INTO public.bankid_identities (user_id, personal_number_hash, personal_number_enc) VALUES ($1, $2, '\\x00'::bytea)`,
      [memberId, sha(`pn-other-${randomUUID()}`)],
    )
    expect(await record(signerId, sessionId)).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    expect(await consumed(sessionId)).toBe(0)
    expect(await signerState(signerId)).toMatchObject({ status: 'pending' })
  })

  it('answers SIGNING_SESSION_CONSUMED for a BankID session that already signed, and records nothing', async () => {
    const { signerIds, sessions } = await plainRequest(2)
    expect((await record(signerIds[0]!, sessions[0]!)).ok).toBe(true)
    // The second signer presents the first signer's session.
    await getPool().query(`UPDATE public.signing_request_signers SET bankid_session_id = $2 WHERE id = $1`, [signerIds[1], sessions[0]])
    expect(await record(signerIds[1]!, sessions[0]!, evidence({ personnummer_hash: sha('198112189876') }))).toEqual({ ok: false, code: 'SIGNING_SESSION_CONSUMED' })
    expect(await signerState(signerIds[1]!)).toMatchObject({ status: 'pending', signed_at: null })
    expect(await privateState(signerIds[1]!)).toBeUndefined()
    expect(await consumed(sessions[0]!)).toBe(1)

    // A session consumed elsewhere (a BankID login) cannot sign either.
    const other = await plainRequest(1)
    await getPool().query(`INSERT INTO public.bankid_consumed_sessions (session_id) VALUES ($1)`, [other.sessions[0]])
    expect(await record(other.signerIds[0]!, other.sessions[0]!)).toEqual({ ok: false, code: 'SIGNING_SESSION_CONSUMED' })
    expect(await signerState(other.signerIds[0]!)).toMatchObject({ status: 'pending' })
  })

  it('rolls the session consumption back with everything else when a write after it fails', async () => {
    const { signerIds, sessions } = await plainRequest(1)
    await expect(record(signerIds[0]!, sessions[0]!, evidence({ personnummer_masked: 'XXXX-12' }))).rejects.toThrow(/check constraint/i)
    expect(await consumed(sessions[0]!)).toBe(0)
    expect(await signerState(signerIds[0]!)).toMatchObject({ status: 'pending' })
    expect(await privateState(signerIds[0]!)).toBeUndefined()
    // The same session still signs once the evidence is right.
    expect(await record(signerIds[0]!, sessions[0]!)).toMatchObject({ ok: true, completed: true })
  })
})

describe('signing_requests.pg: signed evidence is frozen', () => {
  it('freezes a signed signer and its private row', async () => {
    const { signerIds } = await completedRequest()
    await expect(getPool().query(`UPDATE public.signing_request_signers SET email = 'ny@example.se' WHERE id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_FINAL/)
    await expect(getPool().query(`UPDATE public.signing_request_signers SET last_error_code = 'X' WHERE id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_FINAL/)
    await expect(getPool().query(`UPDATE public.signing_request_signers SET bankid_given_name = 'Annan' WHERE id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_FINAL/)
    await expect(getPool().query(`UPDATE public.signing_request_signers SET name = 'Annan' WHERE id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_FROZEN/)
    await expect(getPool().query(`UPDATE public.signing_signer_private SET ocsp_response = 'annan' WHERE signer_id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_FINAL/)
    await expect(getPool().query(`UPDATE public.signing_signer_private SET personnummer_masked = NULL WHERE signer_id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_FINAL/)
    const other = await seedCompany()
    await expect(getPool().query(`UPDATE public.signing_signer_private SET company_id = $2 WHERE signer_id = $1`, [signerIds[0], other.companyId])).rejects.toThrow(/SIGNING_SIGNER_FROZEN/)
    expect(await signerState(signerIds[0]!)).toMatchObject({ status: 'signed', bankid_given_name: 'Anna' })
  })

  it('freezes what a request is while it is open', async () => {
    const { requestId } = await plainRequest(1)
    for (const set of [`title = 'Ett annat avtal'`, `document_sha256 = repeat('0', 64)`, `expires_at = expires_at + interval '1 day'`, `message = 'Ny text'`, `created_via = 'mcp'`]) {
      await expect(getPool().query(`UPDATE public.signing_requests SET ${set} WHERE id = $1`, [requestId]), set).rejects.toThrow(/SIGNING_REQUEST_FROZEN/)
    }
  })

  it('lets a completed request take its sealed copies once, and nothing else', async () => {
    const { owner, requestId } = await completedRequest()
    const signed = await insertPdf(owner, 'hyresavtal-signerad.pdf')
    const evidenceZip = await insertPdf(owner, 'hyresavtal-bevispaket.zip')
    const sealed = await runAsServiceRole((client) =>
      client.query(`UPDATE public.signing_requests SET signed_document_id = $2, evidence_document_id = $3 WHERE id = $1`, [requestId, signed.id, evidenceZip.id]),
    )
    expect(sealed.rowCount).toBe(1)

    const again = await insertPdf(owner, 'annan.pdf')
    await expect(getPool().query(`UPDATE public.signing_requests SET signed_document_id = $2 WHERE id = $1`, [requestId, again.id])).rejects.toThrow(/SIGNING_REQUEST_CLOSED/)
    await expect(getPool().query(`UPDATE public.signing_requests SET evidence_document_id = $2 WHERE id = $1`, [requestId, again.id])).rejects.toThrow(/SIGNING_REQUEST_CLOSED/)
    await expect(getPool().query(`UPDATE public.signing_requests SET status = 'open', completed_at = NULL WHERE id = $1`, [requestId])).rejects.toThrow(/SIGNING_REQUEST_CLOSED/)
    await expect(getPool().query(`UPDATE public.signing_requests SET status = 'cancelled', completed_at = NULL, cancelled_at = now() WHERE id = $1`, [requestId])).rejects.toThrow(/SIGNING_REQUEST_CLOSED/)
    await expect(getPool().query(`UPDATE public.signing_requests SET title = 'Nytt' WHERE id = $1`, [requestId])).rejects.toThrow(/SIGNING_REQUEST_FROZEN/)
  })

  it('keeps a cancelled request closed and without sealed copies', async () => {
    const { owner, requestId } = await plainRequest(1)
    await getPool().query(`UPDATE public.signing_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [requestId])
    await expect(getPool().query(`UPDATE public.signing_requests SET status = 'open', cancelled_at = NULL WHERE id = $1`, [requestId])).rejects.toThrow(/SIGNING_REQUEST_CLOSED/)
    const copy = await insertPdf(owner, 'kopia.pdf')
    await expect(getPool().query(`UPDATE public.signing_requests SET signed_document_id = $2 WHERE id = $1`, [requestId, copy.id])).rejects.toThrow(/check constraint/i)
  })
})

describe('signing_requests.pg: deletes', () => {
  it('never deletes a request someone signed, its signed signer, the signature or its document', async () => {
    const { doc, requestId, signerIds, sessions } = await plainRequest(2)
    expect((await record(signerIds[0]!, sessions[0]!)).ok).toBe(true)

    await expect(getPool().query(`DELETE FROM public.signing_requests WHERE id = $1`, [requestId])).rejects.toThrow(/SIGNING_REQUEST_DELETE_BLOCKED/)
    await expect(getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [doc.id])).rejects.toThrow(/SIGNING_REQUEST_DELETE_BLOCKED/)
    await expect(getPool().query(`DELETE FROM public.signing_request_signers WHERE id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNER_DELETE_BLOCKED/)
    await expect(getPool().query(`DELETE FROM public.signing_signer_private WHERE signer_id = $1`, [signerIds[0]])).rejects.toThrow(/SIGNING_SIGNATURE_DELETE_BLOCKED/)

    expect(await countWhere('signing_requests', 'id', requestId)).toBe(1)
    expect(await countWhere('signing_request_signers', 'signing_request_id', requestId)).toBe(2)
    expect(await countWhere('signing_signer_private', 'signer_id', signerIds[0]!)).toBe(1)
    expect(await countWhere('document_attachments', 'id', doc.id)).toBe(1)
  })

  it('never deletes the sealed copies of a completed request', async () => {
    const { owner, requestId } = await completedRequest()
    const signed = await insertPdf(owner, 'signerad.pdf')
    const evidenceZip = await insertPdf(owner, 'bevispaket.zip')
    await getPool().query(`UPDATE public.signing_requests SET signed_document_id = $2, evidence_document_id = $3 WHERE id = $1`, [requestId, signed.id, evidenceZip.id])
    await expect(getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [signed.id])).rejects.toThrow(/SIGNING_REQUEST_DELETE_BLOCKED/)
    await expect(getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [evidenceZip.id])).rejects.toThrow(/SIGNING_REQUEST_DELETE_BLOCKED/)
  })

  it('deletes a request nobody signed together with its document, its signers and their locks', async () => {
    const { owner, doc, requestId, signerIds } = await plainRequest(2)
    await insertLock(signerIds[0]!, owner.companyId, PN_HASH)
    expect((await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [doc.id])).rowCount).toBe(1)
    expect(await countWhere('signing_requests', 'id', requestId)).toBe(0)
    expect(await countWhere('signing_request_signers', 'signing_request_id', requestId)).toBe(0)
    expect(await countWhere('signing_signer_private', 'signer_id', signerIds[0]!)).toBe(0)
  })

  it('lets the teardown flag set by hand delete nothing signed in a company that is not a sandbox', async () => {
    const { requestId } = await completedRequest()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await expect(client.query(`DELETE FROM public.signing_requests WHERE id = $1`, [requestId])).rejects.toThrow(/SIGNING_REQUEST_DELETE_BLOCKED/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(await countWhere('signing_requests', 'id', requestId)).toBe(1)
  })

  it('lets cleanup_sandbox_user tear down a sandbox company with a completed request', async () => {
    const owner = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`, [owner.userId, owner.companyId])
    const doc = await insertPdf(owner)
    const requestId = await insertRequest(owner, doc)
    const sessionId = session()
    const signerId = await insertSigner(owner, requestId, { position: 1, sessionId, userId: owner.userId })
    expect(await record(signerId, sessionId)).toMatchObject({ ok: true, completed: true })
    const signed = await insertPdf(owner, 'signerad.pdf')
    const evidenceZip = await insertPdf(owner, 'bevispaket.zip')
    await getPool().query(`UPDATE public.signing_requests SET signed_document_id = $2, evidence_document_id = $3 WHERE id = $1`, [requestId, signed.id, evidenceZip.id])

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [owner.userId])

    expect(await countWhere('signing_requests', 'id', requestId)).toBe(0)
    expect(await countWhere('signing_request_signers', 'id', signerId)).toBe(0)
    expect(await countWhere('signing_signer_private', 'signer_id', signerId)).toBe(0)
    expect(await countWhere('document_attachments', 'company_id', owner.companyId)).toBe(0)
    const { rows } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.users WHERE id = $1`, [owner.userId])
    expect(rows[0]!.n).toBe(0)
  })
})

describe('signing_requests.pg: an årsredovisning request', () => {
  it('fills each signature slot of the locked version and signs the version with the last signature', async () => {
    const { owner, doc, versionId, slotIds, requestId, signerIds, sessions } = await annualReportRequest()

    expect(await record(signerIds[0]!, sessions[0]!)).toMatchObject({ ok: true, completed: false })
    const slot = async (id: string) =>
      (
        await getPool().query<{
          status: string
          signed_at: Date | null
          signing_method: string | null
          evidence_reference: string | null
          evidence_recorded_by: string | null
          evidence_recorded_at: Date | null
          bankid_signature_data: Record<string, unknown> | null
        }>(
          `SELECT status, signed_at, signing_method, evidence_reference, evidence_recorded_by, evidence_recorded_at, bankid_signature_data
             FROM public.arsredovisning_signature_requests WHERE id = $1`,
          [id],
        )
      ).rows[0]!
    const versionStatus = async () =>
      (await getPool().query<{ status: string }>(`SELECT status FROM public.annual_report_versions WHERE id = $1`, [versionId])).rows[0]!.status

    const first = await slot(slotIds[0]!)
    expect(first).toMatchObject({
      status: 'signed',
      signing_method: 'bankid',
      evidence_reference: `receipt:signing/${requestId}/${signerIds[0]}`,
      evidence_recorded_by: owner.userId,
    })
    expect(first.signed_at).not.toBeNull()
    expect(first.evidence_recorded_at).not.toBeNull()
    expect(first.bankid_signature_data).toMatchObject({
      signing_request_id: requestId,
      signing_signer_id: signerIds[0],
      given_name: 'Anna',
      surname: 'Andersson',
      document_sha256: doc.sha256,
    })
    expect(await slot(slotIds[1]!)).toMatchObject({ status: 'pending', signing_method: null })
    expect(await versionStatus()).toBe('ready_for_signature')

    expect(await record(signerIds[1]!, sessions[1]!, evidence({ given_name: 'Erik', surname: 'Eriksson', personnummer_hash: sha('198112189876') }))).toMatchObject({
      ok: true,
      completed: true,
    })
    const second = await slot(slotIds[1]!)
    expect(second).toMatchObject({
      status: 'signed',
      signing_method: 'bankid',
      evidence_reference: `receipt:signing/${requestId}/${signerIds[1]}`,
      // The second signer is no member: nobody in the company recorded it.
      evidence_recorded_by: null,
    })
    expect(second.bankid_signature_data).toMatchObject({ signing_signer_id: signerIds[1], given_name: 'Erik' })
    expect(await versionStatus()).toBe('signed')
    expect(await requestState(requestId)).toMatchObject({ status: 'completed' })
  })

  it('answers SIGNING_SUBJECT_CHANGED once the version is superseded, consuming nothing and leaving the slot pending', async () => {
    const { versionId, slotIds, signerIds, sessions } = await annualReportRequest()
    await getPool().query(`UPDATE public.annual_report_versions SET status = 'superseded' WHERE id = $1`, [versionId])
    expect(await record(signerIds[0]!, sessions[0]!)).toEqual({ ok: false, code: 'SIGNING_SUBJECT_CHANGED' })
    expect(await consumed(sessions[0]!)).toBe(0)
    expect(await signerState(signerIds[0]!)).toMatchObject({ status: 'pending' })
    const { rows } = await getPool().query<{ status: string }>(`SELECT status FROM public.arsredovisning_signature_requests WHERE id = $1`, [slotIds[0]])
    expect(rows[0]!.status).toBe('pending')
  })

  it('rolls everything back, the session too, when the slot was signed another way first', async () => {
    const { owner, slotIds, signerIds, sessions } = await annualReportRequest()
    await getPool().query(
      `UPDATE public.arsredovisning_signature_requests
          SET status = 'signed', signed_at = now(), signing_method = 'paper_original', evidence_reference = 'archive:A-1',
              evidence_recorded_by = $2, evidence_recorded_at = now()
        WHERE id = $1`,
      [slotIds[0], owner.userId],
    )
    await expect(record(signerIds[0]!, sessions[0]!)).rejects.toThrow(/SIGNING_SLOT_NOT_PENDING/)
    expect(await consumed(sessions[0]!)).toBe(0)
    expect(await signerState(signerIds[0]!)).toMatchObject({ status: 'pending', signed_at: null })
    expect(await privateState(signerIds[0]!)).toBeUndefined()
  })
})

describe('signing_requests.pg: the signers audit trail', () => {
  it('leaves the withheld columns out of audit_log and writes nothing for a poll lease', async () => {
    const owner = await seedCompany()
    const requestId = await insertRequest(owner, await insertPdf(owner))
    const signerId = await insertSigner(owner, requestId, { position: 1, sessionId: session() })

    const audit = async () =>
      (await getPool().query<{ old_state: Record<string, unknown> | null; new_state: Record<string, unknown> | null }>(
        `SELECT old_state, new_state FROM public.audit_log WHERE table_name = 'signing_request_signers' AND record_id = $1 ORDER BY created_at`,
        [signerId],
      )).rows

    const inserted = await audit()
    expect(inserted).toHaveLength(1)
    for (const key of ['token_hash', 'bankid_session_id', 'poll_lease_until']) expect(inserted[0]!.new_state).not.toHaveProperty(key)
    expect(inserted[0]!.new_state).toMatchObject({ id: signerId, status: 'pending' })

    await getPool().query(`UPDATE public.signing_request_signers SET poll_lease_until = now() + interval '10 seconds' WHERE id = $1`, [signerId])
    await getPool().query(`UPDATE public.signing_request_signers SET token_hash = $2 WHERE id = $1`, [signerId, sha(`token-${randomUUID()}`)])
    expect(await audit()).toHaveLength(1)

    await getPool().query(`UPDATE public.signing_request_signers SET last_error_code = 'SIGNING_NAME_MISMATCH' WHERE id = $1`, [signerId])
    const updated = await audit()
    expect(updated).toHaveLength(2)
    expect(updated[1]!.new_state).toMatchObject({ last_error_code: 'SIGNING_NAME_MISMATCH' })
    expect(updated[1]!.old_state).not.toHaveProperty('token_hash')
  })
})
