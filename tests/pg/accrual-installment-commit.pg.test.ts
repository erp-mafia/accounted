import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Migration 20261113020117: a periodisering month reaches the books at most
 * once.
 *
 * Posting a month used to commit its verifikat and then flip the month
 * pending to posted in a second statement. A run killed in between left a
 * posted verifikat no month pointed at and booked the month again on the next
 * run; two overlapping runs (the cron and Bokför förfallna) both posted, and
 * the loser stornoed its own verifikat.
 *
 * What is pinned here: commit_accrual_installment posts the verifikat and
 * marks the month in one transaction, answers not_pending and writes nothing
 * for a month that is no longer waiting, lets exactly one of two runs racing
 * on two real connections post, draws no voucher number for the loser or for
 * a refused draft, and takes the voucher down with it when the month cannot
 * be marked.
 *
 * Migration 20261112181809 closes the same gap for "lös upp resten nu"
 * (dissolveScheduleNow), which posted one verifikat for every pending month
 * and flipped the months in a second statement: commit_accrual_dissolution
 * posts the verifikat, marks exactly the months its amount was added up from
 * and completes the schedule in one transaction, and answers not_pending,
 * writing nothing, when the pending months are no longer those. Pinned below
 * against the posting of a single month on two real connections, in both
 * orders, and for a run killed inside the transaction.
 *
 * Both functions are called here as the superuser pool, as a signed-in
 * member (authenticated) and as service_role, the daily cron's caller.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string; scheduleId: string }

/** A company with one active förutbetald kostnad schedule (1730 to 6310). */
async function seedSchedule(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Försäkrings AB')`,
    [supplierId, userId, companyId],
  )
  const supplierInvoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-01-15', '2026-02-14',
             12000, 3000, 15000)`,
    [supplierInvoiceId, userId, companyId, supplierId, `F-${supplierInvoiceId.slice(0, 8)}`],
  )
  const scheduleId = randomUUID()
  await getPool().query(
    `INSERT INTO public.accrual_schedules
       (id, user_id, company_id, direction, supplier_invoice_id,
        balance_account, target_account, total_amount,
        period_start, period_end, months)
     VALUES ($1, $2, $3, 'expense', $4, '1730', '6310', 12000,
             '2026-01-01', '2026-12-31', 12)`,
    [scheduleId, userId, companyId, supplierInvoiceId],
  )
  return { userId, companyId, fiscalPeriodId, scheduleId }
}

async function insertMonth(
  seed: Seed,
  options: { periodMonth?: string; status?: string; scheduleId?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.accrual_schedule_installments
       (id, user_id, company_id, schedule_id, period_month, amount, status)
     VALUES ($1, $2, $3, $4, $5, 1000, $6)`,
    [id, seed.userId, seed.companyId, options.scheduleId ?? seed.scheduleId, options.periodMonth ?? '2026-03-01', options.status ?? 'pending'],
  )
  return id
}

/** A balanced accrual draft, the shape postDueInstallments drafts for a month. */
async function insertMonthDraft(
  seed: Seed,
  options: { amount?: number; sourceType?: string; sourceId?: string | null } = {},
): Promise<string> {
  const entryId = randomUUID()
  const amount = options.amount ?? 1000
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, source_id, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', '2026-03-01',
               'Periodisering 2026-03: Försäkring', $5, $6, 'draft')`,
    [
      entryId,
      seed.userId,
      seed.companyId,
      seed.fiscalPeriodId,
      options.sourceType ?? 'accrual',
      options.sourceId === undefined ? seed.scheduleId : options.sourceId,
    ],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '6310', $2, 0), ($1, '1730', 0, $2)`,
    [entryId, amount],
  )
  return entryId
}

const COMMIT_SQL = `SELECT * FROM public.commit_accrual_installment(
  $1::uuid, $2::uuid, $3::uuid, NULL::text, NULL::text, NULL::text
)`

function commitMonth(runner: { query: PoolClient['query'] }, seed: Seed, monthId: string, entryId: string) {
  return runner.query<{ outcome: string; voucher_number: number | null }>(COMMIT_SQL, [seed.companyId, monthId, entryId])
}

