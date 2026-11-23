import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * company_questions (migration 20261119160000): members read their own
 * companies' questions and write none; the service role writes; one question
 * per company and fingerprint; a question is open exactly while it has no
 * answered_at, and closed exactly when it has a close_reason.
 *
 * close_note and close_evidence (migration 20261122220500): a note of 1 to
 * 300 characters after trimming, at most eight records, and either one only
 * on a question closed as settled.
 */

const fingerprintOf = (seed: string) => createHash('sha256').update(seed).digest('hex')

async function insertQuestion(companyId: string, overrides: { fingerprint?: string; question?: string } = {}): Promise<string> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.company_questions (company_id, question, options, evidence, fingerprint)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id`,
      [
        companyId,
        overrides.question ?? 'Is there a written agreement?',
        JSON.stringify([{ id: 'yes', label: 'Yes' }]),
        JSON.stringify([{ kind: 'transaction', id: randomUUID() }]),
        overrides.fingerprint ?? fingerprintOf(randomUUID()),
      ],
    )
    return rows[0].id
  })
}

describe('company_questions', () => {
  let userId: string
  let companyId: string

  beforeEach(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('starts a question open, with empty defaults', async () => {
    const id = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.company_questions (company_id, question, fingerprint) VALUES ($1, 'Why?', $2) RETURNING id`,
        [companyId, fingerprintOf(randomUUID())],
      )
      return rows[0].id
    })
    const { rows } = await getPool().query(
      `SELECT status, close_reason, options, evidence, answered_at, fact_id FROM public.company_questions WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ status: 'open', close_reason: null, options: [], evidence: [], answered_at: null, fact_id: null })
  })

  it('lets members read their own company\'s questions only', async () => {
    const mine = await insertQuestion(companyId)
    const other = await seedCompany()
    await insertQuestion(other.companyId)
    await setActiveCompany(userId, companyId)

    const seen = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.company_questions`)
      return rows.map((r) => r.id)
    })
    expect(seen).toEqual([mine])
  })

  it('refuses every write from a member', async () => {
    const id = await insertQuestion(companyId)
    await setActiveCompany(userId, companyId)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`INSERT INTO public.company_questions (company_id, question, fingerprint) VALUES ($1, 'Why?', $2)`, [
          companyId,
          fingerprintOf(randomUUID()),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.company_questions SET question = 'Changed' WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) => client.query(`DELETE FROM public.company_questions WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('holds one question per company and fingerprint, whatever its status', async () => {
    const fingerprint = fingerprintOf('same records')
    const first = await insertQuestion(companyId, { fingerprint })
    await expect(insertQuestion(companyId, { fingerprint })).rejects.toMatchObject({ code: '23505' })

    await getPool().query(
      `UPDATE public.company_questions SET status = 'closed', close_reason = 'settled', answered_at = now() WHERE id = $1`,
      [first],
    )
    await expect(insertQuestion(companyId, { fingerprint })).rejects.toMatchObject({ code: '23505' })

    const other = await seedCompany()
    await expect(insertQuestion(other.companyId, { fingerprint })).resolves.toEqual(expect.any(String))
  })

  it('keeps status, close_reason and answered_at in step', async () => {
    const id = await insertQuestion(companyId)
    const update = (sql: string) => getPool().query(`UPDATE public.company_questions SET ${sql} WHERE id = $1`, [id])

    // Closed needs a reason, and a reason needs closed.
    await expect(update(`status = 'closed', answered_at = now()`)).rejects.toMatchObject({ code: '23514' })
    await expect(update(`close_reason = 'settled'`)).rejects.toMatchObject({ code: '23514' })
    // Open has no answered_at; answered and closed have one.
    await expect(update(`answered_at = now()`)).rejects.toMatchObject({ code: '23514' })
    await expect(update(`status = 'answered'`)).rejects.toMatchObject({ code: '23514' })
    // A reason outside the list.
    await expect(update(`status = 'closed', close_reason = 'bored', answered_at = now()`)).rejects.toMatchObject({ code: '23514' })

    await update(`status = 'answered', answer_text = 'An annual payment.', answered_at = now(), answered_via = 'test'`)
    const { rows } = await getPool().query(`SELECT status, answer_text FROM public.company_questions WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ status: 'answered', answer_text: 'An annual payment.' })
  })

  it('refuses more than three options, more than eight evidence references and a malformed fingerprint', async () => {
    const insert = (options: unknown[], evidence: unknown[], fingerprint: string) =>
      getPool().query(
        `INSERT INTO public.company_questions (company_id, question, options, evidence, fingerprint)
         VALUES ($1, 'Why?', $2::jsonb, $3::jsonb, $4)`,
        [companyId, JSON.stringify(options), JSON.stringify(evidence), fingerprint],
      )
    const option = (n: number) => ({ id: `o${n}`, label: `Option ${n}` })
    const ref = () => ({ kind: 'transaction', id: randomUUID() })

    await expect(insert([1, 2, 3, 4].map(option), [ref()], fingerprintOf(randomUUID()))).rejects.toMatchObject({ code: '23514' })
    await expect(
      insert([option(1)], Array.from({ length: 9 }, ref), fingerprintOf(randomUUID())),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insert([option(1)], [ref()], 'not-a-fingerprint')).rejects.toMatchObject({ code: '23514' })
    await expect(insert([1, 2, 3].map(option), Array.from({ length: 8 }, ref), fingerprintOf(randomUUID()))).resolves.toBeDefined()
  })

  it('keeps the question when the fact that answered it is removed', async () => {
    const id = await insertQuestion(companyId)
    const { rows: facts } = await getPool().query<{ id: string }>(
      `INSERT INTO public.agent_memory (company_id, kind, content, source) VALUES ($1, 'fact', 'An annual payment.', 'agent_learned') RETURNING id`,
      [companyId],
    )
    await getPool().query(
      `UPDATE public.company_questions SET status = 'answered', fact_id = $2, answered_at = now() WHERE id = $1`,
      [id, facts[0].id],
    )
    await getPool().query(`DELETE FROM public.agent_memory WHERE id = $1`, [facts[0].id])
    const { rows } = await getPool().query(`SELECT status, fact_id FROM public.company_questions WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ status: 'answered', fact_id: null })
  })

  it('starts a question without a close note and with no close evidence, and lets a member read both', async () => {
    const id = await insertQuestion(companyId)
    const { rows } = await getPool().query(`SELECT close_note, close_evidence FROM public.company_questions WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ close_note: null, close_evidence: [] })

    await getPool().query(
      `UPDATE public.company_questions
          SET status = 'closed', close_reason = 'settled', answered_at = now(),
              close_note = 'Booked against the supplier invoice.', close_evidence = $2::jsonb
        WHERE id = $1`,
      [id, JSON.stringify([{ kind: 'transaction', id: randomUUID() }])],
    )
    await setActiveCompany(userId, companyId)
    const seen = await withUserContext(userId, async (client) => {
      const { rows: mine } = await client.query<{ close_note: string | null; close_evidence: unknown[] }>(
        `SELECT close_note, close_evidence FROM public.company_questions WHERE id = $1`,
        [id],
      )
      return mine[0]
    })
    expect(seen.close_note).toBe('Booked against the supplier invoice.')
    expect(seen.close_evidence).toHaveLength(1)
  })

  it('holds a close note to 1 to 300 characters after trimming, and close evidence to an array of at most eight', async () => {
    const id = await insertQuestion(companyId)
    const settle = (note: string | null, evidence: unknown) =>
      getPool().query(
        `UPDATE public.company_questions
            SET status = 'closed', close_reason = 'settled', answered_at = now(), close_note = $2, close_evidence = $3::jsonb
          WHERE id = $1`,
        [id, note, JSON.stringify(evidence)],
      )
    const ref = () => ({ kind: 'transaction', id: randomUUID() })

    await expect(settle('', [ref()])).rejects.toMatchObject({ code: '23514' })
    await expect(settle('   ', [ref()])).rejects.toMatchObject({ code: '23514' })
    await expect(settle('a'.repeat(301), [ref()])).rejects.toMatchObject({ code: '23514' })
    await expect(settle('Booked.', Array.from({ length: 9 }, ref))).rejects.toMatchObject({ code: '23514' })
    await expect(settle('Booked.', { kind: 'transaction' })).rejects.toMatchObject({ code: '23514' })
    await expect(settle('Booked.', 'transaction')).rejects.toMatchObject({ code: '23514' })

    // 300 characters, counted after trimming, with eight records.
    await expect(settle(` ${'a'.repeat(300)} `, Array.from({ length: 8 }, ref))).resolves.toBeDefined()
    // Records without a note, and a settled close with neither.
    await expect(settle(null, [ref()])).resolves.toBeDefined()
    await expect(settle(null, [])).resolves.toBeDefined()
  })

  it('holds a close note and close evidence only on a question closed as settled', async () => {
    const evidence = JSON.stringify([{ kind: 'transaction', id: randomUUID() }])
    const update = (id: string, sql: string, params: unknown[] = []) =>
      getPool().query(`UPDATE public.company_questions SET ${sql} WHERE id = $1`, [id, ...params])

    // An open question carries neither.
    const open = await insertQuestion(companyId)
    await expect(update(open, `close_note = 'Booked.'`)).rejects.toMatchObject({ code: '23514' })
    await expect(update(open, `close_evidence = $2::jsonb`, [evidence])).rejects.toMatchObject({ code: '23514' })

    // Nor does an answered one, or one closed with another reason.
    const answered = await insertQuestion(companyId)
    await expect(
      update(answered, `status = 'answered', answered_at = now(), close_note = 'Booked.', close_evidence = $2::jsonb`, [evidence]),
    ).rejects.toMatchObject({ code: '23514' })
    for (const reason of ['dont_know', 'not_relevant', 'withdrawn']) {
      const closed = await insertQuestion(companyId)
      await expect(
        update(closed, `status = 'closed', close_reason = $2, answered_at = now(), close_note = 'Booked.'`, [reason]),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        update(closed, `status = 'closed', close_reason = $2, answered_at = now(), close_evidence = $3::jsonb`, [reason, evidence]),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(update(closed, `status = 'closed', close_reason = $2, answered_at = now()`, [reason])).resolves.toBeDefined()
    }

    // A settled one carries both, and cannot be opened again while it does.
    const settled = await insertQuestion(companyId)
    await update(settled, `status = 'closed', close_reason = 'settled', answered_at = now(), close_note = 'Booked.', close_evidence = $2::jsonb`, [evidence])
    await expect(update(settled, `status = 'open', close_reason = NULL, answered_at = NULL`)).rejects.toMatchObject({ code: '23514' })
    await update(settled, `status = 'open', close_reason = NULL, answered_at = NULL, close_note = NULL, close_evidence = '[]'::jsonb`)
    const { rows } = await getPool().query(`SELECT status, close_note, close_evidence FROM public.company_questions WHERE id = $1`, [settled])
    expect(rows[0]).toEqual({ status: 'open', close_note: null, close_evidence: [] })
  })
})

