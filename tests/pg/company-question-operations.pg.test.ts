import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * company_question_operations (migration 20261123135500): one row per
 * question and pending operation. Members read their own companies' rows and
 * write none; the service role writes; a pair is linked once; a row leaves
 * with its question, and with its operation.
 */

async function insertQuestion(companyId: string): Promise<string> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.company_questions (company_id, question, fingerprint)
       VALUES ($1, 'Is there a written agreement?', $2)
       RETURNING id`,
      [companyId, createHash('sha256').update(randomUUID()).digest('hex')],
    )
    return rows[0].id
  })
}

async function insertOperation(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
     VALUES ($1, $2, 'create_supplier', 'Create supplier', '{}')
     RETURNING id`,
    [userId, companyId],
  )
  return rows[0].id
}

async function link(companyId: string, questionId: string, operationId: string): Promise<string> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.company_question_operations (question_id, operation_id, company_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [questionId, operationId, companyId],
    )
    return rows[0].id
  })
}

describe('company_question_operations', () => {
  let userId: string
  let companyId: string
  let questionId: string
  let operationId: string

  beforeEach(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    questionId = await insertQuestion(companyId)
    operationId = await insertOperation(companyId, userId)
  })

  it('holds a link written by the service role, with when it was made', async () => {
    const id = await link(companyId, questionId, operationId)
    const { rows } = await getPool().query(
      `SELECT question_id, operation_id, company_id, created_at FROM public.company_question_operations WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toMatchObject({ question_id: questionId, operation_id: operationId, company_id: companyId })
    expect(rows[0].created_at).toBeInstanceOf(Date)
  })

  it('lets members read their own company\'s links only', async () => {
    const mine = await link(companyId, questionId, operationId)
    const other = await seedCompany()
    await link(other.companyId, await insertQuestion(other.companyId), await insertOperation(other.companyId, other.userId))
    await setActiveCompany(userId, companyId)

    const seen = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.company_question_operations`)
      return rows.map((row) => row.id)
    })
    expect(seen).toEqual([mine])
  })

  it('refuses every write from a member', async () => {
    const id = await link(companyId, questionId, operationId)
    const second = await insertOperation(companyId, userId)
    await setActiveCompany(userId, companyId)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`INSERT INTO public.company_question_operations (question_id, operation_id, company_id) VALUES ($1, $2, $3)`, [
          questionId,
          second,
          companyId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.company_question_operations SET operation_id = $2 WHERE id = $1`, [id, second]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) => client.query(`DELETE FROM public.company_question_operations WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('gives an anonymous caller nothing', async () => {
    await link(companyId, questionId, operationId)
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(`SELECT id FROM public.company_question_operations`)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('links a question and an operation once, and each of them to several of the other', async () => {
    await link(companyId, questionId, operationId)
    await expect(link(companyId, questionId, operationId)).rejects.toMatchObject({ code: '23505' })

    // The same question with another operation, and the same operation with another question.
    await expect(link(companyId, questionId, await insertOperation(companyId, userId))).resolves.toEqual(expect.any(String))
    await expect(link(companyId, await insertQuestion(companyId), operationId)).resolves.toEqual(expect.any(String))
  })

  it('needs a question, an operation and a company that exist', async () => {
    await expect(link(companyId, randomUUID(), operationId)).rejects.toMatchObject({ code: '23503' })
    await expect(link(companyId, questionId, randomUUID())).rejects.toMatchObject({ code: '23503' })
    await expect(link(randomUUID(), questionId, operationId)).rejects.toMatchObject({ code: '23503' })
  })

  it('leaves with its question, and with its operation', async () => {
    const second = await insertOperation(companyId, userId)
    await link(companyId, questionId, operationId)
    await link(companyId, questionId, second)
    const count = async () => {
      const { rows } = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.company_question_operations WHERE company_id = $1`,
        [companyId],
      )
      return rows[0].n
    }
    expect(await count()).toBe(2)

    // A pending operation may be deleted; its link goes with it.
    await getPool().query(`DELETE FROM public.pending_operations WHERE id = $1`, [second])
    expect(await count()).toBe(1)

    await getPool().query(`DELETE FROM public.company_questions WHERE id = $1`, [questionId])
    expect(await count()).toBe(0)
  })
})