async function monthState(monthId: string) {
  const { rows } = await getPool().query<{
    status: string
    journal_entry_id: string | null
    posted_at: Date | null
  }>(
    `SELECT status, journal_entry_id, posted_at FROM public.accrual_schedule_installments WHERE id = $1`,
    [monthId],
  )
  return rows[0] ?? null
}

async function entryState(entryId: string) {
  const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
    `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0] ?? null
}

/** The posted verifikat of the schedule: what the books carry for it. */
async function postedEntries(seed: Seed): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM public.journal_entries
      WHERE company_id = $1 AND source_type = 'accrual' AND source_id = $2 AND status = 'posted'`,
    [seed.companyId, seed.scheduleId],
  )
  return rows.map((row) => row.id)
}

const DISSOLVE_SQL = `SELECT * FROM public.commit_accrual_dissolution(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid[], NULL::text, NULL::text, NULL::text
)`

function dissolve(runner: { query: PoolClient['query'] }, seed: Seed, monthIds: string[], entryId: string) {
  return runner.query<{ outcome: string; voucher_number: number | null }>(DISSOLVE_SQL, [
    seed.companyId,
    seed.scheduleId,
    entryId,
    monthIds,
  ])
}

async function scheduleStatus(seed: Seed): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>(`SELECT status FROM public.accrual_schedules WHERE id = $1`, [
    seed.scheduleId,
  ])
  return rows[0]!.status
}

async function stornoCount(seed: Seed): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1 AND source_type = 'storno'`,
    [seed.companyId],
  )
  return rows[0]!.n
}

async function lastVoucherNumber(seed: Seed): Promise<number> {
  const { rows } = await getPool().query<{ last_number: number }>(
    `SELECT last_number FROM public.voucher_sequences
      WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
    [seed.companyId, seed.fiscalPeriodId],
  )
  return rows[0]?.last_number ?? 0
}

/** Poll until the backend is parked on a heavyweight lock: a deterministic
 *  "it is blocked" signal, where a sleep would only be a guess. */
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

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return rows[0].pid
}

describe('commit_accrual_installment: the verifikat and the month in one transaction', () => {
  it('posts the draft and marks the month posted, pointing at it', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)
    const before = await lastVoucherNumber(seed)

    const { rows } = await commitMonth(getPool(), seed, monthId, entryId)

    expect(rows).toEqual([{ outcome: 'posted', voucher_number: before + 1 }])
    expect(await entryState(entryId)).toEqual({ status: 'posted', voucher_number: before + 1 })
    const month = await monthState(monthId)
    expect(month).toMatchObject({ status: 'posted', journal_entry_id: entryId })
    expect(month?.posted_at).not.toBeNull()
  })

  it('a second run on the same month posts nothing: not_pending, its draft unnumbered', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const first = await insertMonthDraft(seed)
    await commitMonth(getPool(), seed, monthId, first)
    const after = await lastVoucherNumber(seed)

    // The rerun, or the run that came second: its own draft for the same month.
    const second = await insertMonthDraft(seed)
    const { rows } = await commitMonth(getPool(), seed, monthId, second)

    expect(rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    expect(await entryState(second)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastVoucherNumber(seed)).toBe(after)
    expect(await postedEntries(seed)).toEqual([first])
    expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: first })
  })

  it('a run killed between its draft and its commit leaves the month waiting, and the next run posts it once', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    // The killed run got as far as its draft: no number, and the month untouched.
    const abandoned = await insertMonthDraft(seed)
    expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    const before = await lastVoucherNumber(seed)

    const next = await insertMonthDraft(seed)
    const { rows } = await commitMonth(getPool(), seed, monthId, next)

    expect(rows[0]?.outcome).toBe('posted')
    expect(await postedEntries(seed)).toEqual([next])
    expect(await entryState(abandoned)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastVoucherNumber(seed)).toBe(before + 1)
  })

  it.each(['cancelled', 'posted'])('a month that is %s is not posted again', async (status) => {
    const seed = await seedSchedule()
    // A posted month needs its verifikat (accrual_installments_posted_consistent).
    const monthId = await insertMonth(seed)
    if (status === 'posted') {
      await commitMonth(getPool(), seed, monthId, await insertMonthDraft(seed))
    } else {
      await getPool().query(`UPDATE public.accrual_schedule_installments SET status = 'cancelled' WHERE id = $1`, [monthId])
    }
    const before = await lastVoucherNumber(seed)
    const entryId = await insertMonthDraft(seed)

    const { rows } = await commitMonth(getPool(), seed, monthId, entryId)

    expect(rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastVoucherNumber(seed)).toBe(before)
    expect((await monthState(monthId))?.status).toBe(status)
  })

  it('a month that no longer exists (re-planned away) is not_pending', async () => {
    const seed = await seedSchedule()
    const entryId = await insertMonthDraft(seed)

    const { rows } = await commitMonth(getPool(), seed, randomUUID(), entryId)

    expect(rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
  })
})

