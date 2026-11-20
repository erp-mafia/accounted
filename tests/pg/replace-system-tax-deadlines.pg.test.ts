import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Migration 20261113020219: a company's pending system tax deadlines are
 * replaced in one transaction under a per-company lock.
 *
 * The generator used to insert the new set and then delete "every other
 * pending system row" in a second statement. Two regenerations that
 * overlapped (the nightly repair racing a settings save) each deleted the
 * other's fresh rows, leaving the company with part of a set or none.
 *
 * What is pinned here: replace_system_tax_deadlines inserts the generator's
 * rows as PostgREST's bulk insert did (the columns they carry, arrays and
 * json included), deletes exactly what the generator's delete did (pending,
 * not dismissed, system rows of the company inside the window, except the
 * new ones), leaves the old set alone when the insert fails, refuses rows
 * that are not this company's system rows, and makes two regenerations on
 * two real connections run one after the other, so the company ends with one
 * whole set.
 */

const FROM = '2026-11-12'
const TO = '2028-12-31'

/** A row as generateTaxDeadlinesForUser builds it (src/lib/tax/deadline-generator.ts). */
function generatorRow(
  companyId: string,
  type: string,
  period: string,
  dueDate: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    company_id: companyId,
    title: `${type} ${period}`,
    due_date: dueDate,
    due_time: null,
    deadline_type: 'tax',
    priority: 'important',
    is_completed: false,
    completed_at: null,
    source: 'system',
    status: 'upcoming',
    status_changed_at: '2026-11-12T08:00:00.000Z',
    notes: null,
    customer_id: null,
    tax_deadline_type: type,
    tax_period: period,
    linked_report_type: 'vat',
    linked_report_period: { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) },
    reminder_offsets: [14, 7, 1, 0],
    is_auto_generated: true,
    tax_assessment_notice_id: null,
    ...overrides,
  }
}

const REPLACE_SQL = `SELECT * FROM public.replace_system_tax_deadlines($1::uuid, $2::jsonb, $3::date, $4::date)`

function replace(
  runner: { query: PoolClient['query'] },
  companyId: string,
  rows: Array<Record<string, unknown>>,
  from = FROM,
  to = TO,
) {
  return runner.query<{ created: number; deleted: number }>(REPLACE_SQL, [companyId, JSON.stringify(rows), from, to])
}

/** A deadline that is already in the table before the replacement. */
async function insertExisting(
  companyId: string,
  values: {
    period: string
    dueDate: string
    source?: 'system' | 'user'
    isCompleted?: boolean
    dismissed?: boolean
    type?: string
  },
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.deadlines
       (company_id, title, due_date, deadline_type, source, is_auto_generated,
        is_completed, dismissed_at, tax_deadline_type, tax_period)
     VALUES ($1, 'Befintlig', $2, 'tax', $3, true, $4, $5, $6, $7)
     RETURNING id`,
    [
      companyId,
      values.dueDate,
      values.source ?? 'system',
      values.isCompleted ?? false,
      values.dismissed ? new Date() : null,
      values.type ?? 'moms_monthly',
      values.period,
    ],
  )
  return rows[0].id
}

/** The company's rows as type:period:due date, sorted: what the deadlines page shows. */
async function deadlineKeys(companyId: string, where = ''): Promise<string[]> {
  const { rows } = await getPool().query<{ key: string }>(
    `SELECT tax_deadline_type || ':' || tax_period || ':' || due_date::text AS key
       FROM public.deadlines
      WHERE company_id = $1 ${where}
      ORDER BY 1`,
    [companyId],
  )
  return rows.map((row) => row.key)
}

async function exists(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`SELECT 1 FROM public.deadlines WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0
}

/** Poll until the backend is parked on a heavyweight lock (an advisory lock is one). */
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

