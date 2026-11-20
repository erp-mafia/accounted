/**
 * pg-real tests for 20261030010000_corporate_meetings.sql: meetings,
 * decisions and minutes (ABL 7:48, 8:24-26). Locks in:
 *   - RLS: a company sees only its own meetings and decisions; a decision
 *     cannot be hung on another company's meeting; a viewer reads but does
 *     not write;
 *   - a meeting starts as an unnumbered draft; board minutes take the
 *     company's next number when held (ABL 8:26), unique per company, and a
 *     number is never set by hand;
 *   - status only moves draft -> held -> signed, and only a draft is deleted;
 *   - signed minutes are immutable: the meeting and its decisions never
 *     change and are never deleted, except that a signed copy still being
 *     sealed is filled in once;
 *   - minutes out for BankID signing are frozen until the request ends;
 *   - the four pending operation types are allowed.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

let companyA: { userId: string; companyId: string; fiscalPeriodId: string }
let companyB: { userId: string; companyId: string; fiscalPeriodId: string }

async function insertMeeting(
  company: { companyId: string; userId: string },
  kind: 'arsstamma' | 'extra_stamma' | 'styrelsemote' | 'per_capsulam' = 'styrelsemote',
): Promise<string> {
  const id = randomUUID()
  const organ = kind === 'arsstamma' || kind === 'extra_stamma' ? 'bolagsstamma' : 'styrelse'
  await getPool().query(
    `INSERT INTO public.corporate_meetings (id, company_id, kind, organ, meeting_date, created_by)
     VALUES ($1, $2, $3, $4, '2027-03-01', $5)`,
    [id, company.companyId, kind, organ, company.userId],
  )
  return id
}

async function insertDecision(companyId: string, meetingId: string, item = 1): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.corporate_decisions (id, company_id, meeting_id, item_number, kind, title, payload)
     VALUES ($1, $2, $3, $4, 'ovrigt', 'Mötets öppnande', '{"topic":"oppnande"}'::jsonb)`,
    [id, companyId, meetingId, item],
  )
  return id
}

async function hold(meetingId: string): Promise<number | null> {
  const res = await getPool().query<{ sequence_number: number | null }>(
    `UPDATE public.corporate_meetings SET status = 'held', held_at = now() WHERE id = $1 RETURNING sequence_number`,
    [meetingId],
  )
  return res.rows[0]?.sequence_number ?? null
}

async function sign(meetingId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.corporate_meetings SET status = 'signed', signed_at = now(), signature_names = 'Anna Ek' WHERE id = $1`,
    [meetingId],
  )
}

async function insertDocument(company: { companyId: string; userId: string }): Promise<string> {
  const docId = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'Protokoll.pdf', 'application/pdf', 2048, $4, $5, 'file_upload')`,
    [docId, company.userId, company.companyId, `documents/${company.companyId}/${docId}.pdf`, 'b'.repeat(64)],
  )
  return docId
}

async function insertSigningRequest(company: { companyId: string; userId: string }): Promise<string> {
  const docId = await insertDocument(company)
  const requestId = randomUUID()
  await getPool().query(
    `INSERT INTO public.signing_requests (id, company_id, created_by, created_via, document_id, document_sha256, title, expires_at)
     VALUES ($1, $2, $3, 'app', $4, $5, 'Protokoll', now() + interval '14 days')`,
    [requestId, company.companyId, company.userId, docId, 'b'.repeat(64)],
  )
  return requestId
}

beforeAll(async () => {
  companyA = await seedCompany()
  companyB = await seedCompany()
})

describe('corporate meetings: schema', () => {
  it('allows the four pending operation types', async () => {
    const res = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.pending_operations'::regclass AND conname = 'pending_operations_operation_type_check'`,
    )
    for (const type of ['create_corporate_meeting', 'update_corporate_meeting', 'record_corporate_decision', 'hold_corporate_meeting']) {
      expect(res.rows[0]?.def).toContain(type)
    }
  })

  it('ties the body to the kind and refuses an unknown decision kind', async () => {
    await expect(getPool().query(
      `INSERT INTO public.corporate_meetings (company_id, kind, organ, meeting_date) VALUES ($1, 'arsstamma', 'styrelse', '2027-05-10')`,
      [companyA.companyId],
    )).rejects.toMatchObject({ code: '23514' })
    const meetingId = await insertMeeting(companyA)
    await expect(getPool().query(
      `INSERT INTO public.corporate_decisions (company_id, meeting_id, item_number, kind, title) VALUES ($1, $2, 1, 'fest', 'Fest')`,
      [companyA.companyId, meetingId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('starts every meeting as an unnumbered draft', async () => {
    await expect(getPool().query(
      `INSERT INTO public.corporate_meetings (company_id, kind, organ, meeting_date, status, held_at) VALUES ($1, 'styrelsemote', 'styrelse', '2027-03-01', 'held', now())`,
      [companyA.companyId],
    )).rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(getPool().query(
      `INSERT INTO public.corporate_meetings (company_id, kind, organ, meeting_date, sequence_number) VALUES ($1, 'styrelsemote', 'styrelse', '2027-03-01', 7)`,
      [companyA.companyId],
    )).rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
  })
})

describe('corporate meetings: RLS', () => {
  it('shows a company only its own meetings and decisions', async () => {
    const meetingId = await insertMeeting(companyA)
    await insertDecision(companyA.companyId, meetingId)
    const seenByB = await withUserContext(companyB.userId, async (client) => ({
      meetings: (await client.query('SELECT id FROM public.corporate_meetings WHERE id = $1', [meetingId])).rowCount,
      decisions: (await client.query('SELECT id FROM public.corporate_decisions WHERE meeting_id = $1', [meetingId])).rowCount,
    }))
    const seenByA = await withUserContext(companyA.userId, async (client) =>
      (await client.query('SELECT id FROM public.corporate_decisions WHERE meeting_id = $1', [meetingId])).rowCount)
    expect(seenByB).toEqual({ meetings: 0, decisions: 0 })
    expect(seenByA).toBe(1)
  })

  it('refuses a decision hung on another company\'s meeting', async () => {
    const meetingId = await insertMeeting(companyA)
    await expect(withUserContext(companyB.userId, (client) => client.query(
      `INSERT INTO public.corporate_decisions (company_id, meeting_id, item_number, kind, title) VALUES ($1, $2, 1, 'ovrigt', 'Smuggel')`,
      [companyB.companyId, meetingId],
    ))).rejects.toBeTruthy()
    await expect(getPool().query(
      `INSERT INTO public.corporate_decisions (company_id, meeting_id, item_number, kind, title) VALUES ($1, $2, 1, 'ovrigt', 'Smuggel')`,
      [companyB.companyId, meetingId],
    )).rejects.toThrow(/CORPORATE_MEETING_NOT_FOUND/)
  })

  it('lets a viewer read the meetings but not write them', async () => {
    const meetingId = await insertMeeting(companyA)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: companyA.companyId, userId: viewerId, role: 'viewer' })
    const seen = await withUserContext(viewerId, async (client) =>
      (await client.query('SELECT id FROM public.corporate_meetings WHERE id = $1', [meetingId])).rowCount)
    expect(seen).toBe(1)
    await expect(withUserContext(viewerId, (client) =>
      client.query(`UPDATE public.corporate_meetings SET place = 'Ändrad' WHERE id = $1`, [meetingId]),
    )).rejects.toMatchObject({ code: '42501' })
  })

  it('lets the member write a draft and its decisions', async () => {
    const meetingId = await insertMeeting(companyA)
    const changed = await withUserContext(companyA.userId, async (client) => {
      await client.query(`UPDATE public.corporate_meetings SET place = 'Kontoret' WHERE id = $1`, [meetingId])
      await client.query(
        `INSERT INTO public.corporate_decisions (company_id, meeting_id, item_number, kind, title) VALUES ($1, $2, 1, 'ovrigt', 'Öppnande')`,
        [companyA.companyId, meetingId],
      )
      return (await client.query('SELECT place FROM public.corporate_meetings WHERE id = $1', [meetingId])).rows[0]
    })
    expect(changed).toEqual({ place: 'Kontoret' })
  })
})

describe('corporate meetings: board minutes in numerical order (ABL 8:26)', () => {
  it('numbers board meetings per company when held, and never a stämma', async () => {
    const company = await seedCompany()
    const other = await seedCompany()
    const first = await insertMeeting(company, 'styrelsemote')
    const second = await insertMeeting(company, 'styrelsemote')
    const perCapsulam = await insertMeeting(company, 'per_capsulam')
    const stamma = await insertMeeting(company, 'extra_stamma')
    const elsewhere = await insertMeeting(other, 'styrelsemote')
    expect(await hold(second)).toBe(1)
    expect(await hold(first)).toBe(2)
    expect(await hold(perCapsulam)).toBe(3)
    expect(await hold(stamma)).toBeNull()
    expect(await hold(elsewhere)).toBe(1)
  })

  it('never takes a number by hand, and the number is unique per company', async () => {
    const company = await seedCompany()
    const held = await insertMeeting(company, 'styrelsemote')
    await hold(held)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET sequence_number = 9 WHERE id = $1`, [held]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    const draft = await insertMeeting(company, 'styrelsemote')
    await expect(getPool().query(`UPDATE public.corporate_meetings SET sequence_number = 1 WHERE id = $1`, [draft]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    const idx = await getPool().query<{ def: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indexrelid = 'public.corporate_meetings_board_number'::regclass`,
    )
    expect(idx.rows[0]?.def).toMatch(/UNIQUE INDEX .* \(company_id, sequence_number\)/)
  })
})

describe('corporate meetings: status and deletion', () => {
  it('deletes a draft with its decisions, never a held meeting', async () => {
    const draft = await insertMeeting(companyA)
    await insertDecision(companyA.companyId, draft)
    // withUserContext rolls its transaction back, so the cascade is read in
    // the same transaction as the delete.
    const { deleted, left } = await withUserContext(companyA.userId, async (client) => {
      const removed = await client.query('DELETE FROM public.corporate_meetings WHERE id = $1', [draft])
      const remaining = await client.query('SELECT id FROM public.corporate_decisions WHERE meeting_id = $1', [draft])
      return { deleted: removed.rowCount, left: remaining.rowCount }
    })
    expect(deleted).toBe(1)
    expect(left).toBe(0)

    const held = await insertMeeting(companyA)
    await hold(held)
    await expect(getPool().query('DELETE FROM public.corporate_meetings WHERE id = $1', [held])).rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    const policyHidden = await withUserContext(companyA.userId, async (client) =>
      (await client.query('DELETE FROM public.corporate_meetings WHERE id = $1', [held])).rowCount)
    expect(policyHidden).toBe(0)
  })

  it('never goes back to draft and signs only a held meeting', async () => {
    const draft = await insertMeeting(companyA)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET status = 'signed', held_at = now(), signed_at = now() WHERE id = $1`, [draft]))
      .rejects.toThrow(/CORPORATE_MEETING_NOT_HELD/)
    await hold(draft)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET status = 'draft' WHERE id = $1`, [draft]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
  })

  it('lets the decisions of a held, unsigned meeting change', async () => {
    const meetingId = await insertMeeting(companyA)
    const decisionId = await insertDecision(companyA.companyId, meetingId)
    await hold(meetingId)
    await getPool().query(`UPDATE public.corporate_decisions SET outcome = 'avslagen' WHERE id = $1`, [decisionId])
    await expect(getPool().query(`UPDATE public.corporate_decisions SET meeting_id = $2 WHERE id = $1`, [decisionId, await insertMeeting(companyA)]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
  })
})

describe('corporate meetings: signed minutes are immutable', () => {
  it('refuses any change to signed minutes, their decisions and their deletion', async () => {
    const meetingId = await insertMeeting(companyA, 'extra_stamma')
    const decisionId = await insertDecision(companyA.companyId, meetingId)
    await hold(meetingId)
    await sign(meetingId)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET place = 'Annan' WHERE id = $1`, [meetingId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET status = 'held' WHERE id = $1`, [meetingId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(getPool().query(`UPDATE public.corporate_decisions SET text = 'Ändrad' WHERE id = $1`, [decisionId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(getPool().query(`DELETE FROM public.corporate_decisions WHERE id = $1`, [decisionId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(insertDecision(companyA.companyId, meetingId, 2)).rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(getPool().query(`DELETE FROM public.corporate_meetings WHERE id = $1`, [meetingId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
  })

  it('fills in a signed copy once, never replaces it', async () => {
    const meetingId = await insertMeeting(companyA)
    await hold(meetingId)
    await sign(meetingId)
    const first = await insertDocument(companyA)
    await getPool().query(`UPDATE public.corporate_meetings SET signed_document_id = $2 WHERE id = $1`, [meetingId, first])
    const second = await insertDocument(companyA)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET signed_document_id = $2 WHERE id = $1`, [meetingId, second]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
  })
})

describe('corporate meetings: minutes out for BankID signing', () => {
  it('freezes the minutes while the request runs, and lets it end or complete', async () => {
    const meetingId = await insertMeeting(companyA)
    const decisionId = await insertDecision(companyA.companyId, meetingId)
    const requestId = await insertSigningRequest(companyA)
    await expect(getPool().query(`UPDATE public.corporate_meetings SET signing_request_id = $2 WHERE id = $1`, [meetingId, requestId]))
      .rejects.toThrow(/CORPORATE_MEETING_NOT_HELD/)
    await hold(meetingId)
    await getPool().query(`UPDATE public.corporate_meetings SET signing_request_id = $2 WHERE id = $1`, [meetingId, requestId])
    await expect(getPool().query(`UPDATE public.corporate_meetings SET place = 'Annan' WHERE id = $1`, [meetingId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    await expect(getPool().query(`UPDATE public.corporate_decisions SET outcome = 'avslagen' WHERE id = $1`, [decisionId]))
      .rejects.toThrow(/CORPORATE_MEETING_LOCKED/)
    // The request was cancelled: the minutes open again.
    await getPool().query(`UPDATE public.corporate_meetings SET signing_request_id = NULL WHERE id = $1`, [meetingId])
    await getPool().query(`UPDATE public.corporate_decisions SET outcome = 'avslagen' WHERE id = $1`, [decisionId])
    // A new request completes: the minutes are signed under it.
    const next = await insertSigningRequest(companyA)
    await getPool().query(`UPDATE public.corporate_meetings SET signing_request_id = $2 WHERE id = $1`, [meetingId, next])
    await getPool().query(
      `UPDATE public.corporate_meetings SET status = 'signed', signed_at = now(), signature_names = 'Anna Ek' WHERE id = $1`,
      [meetingId],
    )
    const row = await getPool().query<{ status: string; signing_request_id: string }>(
      'SELECT status, signing_request_id FROM public.corporate_meetings WHERE id = $1',
      [meetingId],
    )
    expect(row.rows[0]).toEqual({ status: 'signed', signing_request_id: next })
  })
})
