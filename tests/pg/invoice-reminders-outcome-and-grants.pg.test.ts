import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

/**
 * Invoice reminders before the switch-on (migration
 * 20261027150000_invoice_reminders_outcome_and_grants.sql): a failed row says
 * whether its outcome is unknown, a reservation is stamped, a send that never
 * finished is swept to failed with an unknown outcome, the daily run reads
 * only the companies and invoices it may remind, and no member writes the
 * ledger directly.
 */

interface Seed {
  companyId: string
  userId: string
}

async function seedInvoice(
  seed: Seed,
  dates: { invoiceDate?: string; dueDate?: string; status?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, invoice_number, invoice_date, due_date, total, status, creation_complete)
     VALUES ($1, $2, $3, $4, $5, $6, 1250, $7, true)`,
    [id, seed.userId, seed.companyId, `F-${id.slice(0, 8)}`, dates.invoiceDate ?? '2026-11-02', dates.dueDate ?? '2026-12-02', dates.status ?? 'sent'],
  )
  return id
}

/** A reminder row as the superuser writes it (the seeding connection bypasses grants and RLS). */
async function insertReminder(
  seed: Seed,
  invoiceId: string,
  row: { level?: number; status?: string; reservedAgo?: string; sentAt?: boolean } = {},
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, mode, status, sent_at, reserved_at)
     VALUES ($1, $2, $3, $4, 'kund@example.se', 'approved', $5, CASE WHEN $6 THEN now() END, now() - $7::interval)
     RETURNING id`,
    [invoiceId, seed.userId, seed.companyId, row.level ?? 1, row.status ?? 'reserved', row.sentAt === true, row.reservedAgo ?? '0 minutes'],
  )
  return rows[0]!.id
}

async function reminderRow(id: string) {
  const { rows } = await getPool().query<{
    status: string
    outcome_unknown: boolean | null
    error_code: string | null
    failed_at: Date | null
  }>(`SELECT status, outcome_unknown, error_code, failed_at FROM public.invoice_reminders WHERE id = $1`, [id])
  return rows[0]!
}

async function insertSettings(seed: Seed, values: { on?: boolean; sandbox?: boolean } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, send_invoice_reminders, is_sandbox) VALUES ($1, $2, $3, $4)`,
    [seed.userId, seed.companyId, values.on ?? true, values.sandbox ?? false],
  )
}

/** Make the company the archived source of a migration reset (do it last: its rows go immutable). */
async function markResetSource(seed: Seed): Promise<void> {
  const replacement = await insertCompany({ createdBy: seed.userId })
  await getPool().query(
    `INSERT INTO public.company_migration_resets (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
     VALUES ($1, $2, 'owner confirmed archive and replace for the test', '{}', '{}')`,
    [seed.companyId, replacement],
  )
}

describe('invoice_reminders.outcome_unknown and reserved_at (pg)', () => {
  it('stamps a new reservation, and keeps the outcome on failed rows alone', async () => {
    const seed = await seedCompany()
    const invoiceId = await seedInvoice(seed)
    const { rows } = await getPool().query<{ id: string; reserved_at: Date | null; outcome_unknown: boolean | null }>(
      `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, mode)
       VALUES ($1, $2, $3, 1, 'kund@example.se', 'approved') RETURNING id, reserved_at, outcome_unknown`,
      [invoiceId, seed.userId, seed.companyId],
    )
    const id = rows[0]!.id
    expect(rows[0]!.reserved_at).toBeInstanceOf(Date)
    expect(rows[0]!.outcome_unknown).toBeNull()

    await expect(getPool().query(`UPDATE public.invoice_reminders SET outcome_unknown = true WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
    })
    await expect(
      getPool().query(`UPDATE public.invoice_reminders SET status = 'failed', failed_at = now(), outcome_unknown = false WHERE id = $1`, [id]),
    ).resolves.toMatchObject({ rowCount: 1 })

    // A refused row is taken back for the next attempt, on the same row.
    const taken = await getPool().query(
      `UPDATE public.invoice_reminders
          SET status = 'reserved', reserved_at = now(), failed_at = NULL, error_code = NULL, outcome_unknown = NULL
        WHERE id = $1 AND status = 'failed' AND outcome_unknown = false`,
      [id],
    )
    expect(taken.rowCount).toBe(1)
    expect(await reminderRow(id)).toMatchObject({ status: 'reserved', outcome_unknown: null })
  })
})

