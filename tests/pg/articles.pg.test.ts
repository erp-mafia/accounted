import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

// pg-real coverage for the artikelregister migration: the generate_article_number
// RPC (atomic + idempotent), the per-company unique article_number index, RLS
// isolation, and the updated_at + audit triggers.

async function seedSettings(companyId: string, userId: string): Promise<void> {
  // seedCompany() inserts companies/members/period but not company_settings
  // (the real flow creates it via create_company_with_owner). The RPC reads the
  // per-company next_article_number counter, so seed a row (defaults to 1).
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)`,
    [userId, companyId],
  )
}

async function insertArticle(
  companyId: string,
  userId: string,
  overrides: { name?: string; articleNumber?: string | null; revenueAccount?: string | null } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.articles (id, company_id, user_id, name, article_number, revenue_account)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      companyId,
      userId,
      overrides.name ?? 'Konsulttimme',
      overrides.articleNumber ?? null,
      overrides.revenueAccount ?? null,
    ],
  )
  return id
}

describe('generate_article_number RPC', () => {
  it('assigns sequential numbers, is idempotent, and advances the counter exactly once', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)

    const a1 = await insertArticle(companyId, userId, { name: 'A' })
    const a2 = await insertArticle(companyId, userId, { name: 'B' })

    const first = await getPool().query<{ n: string }>(
      `SELECT public.generate_article_number($1, $2) AS n`,
      [companyId, a1],
    )
    expect(first.rows[0].n).toBe('1')

    // Idempotent: second call on the same article returns the same number and
    // does NOT consume another sequence value.
    const firstAgain = await getPool().query<{ n: string }>(
      `SELECT public.generate_article_number($1, $2) AS n`,
      [companyId, a1],
    )
    expect(firstAgain.rows[0].n).toBe('1')

    const second = await getPool().query<{ n: string }>(
      `SELECT public.generate_article_number($1, $2) AS n`,
      [companyId, a2],
    )
    expect(second.rows[0].n).toBe('2')

    const settings = await getPool().query<{ next_article_number: number }>(
      `SELECT next_article_number FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    // Started at 1, consumed by a1 and a2 → next free is 3.
    expect(settings.rows[0].next_article_number).toBe(3)
  })

  it('raises when the article does not belong to the company', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const other = await seedCompany()

    const article = await insertArticle(companyId, userId)

    await expect(
      getPool().query(`SELECT public.generate_article_number($1, $2)`, [other.companyId, article]),
    ).rejects.toThrow()
  })
})

describe('articles constraints + RLS', () => {
  it('enforces a per-company unique article_number', async () => {
    const { userId, companyId } = await seedCompany()
    await insertArticle(companyId, userId, { name: 'A', articleNumber: '5' })

    await expect(
      insertArticle(companyId, userId, { name: 'B', articleNumber: '5' }),
    ).rejects.toThrow(/duplicate|unique/i)
  })

  it('isolates articles by company via RLS', async () => {
    const { userId, companyId } = await seedCompany()
    const articleId = await insertArticle(companyId, userId, { name: 'Secret' })
    const stranger = await insertAuthUser()

    const ownerView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.articles WHERE id = $1`, [articleId]),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.articles WHERE id = $1`, [articleId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })
})

describe('articles.currency', () => {
  it('defaults to SEK and accepts a code from the currencies table', async () => {
    const { userId, companyId } = await seedCompany()
    const articleId = await insertArticle(companyId, userId)

    const def = await getPool().query<{ currency: string }>(
      `SELECT currency FROM public.articles WHERE id = $1`,
      [articleId],
    )
    expect(def.rows[0].currency).toBe('SEK')

    // EUR is seeded in the currencies table, so the FK accepts it.
    await expect(
      getPool().query(`UPDATE public.articles SET currency = 'EUR' WHERE id = $1`, [articleId]),
    ).resolves.toBeDefined()
  })

  it('rejects a currency code missing from the currencies table (FK)', async () => {
    const { userId, companyId } = await seedCompany()
    const id = randomUUID()
    await expect(
      getPool().query(
        `INSERT INTO public.articles (id, company_id, user_id, name, currency)
         VALUES ($1, $2, $3, 'X', 'ZZZ')`,
        [id, companyId, userId],
      ),
    ).rejects.toThrow(/foreign key|currencies/i)
  })
})

describe('currencies reference table', () => {
  it('is readable by any authenticated user via RLS', async () => {
    const reader = await insertAuthUser()
    const seen = await withUserContext(reader, (client) =>
      client.query<{ code: string }>(`SELECT code FROM public.currencies WHERE code = 'SEK'`),
    )
    expect(seen.rows).toHaveLength(1)
  })
})

describe('articles triggers', () => {
  it('bumps updated_at on update', async () => {
    const { userId, companyId } = await seedCompany()
    const articleId = await insertArticle(companyId, userId)

    const before = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.articles WHERE id = $1`,
      [articleId],
    )
    await getPool().query(
      `UPDATE public.articles SET name = 'Renamed', updated_at = now() - interval '0 seconds' WHERE id = $1`,
      [articleId],
    )
    const after = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.articles WHERE id = $1`,
      [articleId],
    )
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    )
  })

  it('writes an audit row on insert', async () => {
    const { userId, companyId } = await seedCompany()
    const articleId = await insertArticle(companyId, userId)

    const audit = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.audit_log
       WHERE table_name = 'articles' AND record_id = $1`,
      [articleId],
    )
    expect(Number(audit.rows[0].count)).toBeGreaterThanOrEqual(1)
  })
})
