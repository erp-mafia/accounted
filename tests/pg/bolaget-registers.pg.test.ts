/**
 * pg-real tests for 20261029210000_bolaget_registers.sql (and the VALIDATE
 * in 20261029210100): the aktiebok is append-only and numbered in sequence,
 * the replay refuses a share held twice or a transfer of shares the
 * transferor does not hold, a rattelse voids an entry, roles are end-dated
 * never deleted, the personnummer table is out of members' reach and out of
 * audit_log, and RLS keeps every register to its company.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

type Company = { userId: string; companyId: string; fiscalPeriodId: string }

let a: Company
let b: Company

async function party(company: Company, name: string, kind = 'person'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.parties (id, company_id, user_id, display_name, kind, origin) VALUES ($1, $2, $3, $4, $5, 'bolaget')`,
    [id, company.companyId, company.userId, name, kind],
  )
  return id
}

async function shareClass(company: Company, code = 'A', votes = 1): Promise<string> {
  const id = randomUUID()
  await getPool().query(`INSERT INTO public.share_classes (id, company_id, code, votes_per_share) VALUES ($1, $2, $3, $4)`, [
    id,
    company.companyId,
    code,
    votes,
  ])
  return id
}

interface EventIn {
  kind: string
  date: string
  classId?: string | null
  toClassId?: string | null
  from?: string | null
  to?: string | null
  start?: number | null
  end?: number | null
  reason?: string | null
  ratio?: number | null
  corrects?: string | null
  note?: string | null
}

async function event(company: Company, e: EventIn): Promise<{ id: string; event_number: number }> {
  const res = await getPool().query<{ id: string; event_number: number }>(
    `INSERT INTO public.share_register_events
       (company_id, event_date, kind, share_class_id, to_share_class_id, from_party_id, to_party_id,
        range_start, range_end, transfer_reason, ratio, corrects_event_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, event_number`,
    [
      company.companyId,
      e.date,
      e.kind,
      e.classId ?? null,
      e.toClassId ?? null,
      e.from ?? null,
      e.to ?? null,
      e.start ?? null,
      e.end ?? null,
      e.reason ?? null,
      e.ratio ?? null,
      e.corrects ?? null,
      e.note ?? null,
      company.userId,
    ],
  )
  return res.rows[0]!
}

async function state(company: Company, asOf: string | null = null) {
  const res = await getPool().query<{ party_id: string; range_start: string; range_end: string; share_count: string }>(
    `SELECT party_id, range_start, range_end, share_count FROM public.share_register_state($1, $2)`,
    [company.companyId, asOf],
  )
  return res.rows.map((r) => [r.party_id, Number(r.range_start), Number(r.range_end)])
}

beforeAll(async () => {
  a = await seedCompany()
  b = await seedCompany()
})

describe('aktiebok: numbering and append-only', () => {
  it('numbers entries in sequence per company and refuses UPDATE and DELETE', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    const first = await event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 500 })
    const second = await event(c, { kind: 'nyemission', date: '2021-01-10', classId: cls, to: anna, start: 501, end: 600 })
    expect([first.event_number, second.event_number]).toEqual([1, 2])
    // Another company starts at 1.
    const other = await seedCompany()
    const otherCls = await shareClass(other)
    const otherParty = await party(other, 'Bo')
    expect((await event(other, { kind: 'bildande', date: '2020-01-10', classId: otherCls, to: otherParty, start: 1, end: 10 })).event_number).toBe(1)

    await expect(getPool().query(`UPDATE public.share_register_events SET note = 'x' WHERE id = $1`, [first.id])).rejects.toThrow(
      /SHARE_REGISTER_APPEND_ONLY/,
    )
    await expect(getPool().query(`DELETE FROM public.share_register_events WHERE id = $1`, [first.id])).rejects.toThrow(
      /SHARE_REGISTER_APPEND_ONLY/,
    )
  })

  it('refuses an entry without the fields its kind needs', async () => {
    const cls = await shareClass(a, 'S')
    await expect(event(a, { kind: 'overlatelse', date: '2021-01-01', classId: cls, start: 1, end: 2 })).rejects.toMatchObject({ code: '23514' })
    await expect(event(a, { kind: 'rattelse', date: '2021-01-01' })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('aktiebok: the replay', () => {
  it('refuses an issue on share numbers already held', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    const bo = await party(c, 'Bo')
    await event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 500 })
    await expect(event(c, { kind: 'nyemission', date: '2021-01-10', classId: cls, to: bo, start: 400, end: 700 })).rejects.toThrow(
      /SHARE_REGISTER_RANGE_TAKEN/,
    )
    const rows = await getPool().query(`SELECT count(*)::int AS n FROM public.share_register_events WHERE company_id = $1`, [c.companyId])
    expect(rows.rows[0].n).toBe(1)
  })

  it('moves only shares the transferor holds on the transfer date, and answers the state as of a date', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    const bo = await party(c, 'Bo')
    await event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 100 })
    await expect(
      event(c, { kind: 'overlatelse', date: '2021-01-01', classId: cls, from: bo, to: anna, start: 1, end: 10, reason: 'kop' }),
    ).rejects.toThrow(/SHARE_REGISTER_NOT_HELD/)
    await expect(
      event(c, { kind: 'overlatelse', date: '2019-01-01', classId: cls, from: anna, to: bo, start: 1, end: 10, reason: 'kop' }),
    ).rejects.toThrow(/SHARE_REGISTER_NOT_HELD/)
    await expect(
      event(c, { kind: 'overlatelse', date: '2021-01-01', classId: cls, from: anna, to: bo, start: 90, end: 110, reason: 'kop' }),
    ).rejects.toThrow(/SHARE_REGISTER_NOT_HELD/)

    await event(c, { kind: 'overlatelse', date: '2021-01-01', classId: cls, from: anna, to: bo, start: 41, end: 60, reason: 'gava' })
    expect(await state(c, '2020-12-31')).toEqual([[anna, 1, 100]])
    expect(await state(c)).toEqual([
      [anna, 1, 40],
      [bo, 41, 60],
      [anna, 61, 100],
    ])
    // Bo's shares cannot be given away by Anna afterwards.
    await expect(
      event(c, { kind: 'indragning', date: '2022-01-01', classId: cls, from: anna, start: 41, end: 50 }),
    ).rejects.toThrow(/SHARE_REGISTER_NOT_HELD/)
  })

  it('renumbers on a split and refuses a misaligned sammanläggning', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    const bo = await party(c, 'Bo')
    await event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 3 })
    await event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: bo, start: 4, end: 10 })
    await event(c, { kind: 'split', date: '2021-01-01', ratio: 10 })
    expect(await state(c)).toEqual([
      [anna, 1, 30],
      [bo, 31, 100],
    ])
    await expect(event(c, { kind: 'sammanlaggning', date: '2022-01-01', ratio: 20 })).rejects.toThrow(/SHARE_REGISTER_RATIO_MISALIGNED/)
  })

  it('voids an entry with a rattelse and accepts the corrected entry beside it', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    const bo = await party(c, 'Bo')
    const cia = await party(c, 'Cia')
    await event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 100 })
    const wrong = await event(c, { kind: 'overlatelse', date: '2021-01-01', classId: cls, from: anna, to: bo, start: 1, end: 50, reason: 'kop' })
    const fix = await event(c, { kind: 'rattelse', date: '2021-02-01', corrects: wrong.id, note: 'Fel köpare' })
    await event(c, { kind: 'overlatelse', date: '2021-01-01', classId: cls, from: anna, to: cia, start: 1, end: 50, reason: 'kop' })
    expect(await state(c)).toEqual([
      [cia, 1, 50],
      [anna, 51, 100],
    ])
    // A rattelse is not itself corrected, and an entry is voided once.
    await expect(event(c, { kind: 'rattelse', date: '2021-03-01', corrects: fix.id, note: 'x' })).rejects.toThrow(
      /SHARE_REGISTER_CORRECTION_INVALID/,
    )
    await expect(event(c, { kind: 'rattelse', date: '2021-03-01', corrects: wrong.id, note: 'x' })).rejects.toMatchObject({ code: '23505' })
  })

  it('refuses a void that leaves later entries without the shares they moved', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    const bo = await party(c, 'Bo')
    const issue = await event(c, { kind: 'nyemission', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 10 })
    await event(c, { kind: 'overlatelse', date: '2021-01-01', classId: cls, from: anna, to: bo, start: 1, end: 10, reason: 'kop' })
    await expect(event(c, { kind: 'rattelse', date: '2021-02-01', corrects: issue.id, note: 'x' })).rejects.toThrow(/SHARE_REGISTER_NOT_HELD/)
  })

  it('takes no entries for an avstämningsbolag', async () => {
    const c = await seedCompany()
    const cls = await shareClass(c)
    const anna = await party(c, 'Anna')
    await getPool().query(`INSERT INTO public.share_register_settings (company_id, is_avstamningsbolag) VALUES ($1, true)`, [c.companyId])
    await expect(event(c, { kind: 'bildande', date: '2020-01-10', classId: cls, to: anna, start: 1, end: 10 })).rejects.toThrow(
      /SHARE_REGISTER_AVSTAMNINGSBOLAG/,
    )
  })
})

describe('aktiebok: RLS', () => {
  it('shows a company only its own entries, lets a member write and a viewer only read', async () => {
    const cls = await shareClass(a, 'R')
    const holder = await party(a, 'Rut')
    const entry = await event(a, { kind: 'bildande', date: '2020-01-10', classId: cls, to: holder, start: 9001, end: 9010 })
    const seenByB = await withUserContext(b.userId, async (client) =>
      (await client.query('SELECT id FROM public.share_register_events WHERE id = $1', [entry.id])).rowCount)
    const seenByA = await withUserContext(a.userId, async (client) =>
      (await client.query('SELECT id FROM public.share_register_events WHERE id = $1', [entry.id])).rowCount)
    expect(seenByB).toBe(0)
    expect(seenByA).toBe(1)
    const stateForB = await withUserContext(b.userId, async (client) =>
      (await client.query('SELECT * FROM public.share_register_state($1, NULL)', [a.companyId])).rowCount)
    expect(stateForB).toBe(0)

    await expect(withUserContext(b.userId, (client) => client.query(
      `INSERT INTO public.share_register_events (company_id, event_date, kind, note) VALUES ($1, '2021-01-01', 'anteckning', 'x')`,
      [a.companyId],
    ))).rejects.toMatchObject({ code: '42501' })

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.share_register_events (company_id, event_date, kind, note) VALUES ($1, '2021-01-01', 'anteckning', 'x')`,
      [a.companyId],
    ))).rejects.toMatchObject({ code: '42501' })

    const inserted = await withUserContext(a.userId, async (client) =>
      (await client.query(
        `INSERT INTO public.share_register_events (company_id, event_date, kind, note) VALUES ($1, '2021-01-01', 'anteckning', 'x') RETURNING id`,
        [a.companyId],
      )).rowCount)
    expect(inserted).toBe(1)
  })
})

describe('roles over time', () => {
  it('end-dates a role once and never changes who or what, nor deletes it', async () => {
    const person = await party(a, 'Styrelse Person')
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO public.company_roles (company_id, party_id, role, valid_from, source) VALUES ($1, $2, 'styrelseledamot', '2020-01-01', 'person') RETURNING id`,
      [a.companyId, person],
    )
    const roleId = res.rows[0]!.id
    await expect(getPool().query(`UPDATE public.company_roles SET role = 'vd' WHERE id = $1`, [roleId])).rejects.toThrow(/COMPANY_ROLE_APPEND_ONLY/)
    await getPool().query(`UPDATE public.company_roles SET valid_to = '2024-06-30' WHERE id = $1`, [roleId])
    await expect(getPool().query(`UPDATE public.company_roles SET valid_to = '2024-07-31' WHERE id = $1`, [roleId])).rejects.toThrow(
      /COMPANY_ROLE_ALREADY_ENDED/,
    )
    await expect(getPool().query(`DELETE FROM public.company_roles WHERE id = $1`, [roleId])).rejects.toThrow(/COMPANY_ROLE_APPEND_ONLY/)
    await expect(getPool().query(
      `INSERT INTO public.company_roles (company_id, party_id, role, valid_from, valid_to, source) VALUES ($1, $2, 'vd', '2020-01-01', '2019-01-01', 'person')`,
      [a.companyId, person],
    )).rejects.toMatchObject({ code: '23514' })
    const seenByB = await withUserContext(b.userId, async (client) =>
      (await client.query('SELECT id FROM public.company_roles WHERE id = $1', [roleId])).rowCount)
    expect(seenByB).toBe(0)
  })

  it('keeps a beneficial owner assessment as made', async () => {
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO public.beneficial_owner_assessments (company_id, assessed_on, basis, conclusion, owners)
       VALUES ($1, '2026-10-29', 'Aktieboken', 'no_beneficial_owner', '[]') RETURNING id`,
      [a.companyId],
    )
    const id = res.rows[0]!.id
    await expect(getPool().query(`UPDATE public.beneficial_owner_assessments SET basis = 'x' WHERE id = $1`, [id])).rejects.toThrow(
      /BENEFICIAL_OWNER_APPEND_ONLY/,
    )
    await expect(getPool().query(`DELETE FROM public.beneficial_owner_assessments WHERE id = $1`, [id])).rejects.toThrow(
      /BENEFICIAL_OWNER_APPEND_ONLY/,
    )
    await expect(getPool().query(
      `INSERT INTO public.beneficial_owner_assessments (company_id, assessed_on, basis, conclusion, owners)
       VALUES ($1, '2026-10-29', 'Aktieboken', 'no_beneficial_owner', '[{"party_id":"x"}]')`,
      [a.companyId],
    )).rejects.toMatchObject({ code: '23514' })
  })
})

describe('party_person_private', () => {
  it('is out of reach for members, reachable for the service role, and never in audit_log', async () => {
    const person = await party(a, 'Privat Person')
    await runAsServiceRole((client) => client.query(
      `INSERT INTO public.party_person_private (party_id, company_id, personnummer_encrypted, personnummer_hmac, personnummer_masked, city)
       VALUES ($1, $2, '\\x00'::bytea, $3, 'XXXXXXXX-1234', 'Stockholm')`,
      [person, a.companyId, 'a'.repeat(64)],
    ))
    await expect(withUserContext(a.userId, (client) =>
      client.query('SELECT personnummer_masked FROM public.party_person_private WHERE party_id = $1', [person]),
    )).rejects.toMatchObject({ code: '42501' })
    await expect(withUserContext(a.userId, (client) =>
      client.query(`INSERT INTO public.party_person_private (party_id, company_id) VALUES ($1, $2)`, [person, a.companyId]),
    )).rejects.toMatchObject({ code: '42501' })
    const seen = await runAsServiceRole(async (client) =>
      (await client.query('SELECT city FROM public.party_person_private WHERE party_id = $1', [person])).rows)
    expect(seen).toEqual([{ city: 'Stockholm' }])
    const audit = await getPool().query(
      `SELECT count(*)::int AS n FROM public.audit_log
        WHERE table_name = 'party_person_private' OR (company_id = $1 AND new_state::text LIKE '%XXXXXXXX-1234%')`,
      [a.companyId],
    )
    expect(audit.rows[0].n).toBe(0)
  })

  it('holds one person per personnummer within a company', async () => {
    const one = await party(b, 'Ett')
    const two = await party(b, 'Två')
    const hmac = 'b'.repeat(64)
    const insert = (partyId: string) =>
      getPool().query(
        `INSERT INTO public.party_person_private (party_id, company_id, personnummer_encrypted, personnummer_hmac, personnummer_masked)
         VALUES ($1, $2, '\\x00'::bytea, $3, 'XXXXXXXX-0000')`,
        [partyId, b.companyId, hmac],
      )
    await insert(one)
    await expect(insert(two)).rejects.toMatchObject({ code: '23505' })
  })
})

describe('checks expanded by the migration', () => {
  it('accepts parties of origin bolaget and the Bolaget pending operation types', async () => {
    expect(await party(a, 'Origin Test')).toBeTruthy()
    for (const type of ['register_share_event', 'create_share_class', 'update_share_class', 'add_company_role', 'end_company_role', 'set_signatory_rule', 'confirm_beneficial_owners']) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, $3, 'test')`,
          [a.userId, a.companyId, type],
        )
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  })
})