describe('commit_accrual_installment: what it refuses to post', () => {
  it.each([
    { name: 'a draft that is not an accrual', draft: { sourceType: 'manual' } },
    { name: 'a draft without a schedule', draft: { sourceId: null } },
    { name: 'a draft of another schedule', draft: { sourceId: randomUUID() } },
  ])('$name: refused, the month still waiting and no number drawn', async ({ draft }) => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed, draft)
    const before = await lastVoucherNumber(seed)

    await expect(commitMonth(getPool(), seed, monthId, entryId)).rejects.toMatchObject({ code: '22023' })

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await lastVoucherNumber(seed)).toBe(before)
  })

  it('a draft whose amount is not the month amount is refused', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed, { amount: 999 })

    await expect(commitMonth(getPool(), seed, monthId, entryId)).rejects.toMatchObject({ code: '23514' })

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
  })

  it('a month that cannot be marked takes the voucher down with it', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)
    const before = await lastVoucherNumber(seed)
    // Stands in for anything that keeps the row as it was (a policy, a
    // trigger): the old two-statement shape left the verifikat posted here.
    const fn = `pg_test_accrual_commit_${monthId.replace(/-/g, '')}`
    await getPool().query(`
      CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${monthId}'::uuid AND NEW.status = 'posted' THEN RETURN NULL; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER ${fn} BEFORE UPDATE ON public.accrual_schedule_installments
        FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
    try {
      await expect(commitMonth(getPool(), seed, monthId, entryId)).rejects.toMatchObject({ code: '23514' })
    } finally {
      await getPool().query(
        `DROP TRIGGER IF EXISTS ${fn} ON public.accrual_schedule_installments; DROP FUNCTION IF EXISTS public.${fn}();`,
      )
    }

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await lastVoucherNumber(seed)).toBe(before)
    expect(await postedEntries(seed)).toEqual([])
  })
})

describe('commit_accrual_installment: two runs on the same month', () => {
  it('the second waits for the first and then posts nothing: one verifikat, one number, no reversal', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const firstDraft = await insertMonthDraft(seed)
    const secondDraft = await insertMonthDraft(seed)
    const before = await lastVoucherNumber(seed)
    const first = await getClient()
    const second = await getClient()
    try {
      await first.query('BEGIN')
      const won = await commitMonth(first, seed, monthId, firstDraft)
      expect(won.rows[0]?.outcome).toBe('posted')

      const pid = await backendPid(second)
      const pending = commitMonth(second, seed, monthId, secondDraft)
      await waitUntilBlockedOnLock(pid)
      await first.query('COMMIT')

      expect((await pending).rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }

    expect(await postedEntries(seed)).toEqual([firstDraft])
    expect(await entryState(secondDraft)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastVoucherNumber(seed)).toBe(before + 1)
    expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: firstDraft })
    // Nothing was stornoed to get here.
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1 AND source_type = 'storno'`,
      [seed.companyId],
    )
    expect(rows[0]?.n).toBe(0)
  })

  it('a first run that fails releases the month to the second', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const firstDraft = await insertMonthDraft(seed)
    const secondDraft = await insertMonthDraft(seed)
    const first = await getClient()
    const second = await getClient()
    try {
      await first.query('BEGIN')
      await commitMonth(first, seed, monthId, firstDraft)

      const pid = await backendPid(second)
      const pending = commitMonth(second, seed, monthId, secondDraft)
      await waitUntilBlockedOnLock(pid)
      // The first run dies before its transaction commits: nothing of it stays.
      await first.query('ROLLBACK')

      expect((await pending).rows[0]?.outcome).toBe('posted')
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }

    expect(await postedEntries(seed)).toEqual([secondDraft])
    expect(await entryState(firstDraft)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: secondDraft })
  })
})

