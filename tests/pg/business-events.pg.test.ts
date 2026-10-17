/**
 * business_events and business_event_entries (migration 20261016220000):
 * the posting port's store, against the real schema.
 *
 *   - members record and read their company's events; outsiders, viewers and
 *     anon cannot;
 *   - both tables are append-only: UPDATE always refused, DELETE only through
 *     a cascade or the gnubok.allow_delete override;
 *   - a link joins an event and a DRAFT verifikat of the same company, so an
 *     event is never attached to a posted verifikat afterwards;
 *   - the shape checks: kind and category keys, party type + id only,
 *     evidence capped at 2000 bytes, idempotency key unique per company.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from './fixtures'

interface EventRow {
  id?: string
  company_id: string
  kind?: string
  category?: string | null
  occurred_on?: string
  party_type?: string | null
  party_id?: string | null
  evidence?: unknown
  idempotency_key?: string | null
}

const EVENT_SQL = `INSERT INTO public.business_events
  (id, company_id, kind, category, occurred_on, party_type, party_id, evidence, idempotency_key, subject_type, subject_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'transaction', $10)`

function eventParams(row: EventRow): unknown[] {
  return [
    row.id ?? randomUUID(),
    row.company_id,
    row.kind ?? 'bank.categorized',
    row.category === undefined ? 'expense.software' : row.category,
    row.occurred_on ?? '2026-03-14',
    row.party_type ?? null,
    row.party_id ?? null,
    JSON.stringify(row.evidence ?? {}),
    row.idempotency_key ?? null,
    randomUUID(),
  ]
}

async function insertEvent(row: EventRow): Promise<string> {
  const params = eventParams(row)
  await getPool().query(EVENT_SQL, params)
  return params[0] as string
}

async function link(eventId: string, entryId: string, companyId: string, role = 'produced'): Promise<void> {
  await getPool().query(
    `INSERT INTO public.business_event_entries (business_event_id, journal_entry_id, company_id, role)
     VALUES ($1, $2, $3, $4)`,
    [eventId, entryId, companyId, role],
  )
}

describe('business_events (pg)', () => {
  it('lets a member record and read events of their company, and nobody else', async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()

    const id = await withUserContext(userId, async (client) => {
      const params = eventParams({ company_id: companyId })
      await client.query(EVENT_SQL, params)
      const { rows } = await client.query(`SELECT id FROM public.business_events WHERE id = $1`, [params[0]])
      expect(rows).toHaveLength(1)
      return params[0]
    })
    expect(id).toBeTruthy()

    // An outsider can neither write into the company nor read it.
    await withUserContext(other.userId, async (client) => {
      await expect(client.query(EVENT_SQL, eventParams({ company_id: companyId }))).rejects.toMatchObject({ code: '42501' })
    })
    const eventId = await insertEvent({ company_id: companyId })
    await withUserContext(other.userId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.business_events WHERE id = $1`, [eventId])
      expect(rows).toHaveLength(0)
    })

    // A viewer reads but does not write.
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await withUserContext(viewer, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.business_events WHERE id = $1`, [eventId])
      expect(rows).toHaveLength(1)
      await expect(client.query(EVENT_SQL, eventParams({ company_id: companyId }))).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('grants anon nothing and nobody UPDATE', async () => {
    const { rows } = await getPool().query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name IN ('business_events', 'business_event_entries')
          AND grantee IN ('anon', 'authenticated', 'service_role')
        ORDER BY table_name, grantee, privilege_type`,
    )
    const grants = rows.map((r) => `${r.table_name}:${r.grantee}:${r.privilege_type}`)
    expect(grants).toEqual([
      'business_event_entries:authenticated:INSERT',
      'business_event_entries:authenticated:SELECT',
      'business_event_entries:service_role:DELETE',
      'business_event_entries:service_role:INSERT',
      'business_event_entries:service_role:SELECT',
      'business_events:authenticated:INSERT',
      'business_events:authenticated:SELECT',
      'business_events:service_role:DELETE',
      'business_events:service_role:INSERT',
      'business_events:service_role:SELECT',
    ])
  })

  it('is append-only: UPDATE refused, DELETE only under the override or through a cascade', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const eventId = await insertEvent({ company_id: companyId })
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await link(eventId, entryId, companyId)

    await expect(
      getPool().query(`UPDATE public.business_events SET category = 'expense.other' WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/)
    await expect(
      getPool().query(`UPDATE public.business_event_entries SET role = 'reversal' WHERE business_event_id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.business_event_entries WHERE business_event_id = $1`, [eventId]))
      .rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.business_events WHERE id = $1`, [eventId])).rejects.toThrow(/append-only/)

    // Under the operator and sandbox-teardown override (the only way a
    // verifikat, even a draft, is ever deleted), the verifikat takes its link
    // with it and the event goes only when deleted itself.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.journal_entry_lines WHERE journal_entry_id = $1`, [entryId])
      await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId])
      const links = await client.query(`SELECT 1 FROM public.business_event_entries WHERE business_event_id = $1`, [eventId])
      expect(links.rowCount).toBe(0)
      const events = await client.query(`SELECT 1 FROM public.business_events WHERE id = $1`, [eventId])
      expect(events.rowCount).toBe(1)
      await client.query(`DELETE FROM public.business_events WHERE id = $1`, [eventId])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const gone = await getPool().query(`SELECT 1 FROM public.business_events WHERE id = $1`, [eventId])
    expect(gone.rowCount).toBe(0)
  })

  it('goes with its company in the real sandbox teardown (cleanup_sandbox_user)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`,
      [userId, companyId],
    )
    const eventId = await insertEvent({ company_id: companyId })
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await link(eventId, entryId, companyId)
    await insertBalancedLines(entryId, 400)
    await getPool().query(`SELECT public.commit_journal_entry($1, $2)`, [companyId, entryId])

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [userId])

    const left = await getPool().query(
      `SELECT (SELECT count(*) FROM public.business_events WHERE id = $1)::int AS events,
              (SELECT count(*) FROM public.business_event_entries WHERE business_event_id = $1)::int AS links`,
      [eventId],
    )
    expect(left.rows[0]).toEqual({ events: 0, links: 0 })
  })

  it('links an event only to a draft verifikat of its own company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const other = await seedCompany()
    const eventId = await insertEvent({ company_id: companyId })

    // A posted verifikat: refused, an event is never attached afterwards.
    const posted = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(posted, 100)
    await getPool().query(`SELECT public.commit_journal_entry($1, $2)`, [companyId, posted])
    await expect(link(eventId, posted, companyId)).rejects.toThrow(/BUSINESS_EVENT_LINK_NOT_DRAFT/)

    // Another company's draft, or another company's event: refused.
    const foreignDraft = await insertDraftJournalEntry({
      userId: other.userId,
      companyId: other.companyId,
      fiscalPeriodId: other.fiscalPeriodId,
    })
    await expect(link(eventId, foreignDraft, companyId)).rejects.toThrow(/BUSINESS_EVENT_LINK_COMPANY_MISMATCH/)
    const foreignEvent = await insertEvent({ company_id: other.companyId })
    const draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await expect(link(foreignEvent, draft, companyId)).rejects.toThrow(/BUSINESS_EVENT_LINK_COMPANY_MISMATCH/)

    // The draft of its own company: linked, once per pair, roles from the list.
    await link(eventId, draft, companyId)
    await expect(link(eventId, draft, companyId)).rejects.toMatchObject({ code: '23505' })
    const second = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await expect(link(eventId, second, companyId, 'paid')).rejects.toMatchObject({ code: '23514' })
    await link(eventId, second, companyId, 'reversal')

    // The link survives the draft being posted: the voucher number is drawn
    // after the link, and posting changes nothing in the link tables.
    await insertBalancedLines(draft, 250)
    await getPool().query(`SELECT public.commit_journal_entry($1, $2)`, [companyId, draft])
    const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
      `SELECT je.status, je.voucher_number FROM public.business_event_entries l
         JOIN public.journal_entries je ON je.id = l.journal_entry_id
        WHERE l.business_event_id = $1 AND l.journal_entry_id = $2`,
      [eventId, draft],
    )
    expect(rows[0]).toMatchObject({ status: 'posted' })
    expect(rows[0]!.voucher_number).toBeGreaterThan(0)
  })

  it('checks the shapes: keys, party type + id only, evidence cap, idempotency per company', async () => {
    const { companyId } = await seedCompany()
    const other = await seedCompany()

    await expect(insertEvent({ company_id: companyId, kind: 'Bank Categorized' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertEvent({ company_id: companyId, kind: 'bank' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertEvent({ company_id: companyId, category: 'Expense Software' })).rejects.toMatchObject({ code: '23514' })
    await insertEvent({ company_id: companyId, category: null })
    await insertEvent({ company_id: companyId, category: 'se.tax.settlement' })

    await expect(
      insertEvent({ company_id: companyId, party_type: 'person', party_id: randomUUID() }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insertEvent({ company_id: companyId, party_type: 'supplier' })).rejects.toMatchObject({ code: '23514' })
    await insertEvent({ company_id: companyId, party_type: 'supplier', party_id: randomUUID() })

    await expect(
      insertEvent({ company_id: companyId, evidence: { note: 'x'.repeat(2100) } }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insertEvent({ company_id: companyId, evidence: ['not', 'an', 'object'] })).rejects.toMatchObject({
      code: '23514',
    })

    await insertEvent({ company_id: companyId, idempotency_key: 'import:job-1' })
    await expect(insertEvent({ company_id: companyId, idempotency_key: 'import:job-1' })).rejects.toMatchObject({
      code: '23505',
    })
    await insertEvent({ company_id: other.companyId, idempotency_key: 'import:job-1' })
    // NULL keys never collide.
    await insertEvent({ company_id: companyId })
    await insertEvent({ company_id: companyId })

    // A retried write of the same port-made id is the same row.
    const id = randomUUID()
    await insertEvent({ id, company_id: companyId })
    await expect(insertEvent({ id, company_id: companyId })).rejects.toMatchObject({ code: '23505' })
  })
})
