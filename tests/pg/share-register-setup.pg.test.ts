/**
 * pg-real tests for 20261122201347_share_register_setup_and_holder_history.sql:
 * a holding carried over from an earlier register is entered while the
 * aktiebok is set up and never after; completing the setup needs shares,
 * happens once, is the owner's or an admin's and is entered in the register;
 * once in use an entry carries the day it is made and keeps the day of the
 * event; the name and organisationsnummer of a party the register names
 * change only by the owner, an admin or the service role, also inside another
 * row's trigger, and each change is entered as a dated note; and a holder's
 * replaced identity number and address are kept, out of members' reach and
 * append-only.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

type Company = { userId: string; companyId: string; fiscalPeriodId: string }

// Every date is counted from today on the Swedish calendar, so the suite
// answers the same whenever it runs.
let TODAY = ''
function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
/** The day the opening holdings stand, and a later day still in the past. */
const OPENING = -300
const LATER = -200

beforeAll(async () => {
  TODAY = (await getPool().query<{ today: string }>(`SELECT public.stockholm_today()::text AS today`)).rows[0]!.today
})

async function party(company: Company, name: string, kind = 'person', origin = 'bolaget'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.parties (id, company_id, user_id, display_name, kind, origin) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, company.companyId, company.userId, name, kind, origin],
  )
  return id
}

async function shareClass(company: Company): Promise<string> {
  const id = randomUUID()
  await getPool().query(`INSERT INTO public.share_classes (id, company_id, code) VALUES ($1, $2, 'A')`, [id, company.companyId])
  return id
}

const HOLDING = `INSERT INTO public.share_register_events (company_id, event_date, kind, share_class_id, to_party_id, range_start, range_end, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, event_number, event_date::text, occurred_on::text`

async function holding(company: Company, kind: string, date: string, classId: string, to: string, start: number, end: number) {
  const res = await getPool().query<{ id: string; event_number: number; event_date: string; occurred_on: string | null }>(HOLDING, [
    company.companyId,
    date,
    kind,
    classId,
    to,
    start,
    end,
    company.userId,
  ])
  return res.rows[0]!
}

/** A company with one holder of shares 1 to 500, entered as carried over from an earlier register. */
async function companyWithRegister() {
  const company = await seedCompany()
  const cls = await shareClass(company)
  const anna = await party(company, 'Anna Ek')
  await holding(company, 'ingaende', day(OPENING), cls, anna, 1, 500)
  return { company, cls, anna }
}

const COMPLETE = `INSERT INTO public.share_register_settings (company_id, setup_completed_at) VALUES ($1, now())
                  ON CONFLICT (company_id) DO UPDATE SET setup_completed_at = now()`

async function notes(company: Company): Promise<Array<{ event_number: number; note: string; event_date: string; today: string; created_by: string | null }>> {
  const res = await getPool().query(
    `SELECT event_number, note, event_date::text, public.stockholm_today()::text AS today, created_by
       FROM public.share_register_events WHERE company_id = $1 AND kind = 'anteckning' ORDER BY event_number`,
    [company.companyId],
  )
  return res.rows
}