describe('commit_accrual_installment: who may call it', () => {
  it('a member who keeps the books posts the month under their own rights', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)

    // withUserContext rolls back, so the answer is read inside it.
    const outcome = await withUserContext(seed.userId, async (client) => {
      const { rows } = await commitMonth(client, seed, monthId, entryId)
      const month = await client.query<{ status: string; journal_entry_id: string | null }>(
        `SELECT status, journal_entry_id FROM public.accrual_schedule_installments WHERE id = $1`,
        [monthId],
      )
      return { answer: rows[0], month: month.rows[0] }
    })

    expect(outcome.answer?.outcome).toBe('posted')
    expect(outcome.month).toEqual({ status: 'posted', journal_entry_id: entryId })
  })

  it('someone outside the company is refused and nothing is posted', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)
    const stranger = await insertAuthUser()

    await expect(
      withUserContext(stranger, (client) => commitMonth(client, seed, monthId, entryId)),
    ).rejects.toMatchObject({ code: '42501' })

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
  })

  it('service_role, the daily cron\'s caller, posts the month', async () => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)
    const before = await lastVoucherNumber(seed)

    const { rows } = await runAsServiceRole((client) => commitMonth(client, seed, monthId, entryId))

    expect(rows).toEqual([{ outcome: 'posted', voucher_number: before + 1 }])
    expect(await entryState(entryId)).toEqual({ status: 'posted', voucher_number: before + 1 })
    expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: entryId })
  })
})