describe('sweep_interrupted_invoice_reminders (pg)', () => {
  it('marks a reservation older than the cutoff failed with an unknown outcome, and nothing else', async () => {
    const seed = await seedCompany()
    const stuck = await insertReminder(seed, await seedInvoice(seed), { reservedAgo: '20 minutes' })
    const running = await insertReminder(seed, await seedInvoice(seed), { reservedAgo: '1 minute' })
    const sent = await insertReminder(seed, await seedInvoice(seed), { status: 'sent', sentAt: true, reservedAgo: '2 hours' })

    // An archived migration-reset source keeps its rows exactly as they are.
    const source = await seedCompany()
    const sourceStuck = await insertReminder(source, await seedInvoice(source), { reservedAgo: '20 minutes' })
    await markResetSource(source)

    const swept = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ company_id: string; swept: number }>(
        `SELECT * FROM public.sweep_interrupted_invoice_reminders(now() - interval '15 minutes')`,
      )
      return rows
    })

    expect(swept).toContainEqual({ company_id: seed.companyId, swept: 1 })
    expect(swept.find((r) => r.company_id === source.companyId)).toBeUndefined()
    expect(await reminderRow(stuck)).toMatchObject({ status: 'failed', outcome_unknown: true, error_code: 'SEND_INTERRUPTED' })
    expect((await reminderRow(stuck)).failed_at).toBeInstanceOf(Date)
    expect(await reminderRow(running)).toMatchObject({ status: 'reserved', outcome_unknown: null })
    expect(await reminderRow(sent)).toMatchObject({ status: 'sent', outcome_unknown: null })
    expect(await reminderRow(sourceStuck)).toMatchObject({ status: 'reserved' })
  })

  it('runs for the service role only', async () => {
    const seed = await seedCompany()
    await setActiveCompany(seed.userId, seed.companyId)
    await expect(
      withUserContext(seed.userId, (client) => client.query(`SELECT * FROM public.sweep_interrupted_invoice_reminders(now())`)),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('list_reminder_batch_companies (pg)', () => {
  async function listed(): Promise<Map<string, { automatic_by_admin: boolean; reminders_automatic_by: string | null }>> {
    const rows = await runAsServiceRole(async (client) => {
      const result = await client.query<{ company_id: string; automatic_by_admin: boolean; reminders_automatic_by: string | null }>(
        `SELECT * FROM public.list_reminder_batch_companies()`,
      )
      return result.rows
    })
    return new Map(rows.map((r) => [r.company_id, r]))
  }

  it('visits the active companies with reminders on, never an archived, reset or sandbox one', async () => {
    const active = await seedCompany()
    await insertSettings(active)
    const off = await seedCompany()
    await insertSettings(off, { on: false })
    const archived = await seedCompany()
    await insertSettings(archived)
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [archived.companyId])
    const sandbox = await seedCompany()
    await insertSettings(sandbox, { sandbox: true })
    const source = await seedCompany()
    await insertSettings(source)
    await markResetSource(source)

    const companies = await listed()
    expect(companies.has(active.companyId)).toBe(true)
    for (const skipped of [off, archived, sandbox, source]) expect(companies.has(skipped.companyId)).toBe(false)
  })

  it('says whether the person who turned automatic sending on is still an owner or administrator', async () => {
    const byOwner = await seedCompany()
    await insertSettings(byOwner)
    await getPool().query(
      `UPDATE public.company_settings SET reminders_automatic_at = now(), reminders_automatic_by = $2 WHERE company_id = $1`,
      [byOwner.companyId, byOwner.userId],
    )
    const byDemoted = await seedCompany()
    await insertSettings(byDemoted)
    const demoted = await insertAuthUser()
    await insertCompanyMember({ companyId: byDemoted.companyId, userId: demoted, role: 'member' })
    await getPool().query(
      `UPDATE public.company_settings SET reminders_automatic_at = now(), reminders_automatic_by = $2 WHERE company_id = $1`,
      [byDemoted.companyId, demoted],
    )

    const companies = await listed()
    expect(companies.get(byOwner.companyId)).toMatchObject({ automatic_by_admin: true, reminders_automatic_by: byOwner.userId })
    expect(companies.get(byDemoted.companyId)).toMatchObject({ automatic_by_admin: false, reminders_automatic_by: demoted })
  })

  it('runs for the service role only', async () => {
    const seed = await seedCompany()
    await setActiveCompany(seed.userId, seed.companyId)
    await expect(
      withUserContext(seed.userId, (client) => client.query(`SELECT * FROM public.list_reminder_batch_companies()`)),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('list_reminder_candidate_invoices (pg)', () => {
  async function candidates(companyId: string, enabledOn: string | null): Promise<string[]> {
    return runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.list_reminder_candidate_invoices($1, '2026-12-02', $2::date)`,
        [companyId, enabledOn],
      )
      return rows.map((r) => r.id)
    })
  }

  it('reads the invoices dated since reminders went on, and older ones that already hold a reminder', async () => {
    const seed = await seedCompany()
    const sinceTurnOn = await seedInvoice(seed, { invoiceDate: '2026-11-01', dueDate: '2026-12-01' })
    const before = await seedInvoice(seed, { invoiceDate: '2026-10-01', dueDate: '2026-11-01' })
    const beforeReminded = await seedInvoice(seed, { invoiceDate: '2026-10-01', dueDate: '2026-11-01' })
    await insertReminder(seed, beforeReminded, { status: 'sent', sentAt: true })
    const dueLater = await seedInvoice(seed, { invoiceDate: '2026-11-02', dueDate: '2026-12-10' })
    const paid = await seedInvoice(seed, { invoiceDate: '2026-11-02', dueDate: '2026-12-01', status: 'paid' })

    const read = await candidates(seed.companyId, '2026-11-01')
    expect(read.sort()).toEqual([sinceTurnOn, beforeReminded].sort())
    for (const left of [before, dueLater, paid]) expect(read).not.toContain(left)

    // Without a turn-on day only the invoices on the ladder are read.
    expect(await candidates(seed.companyId, null)).toEqual([beforeReminded])
  })

  it('runs for the service role only', async () => {
    const seed = await seedCompany()
    await setActiveCompany(seed.userId, seed.companyId)
    await expect(
      withUserContext(seed.userId, (client) =>
        client.query(`SELECT * FROM public.list_reminder_candidate_invoices($1, '2026-12-02', '2026-11-01')`, [seed.companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('invoice_reminders writes (pg)', () => {
  it('no end-user role may insert, update or delete; the service role may', async () => {
    for (const role of ['authenticated', 'anon']) {
      const { rows } = await getPool().query<{ ins: boolean; upd: boolean; del: boolean; trunc: boolean }>(
        `SELECT has_any_column_privilege($1, 'public.invoice_reminders', 'INSERT') AS ins,
                has_any_column_privilege($1, 'public.invoice_reminders', 'UPDATE') AS upd,
                has_table_privilege($1, 'public.invoice_reminders', 'DELETE') AS del,
                has_table_privilege($1, 'public.invoice_reminders', 'TRUNCATE') AS trunc`,
        [role],
      )
      expect(rows[0], role).toEqual({ ins: false, upd: false, del: false, trunc: false })
    }
    const { rows } = await getPool().query<{ ins: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege('service_role', 'public.invoice_reminders', 'INSERT') AS ins,
              has_table_privilege('service_role', 'public.invoice_reminders', 'UPDATE') AS upd,
              has_table_privilege('service_role', 'public.invoice_reminders', 'DELETE') AS del`,
    )
    expect(rows[0]).toEqual({ ins: true, upd: true, del: true })
  })

  it("refuses an owner's direct write through the API role, and still lets the owner read", async () => {
    const seed = await seedCompany()
    const invoiceId = await seedInvoice(seed)
    const id = await insertReminder(seed, invoiceId, { status: 'sent', sentAt: true })
    await setActiveCompany(seed.userId, seed.companyId)

    // One statement per user context: a refused statement aborts the transaction.
    await expect(
      withUserContext(seed.userId, (client) =>
        client.query(
          `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to) VALUES ($1, $2, $3, 2, 'kund@example.se')`,
          [invoiceId, seed.userId, seed.companyId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(seed.userId, (client) => client.query(`UPDATE public.invoice_reminders SET status = 'failed' WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(seed.userId, (client) => client.query(`DELETE FROM public.invoice_reminders WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: '42501' })

    const read = await withUserContext(seed.userId, (client) =>
      client.query<{ status: string; outcome_unknown: boolean | null }>(
        `SELECT status, outcome_unknown, reserved_at FROM public.invoice_reminders WHERE id = $1`,
        [id],
      ),
    )
    expect(read.rows).toEqual([expect.objectContaining({ status: 'sent', outcome_unknown: null })])
    expect(await reminderRow(id)).toMatchObject({ status: 'sent' })
  })
})