describe('aktiebok: a holding carried over from an earlier register', () => {
  it('is entered while the register is set up and counts as held shares', async () => {
    const { company, cls, anna } = await companyWithRegister()
    const state = await getPool().query(`SELECT party_id, range_start::int, range_end::int FROM public.share_register_state($1, NULL)`, [company.companyId])
    expect(state.rows).toEqual([{ party_id: anna, range_start: 1, range_end: 500 }])
    // Not yet on the day before it stands.
    const before = await getPool().query(`SELECT 1 FROM public.share_register_state($1, $2)`, [company.companyId, day(OPENING - 1)])
    expect(before.rowCount).toBe(0)
    // A share is held once, whatever kind entered it.
    await expect(holding(company, 'ingaende', day(OPENING), cls, anna, 400, 600)).rejects.toThrow(/SHARE_REGISTER_RANGE_TAKEN/)
  })

  it('needs the holder, the class and the share numbers, like a bildande', async () => {
    const company = await seedCompany()
    await expect(
      getPool().query(`INSERT INTO public.share_register_events (company_id, event_date, kind, note) VALUES ($1, $2, 'ingaende', 'x')`, [company.companyId, day(OPENING)]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('aktiebok: completing the setup (ABL 5:3)', () => {
  it('needs shares in the register', async () => {
    const company = await seedCompany()
    await expect(getPool().query(COMPLETE, [company.companyId])).rejects.toThrow(/SHARE_REGISTER_EMPTY/)
  })

  it('stamps the moment, enters one dated note in the register, and cannot be reopened or repeated', async () => {
    const { company } = await companyWithRegister()
    // The settings row is there already (the roles were seeded): the upsert below updates it.
    await getPool().query(`INSERT INTO public.share_register_settings (company_id) VALUES ($1)`, [company.companyId])
    // An upsert, as the application writes it: the note is entered once.
    await getPool().query(
      `INSERT INTO public.share_register_settings (company_id, setup_completed_at, setup_completed_by) VALUES ($1, '2001-01-01', $2)
       ON CONFLICT (company_id) DO UPDATE SET setup_completed_at = excluded.setup_completed_at, setup_completed_by = excluded.setup_completed_by`,
      [company.companyId, company.userId],
    )
    const settings = await getPool().query<{ fresh: boolean; setup_completed_by: string }>(
      `SELECT setup_completed_at > now() - interval '1 hour' AS fresh, setup_completed_by FROM public.share_register_settings WHERE company_id = $1`,
      [company.companyId],
    )
    // The database's own moment, not the one the row carried; the acting user as the service role named them.
    expect(settings.rows[0]).toEqual({ fresh: true, setup_completed_by: company.userId })
    const written = await notes(company)
    expect(written).toHaveLength(1)
    expect(written[0]!.note).toMatch(/^Aktieboken är upplagd/)
    expect(written[0]!.event_date).toBe(written[0]!.today)
    expect(written[0]!.created_by).toBe(company.userId)

    await expect(
      getPool().query(`UPDATE public.share_register_settings SET setup_completed_at = NULL WHERE company_id = $1`, [company.companyId]),
    ).rejects.toThrow(/SHARE_REGISTER_SETUP_COMPLETE/)
    await expect(
      getPool().query(`UPDATE public.share_register_settings SET setup_completed_at = now() WHERE company_id = $1`, [company.companyId]),
    ).rejects.toThrow(/SHARE_REGISTER_SETUP_COMPLETE/)
    // Another setting of the register still changes, and adds no second note.
    await getPool().query(`UPDATE public.share_register_settings SET roles_seeded_at = now() WHERE company_id = $1`, [company.companyId])
    expect(await notes(company)).toHaveLength(1)
  })

  it('is the owner\'s or an admin\'s, and names who did it', async () => {
    const { company } = await companyWithRegister()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: memberId, role: 'member' })
    await expect(withUserContext(memberId, (client) => client.query(COMPLETE, [company.companyId]))).rejects.toMatchObject({ code: '42501' })

    const byOwner = await withUserContext(company.userId, async (client) => {
      await client.query(COMPLETE, [company.companyId])
      const settings = await client.query(`SELECT setup_completed_by FROM public.share_register_settings WHERE company_id = $1`, [company.companyId])
      const note = await client.query(`SELECT created_by FROM public.share_register_events WHERE company_id = $1 AND kind = 'anteckning'`, [company.companyId])
      return { by: settings.rows[0].setup_completed_by, noteBy: note.rows.map((r) => r.created_by) }
    })
    expect(byOwner).toEqual({ by: company.userId, noteBy: [company.userId] })
  })

  it('is not for an avstämningsbolag', async () => {
    const { company } = await companyWithRegister()
    await getPool().query(`INSERT INTO public.share_register_settings (company_id, is_avstamningsbolag) VALUES ($1, true)`, [company.companyId])
    await expect(getPool().query(COMPLETE, [company.companyId])).rejects.toThrow(/SHARE_REGISTER_AVSTAMNINGSBOLAG/)
  })
})

describe('aktiebok: the day an entry carries (ABL 4:37, 5:9, 7:2)', () => {
  it('keeps the day of the event while the register is set up', async () => {
    const { company, cls, anna } = await companyWithRegister()
    const entry = await holding(company, 'nyemission', day(LATER), cls, anna, 501, 600)
    expect(entry).toMatchObject({ event_date: day(LATER), occurred_on: null })
  })

  it('carries the day it is made once the register is in use, and keeps the day of the event beside it', async () => {
    const { company, cls, anna } = await companyWithRegister()
    await getPool().query(COMPLETE, [company.companyId])
    const today = TODAY
    const entry = await holding(company, 'nyemission', day(LATER), cls, anna, 501, 600)
    expect(entry).toMatchObject({ event_date: today, occurred_on: day(LATER) })
    // The register on the day of the event does not show what was entered later.
    const then = await getPool().query(`SELECT range_end::int FROM public.share_register_state($1, $2)`, [company.companyId, day(LATER)])
    expect(then.rows).toEqual([{ range_end: 500 }])
    const now = await getPool().query(`SELECT range_end::int FROM public.share_register_state($1, NULL)`, [company.companyId])
    expect(now.rows).toEqual([{ range_end: 600 }])
    // An entry made for today has no other day to keep.
    const sameDay = await holding(company, 'nyemission', today, cls, anna, 601, 610)
    expect(sameDay).toMatchObject({ event_date: today, occurred_on: null })
  })

  it('takes no holding carried over from an earlier register once in use', async () => {
    const { company, cls, anna } = await companyWithRegister()
    await getPool().query(COMPLETE, [company.companyId])
    await expect(holding(company, 'ingaende', day(OPENING), cls, anna, 501, 600)).rejects.toThrow(/SHARE_REGISTER_SETUP_COMPLETE/)
  })

  it('never stores a day of the event that is not earlier than the entry\'s day', async () => {
    const { company } = await companyWithRegister()
    const res = await getPool().query<{ occurred_on: string | null }>(
      `INSERT INTO public.share_register_events (company_id, event_date, occurred_on, kind, note)
       VALUES ($1, $2, $2, 'anteckning', 'x') RETURNING occurred_on::text`,
      [company.companyId, day(LATER)],
    )
    expect(res.rows[0]!.occurred_on).toBeNull()
  })
})

describe('aktiebok: a holder\'s name or organisationsnummer changes (ABL 5:3, 5:9)', () => {
  it('enters a dated note that says what the name was', async () => {
    const { company, anna } = await companyWithRegister()
    await getPool().query(`UPDATE public.parties SET display_name = 'Anna Ek Berg' WHERE id = $1`, [anna])
    const written = await notes(company)
    expect(written).toHaveLength(1)
    expect(written[0]!.note).toBe('Anna Ek Berg: namnet ändrat från Anna Ek till Anna Ek Berg.')
    expect(written[0]!.event_date).toBe(written[0]!.today)
  })

  it('notes an organisationsnummer that is entered, changed or removed', async () => {
    const company = await seedCompany()
    const cls = await shareClass(company)
    const holder = await party(company, 'Ek Holding AB', 'company')
    await holding(company, 'ingaende', day(OPENING), cls, holder, 1, 100)
    await getPool().query(`UPDATE public.parties SET org_number = '5560000001' WHERE id = $1`, [holder])
    await getPool().query(`UPDATE public.parties SET org_number = NULL WHERE id = $1`, [holder])
    expect((await notes(company)).map((n) => n.note)).toEqual([
      'Ek Holding AB: organisationsnummer 5560000001 infört.',
      'Ek Holding AB: organisationsnummer 5560000001 borttaget.',
    ])
  })

  it('leaves a party the register does not name alone, and a change of anything else', async () => {
    const { company, anna } = await companyWithRegister()
    const customer = await party(company, 'Kund AB', 'company', 'manual')
    await getPool().query(`UPDATE public.parties SET display_name = 'Kund Sverige AB' WHERE id = $1`, [customer])
    await getPool().query(`UPDATE public.parties SET legal_name = 'Anna Ek' WHERE id = $1`, [anna])
    expect(await notes(company)).toHaveLength(0)
  })

  it('is the owner\'s or an admin\'s (ABL 5:7), and a viewer\'s or a member\'s never', async () => {
    const { company, anna } = await companyWithRegister()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: memberId, role: 'member' })
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: viewerId, role: 'viewer' })
    const rename = `UPDATE public.parties SET display_name = 'A. Ek' WHERE id = $1`
    for (const userId of [memberId, viewerId]) {
      await expect(withUserContext(userId, (client) => client.query(rename, [anna]))).rejects.toThrow(/SHARE_REGISTER_HOLDER_ADMIN_ONLY/)
    }
    expect(await notes(company)).toHaveLength(0)
    // A party the register does not name is theirs to rename as before.
    const customer = await party(company, 'Kund AB', 'company', 'manual')
    const renamed = await withUserContext(memberId, async (client) =>
      (await client.query(`UPDATE public.parties SET display_name = 'Kund Sverige AB' WHERE id = $1`, [customer])).rowCount)
    expect(renamed).toBe(1)

    const byOwner = await withUserContext(company.userId, async (client) => {
      await client.query(rename, [anna])
      return (await client.query(`SELECT note, created_by FROM public.share_register_events WHERE company_id = $1 AND kind = 'anteckning'`, [company.companyId])).rows
    })
    expect(byOwner).toEqual([{ note: 'A. Ek: namnet ändrat från Anna Ek till A. Ek.', created_by: company.userId }])
  })

  it('holds inside another row\'s trigger too: a member\'s save of a supplier that would change the party is refused, an owner\'s goes through and is noted', async () => {
    const company = await seedCompany()
    const cls = await shareClass(company)
    // A supplier without an organisationsnummer, whose party also holds shares.
    const supplier = await getPool().query<{ id: string; party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, 'Ek Holding AB') RETURNING id, party_id`,
      [company.companyId, company.userId],
    )
    const holder = supplier.rows[0]!.party_id
    await holding(company, 'ingaende', day(OPENING), cls, holder, 1, 100)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: memberId, role: 'member' })
    // The supplier row is the member's to change, but its trigger would teach the party its organisationsnummer.
    const teach = `UPDATE public.suppliers SET org_number = '556666-1012' WHERE id = $1`
    await expect(withUserContext(memberId, (client) => client.query(teach, [supplier.rows[0]!.id]))).rejects.toThrow(/SHARE_REGISTER_HOLDER_ADMIN_ONLY/)
    expect(await notes(company)).toHaveLength(0)
    // Anything else on the supplier is still the member's.
    const other = await withUserContext(memberId, async (client) =>
      (await client.query(`UPDATE public.suppliers SET email = 'ek@example.com' WHERE id = $1`, [supplier.rows[0]!.id])).rowCount)
    expect(other).toBe(1)

    const byOwner = await withUserContext(company.userId, async (client) => {
      await client.query(teach, [supplier.rows[0]!.id])
      const p = await client.query(`SELECT org_number FROM public.parties WHERE id = $1`, [holder])
      const written = await client.query(`SELECT note, created_by FROM public.share_register_events WHERE company_id = $1 AND kind = 'anteckning'`, [company.companyId])
      return { org: p.rows[0].org_number, notes: written.rows }
    })
    expect(byOwner).toEqual({ org: '5566661012', notes: [{ note: 'Ek Holding AB: organisationsnummer 5566661012 infört.', created_by: company.userId }] })
  })

  it('lets the service role change the party, and notes it', async () => {
    const { company, anna } = await companyWithRegister()
    await runAsServiceRole((client) => client.query(`UPDATE public.parties SET display_name = 'Anna Ek Berg' WHERE id = $1`, [anna]))
    expect((await notes(company)).map((n) => n.note)).toEqual(['Anna Ek Berg: namnet ändrat från Anna Ek till Anna Ek Berg.'])
  })

  it('enters nothing for an avstämningsbolag, whose register is not kept here', async () => {
    const { company, anna } = await companyWithRegister()
    await getPool().query(`INSERT INTO public.share_register_settings (company_id, is_avstamningsbolag) VALUES ($1, true)`, [company.companyId])
    await getPool().query(`UPDATE public.parties SET display_name = 'Anna Berg' WHERE id = $1`, [anna])
    expect(await notes(company)).toHaveLength(0)
  })
})

describe('party_person_private_history: what a holder\'s particulars were (ABL 5:3)', () => {
  const insertPrivate = (partyId: string, companyId: string, city: string | null, hmac: string | null) =>
    runAsServiceRole((client) =>
      client.query(
        `INSERT INTO public.party_person_private (party_id, company_id, personnummer_encrypted, personnummer_hmac, personnummer_masked, address_line1, city)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [partyId, companyId, hmac ? Buffer.from([1]) : null, hmac, hmac ? 'XXXXXXXX-1234' : null, city ? 'Storgatan 1' : null, city],
      ),
    )
  const history = async (partyId: string) =>
    (await getPool().query(`SELECT personnummer_masked, address_line1, city FROM public.party_person_private_history WHERE party_id = $1 ORDER BY replaced_at`, [partyId])).rows

  it('keeps the address and the identity number a holder had before a change', async () => {
    const { company, anna } = await companyWithRegister()
    await insertPrivate(anna, company.companyId, 'Lund', 'a'.repeat(64))
    await runAsServiceRole((client) => client.query(`UPDATE public.party_person_private SET address_line1 = 'Nygatan 2', city = 'Malmö' WHERE party_id = $1`, [anna]))
    expect(await history(anna)).toEqual([{ personnummer_masked: 'XXXXXXXX-1234', address_line1: 'Storgatan 1', city: 'Lund' }])
    // The same values written again replace nothing.
    await runAsServiceRole((client) => client.query(`UPDATE public.party_person_private SET city = 'Malmö', email = 'anna@example.com' WHERE party_id = $1`, [anna]))
    expect(await history(anna)).toHaveLength(1)
  })

  it('keeps nothing when what was missing is filled in, and nothing for somebody the aktiebok does not name', async () => {
    const { company, anna } = await companyWithRegister()
    await insertPrivate(anna, company.companyId, null, null)
    await runAsServiceRole((client) => client.query(`UPDATE public.party_person_private SET address_line1 = 'Storgatan 1', city = 'Lund' WHERE party_id = $1`, [anna]))
    expect(await history(anna)).toHaveLength(0)

    const boardMember = await party(company, 'Bo Ek')
    await insertPrivate(boardMember, company.companyId, 'Lund', null)
    await runAsServiceRole((client) => client.query(`UPDATE public.party_person_private SET city = 'Malmö' WHERE party_id = $1`, [boardMember]))
    expect(await history(boardMember)).toHaveLength(0)
  })

  it('is out of members\' reach and append-only', async () => {
    const { company, anna } = await companyWithRegister()
    await insertPrivate(anna, company.companyId, 'Lund', null)
    await runAsServiceRole((client) => client.query(`UPDATE public.party_person_private SET city = 'Malmö' WHERE party_id = $1`, [anna]))
    await expect(
      withUserContext(company.userId, (client) => client.query(`SELECT city FROM public.party_person_private_history WHERE party_id = $1`, [anna])),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(getPool().query(`UPDATE public.party_person_private_history SET city = 'X' WHERE party_id = $1`, [anna])).rejects.toThrow(/SHARE_REGISTER_APPEND_ONLY/)
    await expect(getPool().query(`DELETE FROM public.party_person_private_history WHERE party_id = $1`, [anna])).rejects.toThrow(/SHARE_REGISTER_APPEND_ONLY/)
    // No personnummer or address reaches audit_log through the history.
    const audit = await getPool().query(`SELECT count(*)::int AS n FROM public.audit_log WHERE table_name = 'party_person_private_history'`)
    expect(audit.rows[0].n).toBe(0)
  })
})