describe('commit_accrual_dissolution: the rest of a schedule in one verifikat and one transaction', () => {
  it('posts the draft, marks exactly the pending months and completes the schedule', async () => {
    const seed = await seedSchedule()
    const earlier = await insertMonth(seed, { periodMonth: '2026-01-01' })
    await commitMonth(getPool(), seed, earlier, await insertMonthDraft(seed))
    const rest = [await insertMonth(seed, { periodMonth: '2026-02-01' }), await insertMonth(seed, { periodMonth: '2026-03-01' })]
    const entryId = await insertMonthDraft(seed, { amount: 2000 })
    const before = await lastVoucherNumber(seed)

    const { rows } = await dissolve(getPool(), seed, rest, entryId)

    expect(rows).toEqual([{ outcome: 'posted', voucher_number: before + 1 }])
    expect(await entryState(entryId)).toEqual({ status: 'posted', voucher_number: before + 1 })
    for (const monthId of rest) expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: entryId })
    // The month posted before keeps its own verifikat.
    expect((await monthState(earlier))?.journal_entry_id).not.toBe(entryId)
    expect(await scheduleStatus(seed)).toBe('completed')
  })

  it.each([
    { name: 'a month posted since the read', change: 'posted' },
    { name: 'a month added since the read (a re-plan)', change: 'added' },
  ])('$name: not_pending, nothing written, no number drawn', async ({ change }) => {
    const seed = await seedSchedule()
    const a = await insertMonth(seed, { periodMonth: '2026-02-01' })
    const b = await insertMonth(seed, { periodMonth: '2026-03-01' })
    if (change === 'posted') await commitMonth(getPool(), seed, a, await insertMonthDraft(seed))
    else await insertMonth(seed, { periodMonth: '2026-04-01' })
    const entryId = await insertMonthDraft(seed, { amount: 2000 })
    const before = await lastVoucherNumber(seed)

    const { rows } = await dissolve(getPool(), seed, [a, b], entryId)

    expect(rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(b)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await scheduleStatus(seed)).toBe('active')
    expect(await lastVoucherNumber(seed)).toBe(before)
  })

  it.each(['cancelled', 'completed'])('a schedule that is %s: not_pending, nothing written', async (status) => {
    const seed = await seedSchedule()
    const a = await insertMonth(seed, { periodMonth: '2026-02-01' })
    await getPool().query(`UPDATE public.accrual_schedules SET status = $2 WHERE id = $1`, [seed.scheduleId, status])
    const entryId = await insertMonthDraft(seed)

    const { rows } = await dissolve(getPool(), seed, [a], entryId)

    expect(rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(a)).toMatchObject({ status: 'pending', journal_entry_id: null })
  })

  it.each([
    { name: 'a draft that is not an accrual', draft: { sourceType: 'manual', amount: 2000 }, code: '22023' },
    { name: 'a draft of another schedule', draft: { sourceId: randomUUID(), amount: 2000 }, code: '22023' },
    { name: 'a draft whose amount is not the months\' sum', draft: { amount: 1000 }, code: '23514' },
  ])('$name: refused, every month still waiting and no number drawn', async ({ draft, code }) => {
    const seed = await seedSchedule()
    const months = [await insertMonth(seed, { periodMonth: '2026-02-01' }), await insertMonth(seed, { periodMonth: '2026-03-01' })]
    const entryId = await insertMonthDraft(seed, draft)
    const before = await lastVoucherNumber(seed)

    await expect(dissolve(getPool(), seed, months, entryId)).rejects.toMatchObject({ code })

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    for (const monthId of months) expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await scheduleStatus(seed)).toBe('active')
    expect(await lastVoucherNumber(seed)).toBe(before)
  })

  it('a month that cannot be marked takes the voucher and the other months down with it', async () => {
    const seed = await seedSchedule()
    const kept = await insertMonth(seed, { periodMonth: '2026-02-01' })
    const stuck = await insertMonth(seed, { periodMonth: '2026-03-01' })
    const entryId = await insertMonthDraft(seed, { amount: 2000 })
    const before = await lastVoucherNumber(seed)
    const fn = `pg_test_accrual_dissolve_${stuck.replace(/-/g, '')}`
    await getPool().query(`
      CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${stuck}'::uuid AND NEW.status = 'posted' THEN RETURN NULL; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER ${fn} BEFORE UPDATE ON public.accrual_schedule_installments
        FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
    try {
      await expect(dissolve(getPool(), seed, [kept, stuck], entryId)).rejects.toMatchObject({ code: '23514' })
    } finally {
      await getPool().query(
        `DROP TRIGGER IF EXISTS ${fn} ON public.accrual_schedule_installments; DROP FUNCTION IF EXISTS public.${fn}();`,
      )
    }

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    for (const monthId of [kept, stuck]) expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await scheduleStatus(seed)).toBe('active')
    expect(await lastVoucherNumber(seed)).toBe(before)
  })

  it('a run killed inside the transaction leaves every month waiting, and the next run posts each once', async () => {
    const seed = await seedSchedule()
    const months = [await insertMonth(seed, { periodMonth: '2026-02-01' }), await insertMonth(seed, { periodMonth: '2026-03-01' })]
    const entryId = await insertMonthDraft(seed, { amount: 2000 })
    const before = await lastVoucherNumber(seed)
    const killed = await getClient()
    try {
      await killed.query('BEGIN')
      expect((await dissolve(killed, seed, months, entryId)).rows[0]?.outcome).toBe('posted')
      // The function never returns to the application: nothing of it stays.
      await killed.query('ROLLBACK')
    } finally {
      killed.release()
    }
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    for (const monthId of months) expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await lastVoucherNumber(seed)).toBe(before)

    // The next posting run books the months one by one, each once.
    for (const monthId of months) {
      expect((await commitMonth(getPool(), seed, monthId, await insertMonthDraft(seed))).rows[0]?.outcome).toBe('posted')
    }
    expect(await postedEntries(seed)).toHaveLength(2)
    expect(await lastVoucherNumber(seed)).toBe(before + 2)
    expect(await stornoCount(seed)).toBe(0)
  })

  it('a signed-in member and service_role both post it; someone outside the company is refused', async () => {
    const member = await seedSchedule()
    const memberMonth = await insertMonth(member, { periodMonth: '2026-02-01' })
    const memberDraft = await insertMonthDraft(member)
    const asMember = await withUserContext(member.userId, async (client) => {
      const { rows } = await dissolve(client, member, [memberMonth], memberDraft)
      const status = await client.query<{ status: string }>(`SELECT status FROM public.accrual_schedules WHERE id = $1`, [
        member.scheduleId,
      ])
      return { answer: rows[0], status: status.rows[0]?.status }
    })
    expect(asMember).toEqual({ answer: expect.objectContaining({ outcome: 'posted' }), status: 'completed' })

    const cron = await seedSchedule()
    const cronMonth = await insertMonth(cron, { periodMonth: '2026-02-01' })
    const cronDraft = await insertMonthDraft(cron)
    const { rows } = await runAsServiceRole((client) => dissolve(client, cron, [cronMonth], cronDraft))
    expect(rows[0]?.outcome).toBe('posted')
    expect(await monthState(cronMonth)).toMatchObject({ status: 'posted', journal_entry_id: cronDraft })
    expect(await scheduleStatus(cron)).toBe('completed')

    const other = await seedSchedule()
    const otherMonth = await insertMonth(other, { periodMonth: '2026-02-01' })
    const otherDraft = await insertMonthDraft(other)
    const stranger = await insertAuthUser()
    await expect(
      withUserContext(stranger, (client) => dissolve(client, other, [otherMonth], otherDraft)),
    ).rejects.toMatchObject({ code: '42501' })
    expect(await entryState(otherDraft)).toEqual({ status: 'draft', voucher_number: 0 })
  })
})

describe('commit_accrual_dissolution racing the posting of a single month', () => {
  it('the month first: the dissolution waits, then posts nothing; the next try posts the rest, every month once, no storno', async () => {
    const seed = await seedSchedule()
    const [a, b] = [await insertMonth(seed, { periodMonth: '2026-02-01' }), await insertMonth(seed, { periodMonth: '2026-03-01' })]
    const monthDraft = await insertMonthDraft(seed)
    const restDraft = await insertMonthDraft(seed, { amount: 2000 })
    const before = await lastVoucherNumber(seed)
    const cron = await getClient()
    const person = await getClient()
    try {
      await cron.query('BEGIN')
      expect((await commitMonth(cron, seed, a, monthDraft)).rows[0]?.outcome).toBe('posted')

      const pid = await backendPid(person)
      const pending = dissolve(person, seed, [a, b], restDraft)
      await waitUntilBlockedOnLock(pid)
      await cron.query('COMMIT')

      expect((await pending).rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    } finally {
      await cron.query('ROLLBACK').catch(() => {})
      cron.release()
      person.release()
    }
    // No month points at a verifikat that had to be stornoed.
    expect(await monthState(a)).toMatchObject({ status: 'posted', journal_entry_id: monthDraft })
    expect(await monthState(b)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await entryState(restDraft)).toEqual({ status: 'draft', voucher_number: 0 })

    // The person tries again from what is pending now.
    const retry = await insertMonthDraft(seed, { amount: 1000 })
    expect((await dissolve(getPool(), seed, [b], retry)).rows[0]?.outcome).toBe('posted')
    expect(await monthState(b)).toMatchObject({ status: 'posted', journal_entry_id: retry })
    expect(await lastVoucherNumber(seed)).toBe(before + 2)
    expect(await stornoCount(seed)).toBe(0)
    expect(await scheduleStatus(seed)).toBe('completed')
  })

  it('the dissolution first: the month waits, then posts nothing; one verifikat for both months, no storno', async () => {
    const seed = await seedSchedule()
    const [a, b] = [await insertMonth(seed, { periodMonth: '2026-02-01' }), await insertMonth(seed, { periodMonth: '2026-03-01' })]
    const restDraft = await insertMonthDraft(seed, { amount: 2000 })
    const monthDraft = await insertMonthDraft(seed)
    const before = await lastVoucherNumber(seed)
    const person = await getClient()
    const cron = await getClient()
    try {
      await person.query('BEGIN')
      expect((await dissolve(person, seed, [a, b], restDraft)).rows[0]?.outcome).toBe('posted')

      const pid = await backendPid(cron)
      const pending = commitMonth(cron, seed, a, monthDraft)
      await waitUntilBlockedOnLock(pid)
      await person.query('COMMIT')

      expect((await pending).rows).toEqual([{ outcome: 'not_pending', voucher_number: null }])
    } finally {
      await person.query('ROLLBACK').catch(() => {})
      person.release()
      cron.release()
    }
    for (const monthId of [a, b]) expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: restDraft })
    expect(await entryState(monthDraft)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await postedEntries(seed)).toEqual([restDraft])
    expect(await lastVoucherNumber(seed)).toBe(before + 1)
    expect(await stornoCount(seed)).toBe(0)
  })
})

describe('the draft and its lines are locked from the check to the commit', () => {
  // The header lock is not shown separately: commit_journal_entry takes the
  // same lock later in the transaction, so a new line (its foreign key locks
  // the header) waits either way. Without the lines lock a line edit was
  // refused as well, but at once and as busy: cash_history_journal_line_lock
  // (20260922102109) asks for the company lock the posting holds with
  // NOWAIT, so the editor got PT409. With it the edit waits on the line for
  // the posting, then meets the posted verifikat's refusal; the wait is what
  // waitUntilBlockedOnLock tells apart.
  it.each(['commit_accrual_installment', 'commit_accrual_dissolution'])(
    '%s: an edit of a line waits for the posting, then meets a posted verifikat',
    async (fn) => {
      const seed = await seedSchedule()
      const monthId = await insertMonth(seed)
      const entryId = await insertMonthDraft(seed)
      const poster = await getClient()
      const editor = await getClient()
      try {
        await poster.query('BEGIN')
        const posted =
          fn === 'commit_accrual_installment'
            ? await commitMonth(poster, seed, monthId, entryId)
            : await dissolve(poster, seed, [monthId], entryId)
        expect(posted.rows[0]?.outcome).toBe('posted')

        const pid = await backendPid(editor)
        const edit = editor.query(
          `UPDATE public.journal_entry_lines SET debit_amount = debit_amount + 1
            WHERE journal_entry_id = $1 AND debit_amount > 0`,
          [entryId],
        )
        const refused = expect(edit).rejects.toThrow()
        await waitUntilBlockedOnLock(pid)
        await poster.query('COMMIT')
        await refused
      } finally {
        await poster.query('ROLLBACK').catch(() => {})
        poster.release()
        editor.release()
      }
      // Posted with the amount its month records.
      const { rows } = await getPool().query<{ debit: string }>(
        `SELECT sum(debit_amount)::text AS debit FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
        [entryId],
      )
      expect(Number(rows[0]!.debit)).toBe(1000)
      expect(await monthState(monthId)).toMatchObject({ status: 'posted', journal_entry_id: entryId })
    },
  )
})

