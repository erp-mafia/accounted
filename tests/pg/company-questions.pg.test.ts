import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * company_questions (migration 20261119160000): members read their own
 * companies' questions and write none; the service role writes; one question
 * per company and fingerprint; a question is open exactly while it has no
 * answered_at, and closed exactly when it has a close_reason.
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
})