describe('replace_system_tax_deadlines: the new set in, the old pending set out', () => {
  it('inserts the generator rows with what they carry and deletes the other pending system rows in the window', async () => {
    const { companyId } = await seedCompany()
    const oldPending = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })
    const oldOtherType = await insertExisting(companyId, { period: '2026-11', dueDate: '2026-12-14', type: 'f_skatt' })

    const { rows } = await replace(getPool(), companyId, [
      generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14', { notes: 'Ring revisorn', status: 'in_progress' }),
      generatorRow(companyId, 'moms_monthly', '2026-11', '2027-01-12'),
    ])

    expect(rows).toEqual([{ created: 2, deleted: 2 }])
    expect(await exists(oldPending)).toBe(false)
    expect(await exists(oldOtherType)).toBe(false)
    expect(await deadlineKeys(companyId)).toEqual([
      'moms_monthly:2026-10:2026-12-14',
      'moms_monthly:2026-11:2027-01-12',
    ])
    const stored = await getPool().query(
      `SELECT title, source, status, notes, priority, is_auto_generated, is_completed,
              reminder_offsets, linked_report_type, linked_report_period, user_id
         FROM public.deadlines WHERE company_id = $1 AND tax_period = '2026-10'`,
      [companyId],
    )
    expect(stored.rows[0]).toEqual({
      title: 'moms_monthly 2026-10',
      source: 'system',
      status: 'in_progress',
      notes: 'Ring revisorn',
      priority: 'important',
      is_auto_generated: true,
      is_completed: false,
      reminder_offsets: [14, 7, 1, 0],
      linked_report_type: 'vat',
      linked_report_period: { year: 2026, month: 10 },
      user_id: null,
    })
  })

  it('keeps completed, dismissed and user rows, rows outside the window and other companies', async () => {
    const { companyId } = await seedCompany()
    const other = await seedCompany()
    const kept = [
      await insertExisting(companyId, { period: '2026-08', dueDate: '2026-12-01', isCompleted: true }),
      await insertExisting(companyId, { period: '2026-09', dueDate: '2026-12-02', dismissed: true }),
      await insertExisting(companyId, { period: '2026-07', dueDate: '2026-12-03', source: 'user' }),
      // A past-due pending row is before the window: never deleted.
      await insertExisting(companyId, { period: '2026-06', dueDate: '2026-11-11' }),
      await insertExisting(companyId, { period: '2029-01', dueDate: '2029-01-01' }),
      await insertExisting(other.companyId, { period: '2026-10', dueDate: '2026-12-12' }),
    ]
    const replaced = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })

    const { rows } = await replace(getPool(), companyId, [generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14')])

    expect(rows).toEqual([{ created: 1, deleted: 1 }])
    expect(await exists(replaced)).toBe(false)
    for (const id of kept) expect(await exists(id)).toBe(true)
  })

  it('an empty set removes the pending rows: the obligation no longer applies', async () => {
    const { companyId } = await seedCompany()
    await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })
    const filed = await insertExisting(companyId, { period: '2026-09', dueDate: '2026-12-01', isCompleted: true })

    const { rows } = await replace(getPool(), companyId, [])

    expect(rows).toEqual([{ created: 0, deleted: 1 }])
    expect(await exists(filed)).toBe(true)
    expect(await deadlineKeys(companyId, 'AND is_completed = false')).toEqual([])
  })

  it('a failed insert leaves the old set exactly as it was', async () => {
    const { companyId } = await seedCompany()
    const old = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })

    await expect(
      replace(getPool(), companyId, [
        generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14'),
        // Breaks the priority CHECK: the whole replacement is refused.
        generatorRow(companyId, 'moms_monthly', '2026-11', '2027-01-12', { priority: 'urgent' }),
      ]),
    ).rejects.toMatchObject({ code: '23514' })

    expect(await exists(old)).toBe(true)
    expect(await deadlineKeys(companyId)).toEqual(['moms_monthly:2026-10:2026-12-12'])
  })
})

describe('replace_system_tax_deadlines: what it refuses', () => {
  it('a row of another company, or one that is not a system row', async () => {
    const { companyId } = await seedCompany()
    const other = await seedCompany()
    const old = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })

    await expect(
      replace(getPool(), companyId, [generatorRow(other.companyId, 'moms_monthly', '2026-10', '2026-12-14')]),
    ).rejects.toMatchObject({ code: '22023' })
    await expect(
      replace(getPool(), companyId, [generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14', { source: 'user' })]),
    ).rejects.toMatchObject({ code: '22023' })

    expect(await exists(old)).toBe(true)
    expect(await deadlineKeys(other.companyId)).toEqual([])
  })

  it('a column the table does not have, loudly, with the old set intact', async () => {
    const { companyId } = await seedCompany()
    const old = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })

    await expect(
      replace(getPool(), companyId, [generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14', { no_such_column: 1 })]),
    ).rejects.toMatchObject({ code: '42703' })

    expect(await exists(old)).toBe(true)
  })
})