describe('a member who keeps the books may post; a reader may not', () => {
  it.each([
    { fn: 'commit_accrual_installment', role: 'member' as const },
    { fn: 'commit_accrual_dissolution', role: 'member' as const },
  ])('$fn: a $role posts the month', async ({ fn, role }) => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)
    const writer = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: writer, role })

    // withUserContext rolls back, so the answer is read inside it.
    const outcome = await withUserContext(writer, async (client) => {
      const { rows } =
        fn === 'commit_accrual_installment'
          ? await commitMonth(client, seed, monthId, entryId)
          : await dissolve(client, seed, [monthId], entryId)
      const month = await client.query<{ status: string }>(
        `SELECT status FROM public.accrual_schedule_installments WHERE id = $1`,
        [monthId],
      )
      return { answer: rows[0]?.outcome, month: month.rows[0]?.status }
    })

    expect(outcome).toEqual({ answer: 'posted', month: 'posted' })
  })

  it.each([
    { fn: 'commit_accrual_installment', role: 'viewer' as const },
    { fn: 'commit_accrual_dissolution', role: 'viewer' as const },
  ])('$fn: a $role is refused and nothing is posted', async ({ fn, role }) => {
    const seed = await seedSchedule()
    const monthId = await insertMonth(seed)
    const entryId = await insertMonthDraft(seed)
    const reader = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: reader, role })
    const before = await lastVoucherNumber(seed)

    await expect(
      withUserContext(reader, (client) =>
        fn === 'commit_accrual_installment'
          ? commitMonth(client, seed, monthId, entryId)
          : dissolve(client, seed, [monthId], entryId),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await monthState(monthId)).toMatchObject({ status: 'pending', journal_entry_id: null })
    expect(await lastVoucherNumber(seed)).toBe(before)
  })
})
