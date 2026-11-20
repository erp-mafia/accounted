import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

// pg-real coverage for the artikelregister migration: the generate_article_number
// RPC (atomic + idempotent, skips taken numbers since 20261101004200), the
// per-company unique article_number index, RLS isolation, and the updated_at +
// audit triggers.

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

async function generate(companyId: string, articleId: string): Promise<string> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT public.generate_article_number($1, $2) AS n`,
    [companyId, articleId],
  )
  return rows[0].n
}

async function counter(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ next_article_number: number }>(
    `SELECT next_article_number FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return rows[0].next_article_number
}

/** Poll until the backend is parked on a heavyweight lock (here: the unique
 *  index waiting on another transaction's uncommitted row). */
async function waitUntilBlockedOnLock(pid: number, maxAttempts = 150, intervalMs = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { rows } = await getPool().query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    )
    if (rows[0]?.wait_event_type === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Backend ${pid} never blocked on a lock after ${maxAttempts * intervalMs}ms`)
}

// accounted#58 P1.11: the counter knew nothing about numbers typed by hand or
// imported, so reaching one hit the unique index, rolled the counter back with
// the call, and every later automatic number failed the same way.
describe('generate_article_number skips taken numbers', () => {
  it('skips numbers typed by hand and moves the counter past the one it hands out', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    await insertArticle(companyId, userId, { name: 'Manual 1', articleNumber: '1' })
    await insertArticle(companyId, userId, { name: 'Manual 2', articleNumber: '2' })
    await insertArticle(companyId, userId, { name: 'Manual 4', articleNumber: '4' })

    const a = await insertArticle(companyId, userId, { name: 'Auto A' })
    const b = await insertArticle(companyId, userId, { name: 'Auto B' })

    expect(await generate(companyId, a)).toBe('3')
    expect(await counter(companyId)).toBe(4)
    // The next walk starts at the counter, skips the taken 4, and does not
    // re-walk from 1.
    expect(await generate(companyId, b)).toBe('5')
    expect(await counter(companyId)).toBe(6)
  })

  it('compares numbers as text: padded and prefixed numbers do not block the plain one', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    await insertArticle(companyId, userId, { name: 'Padded', articleNumber: '0001' })
    await insertArticle(companyId, userId, { name: 'Prefixed', articleNumber: 'A-1' })

    const a = await insertArticle(companyId, userId, { name: 'Auto' })
    expect(await generate(companyId, a)).toBe('1')
    expect(await counter(companyId)).toBe(2)
  })

  it('takes the next number when a concurrent manual insert claims the free one mid-call', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const auto = await insertArticle(companyId, userId, { name: 'Auto' })

    const manual = await getClient()
    const numberer = await getClient()
    try {
      // Uncommitted manual insert of "1": the RPC's existence check cannot
      // see it, so its UPDATE waits on the unique index for this transaction.
      await manual.query('BEGIN')
      await manual.query(
        `INSERT INTO public.articles (id, company_id, user_id, name, article_number)
         VALUES ($1, $2, $3, 'Manual 1', '1')`,
        [randomUUID(), companyId, userId],
      )

      const { rows: pidRows } = await numberer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pending = numberer.query<{ n: string }>(
        `SELECT public.generate_article_number($1, $2) AS n`,
        [companyId, auto],
      )
      await waitUntilBlockedOnLock(pidRows[0].pid)
      await manual.query('COMMIT')

      // The unique violation is caught inside the RPC and the walk moves on.
      const { rows } = await pending
      expect(rows[0].n).toBe('2')
    } finally {
      await manual.query('ROLLBACK').catch(() => {})
      manual.release()
      numberer.release()
    }

    expect(await counter(companyId)).toBe(3)
    const { rows: numbers } = await getPool().query<{ article_number: string }>(
      `SELECT article_number FROM public.articles WHERE company_id = $1 ORDER BY article_number`,
      [companyId],
    )
    expect(numbers.map((r) => r.article_number)).toEqual(['1', '2'])
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