describe('replace_system_tax_deadlines: two regenerations of one company', () => {
  it('the second waits for the first and replaces its set whole: one complete set, neither deleting half of the other', async () => {
    const { companyId } = await seedCompany()
    await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })
    // The nightly repair, computed from the settings it read...
    const repairSet = [
      generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14'),
      generatorRow(companyId, 'moms_monthly', '2026-11', '2027-01-12'),
    ]
    // ...and a settings save that moved the company to quarterly moms.
    const saveSet = [
      generatorRow(companyId, 'moms_quarterly', '2026-Q4', '2027-02-12'),
      generatorRow(companyId, 'f_skatt', '2026-12', '2026-12-14'),
    ]
    const first = await getClient()
    const second = await getClient()
    try {
      await first.query('BEGIN')
      await replace(first, companyId, repairSet)

      const pid = await backendPid(second)
      const pending = replace(second, companyId, saveSet)
      await waitUntilBlockedOnLock(pid)
      await first.query('COMMIT')

      // It saw the first set once it could run, and removed all of it.
      expect((await pending).rows).toEqual([{ created: 2, deleted: 2 }])
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }

    expect(await deadlineKeys(companyId)).toEqual(['f_skatt:2026-12:2026-12-14', 'moms_quarterly:2026-Q4:2027-02-12'])
  })

  it('another company is not held up', async () => {
    const one = await seedCompany()
    const two = await seedCompany()
    const first = await getClient()
    try {
      await first.query('BEGIN')
      await replace(first, one.companyId, [generatorRow(one.companyId, 'moms_monthly', '2026-10', '2026-12-14')])

      // Resolves while the first transaction is still open.
      const { rows } = await replace(getPool(), two.companyId, [generatorRow(two.companyId, 'moms_monthly', '2026-10', '2026-12-14')])
      expect(rows).toEqual([{ created: 1, deleted: 0 }])

      await first.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      first.release()
    }
    expect(await deadlineKeys(one.companyId)).toEqual(['moms_monthly:2026-10:2026-12-14'])
    expect(await deadlineKeys(two.companyId)).toEqual(['moms_monthly:2026-10:2026-12-14'])
  })
})

describe('replace_system_tax_deadlines: under the caller rights', () => {
  it('a member of the company replaces its set (the settings save runs as the user)', async () => {
    const { companyId, userId } = await seedCompany()
    await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })

    // withUserContext rolls back, so the result is read inside it.
    const outcome = await withUserContext(userId, async (client) => {
      const { rows } = await replace(client, companyId, [generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14')])
      const after = await client.query<{ due_date: string }>(
        `SELECT due_date::text AS due_date FROM public.deadlines WHERE company_id = $1 ORDER BY 1`,
        [companyId],
      )
      return { answer: rows[0], dueDates: after.rows.map((row) => row.due_date) }
    })

    expect(outcome.answer).toEqual({ created: 1, deleted: 1 })
    expect(outcome.dueDates).toEqual(['2026-12-14'])
  })

  it('service_role, the nightly repair\'s caller, replaces the set', async () => {
    const { companyId } = await seedCompany()
    const old = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })

    // runAsServiceRole commits: the result is read afterwards over the pool.
    const { rows } = await runAsServiceRole((client) =>
      replace(client, companyId, [
        generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14'),
        generatorRow(companyId, 'moms_monthly', '2026-11', '2027-01-12'),
      ]),
    )

    expect(rows).toEqual([{ created: 2, deleted: 1 }])
    expect(await exists(old)).toBe(false)
    expect(await deadlineKeys(companyId)).toEqual(['moms_monthly:2026-10:2026-12-14', 'moms_monthly:2026-11:2027-01-12'])
  })

  it('someone outside the company writes nothing', async () => {
    const { companyId } = await seedCompany()
    const old = await insertExisting(companyId, { period: '2026-10', dueDate: '2026-12-12' })
    const stranger = await insertAuthUser()

    await expect(
      withUserContext(stranger, (client) =>
        replace(client, companyId, [generatorRow(companyId, 'moms_monthly', '2026-10', '2026-12-14')]),
      ),
    ).rejects.toThrow()

    expect(await exists(old)).toBe(true)
    expect(await deadlineKeys(companyId)).toEqual(['moms_monthly:2026-10:2026-12-12'])
  })
})
