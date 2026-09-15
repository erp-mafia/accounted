import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'

/**
 * 20260915173000_brf_apartment_register.sql: the four register tables
 * (RLS, no DELETE, transfers append-only), the open-share guard on
 * holdings, the personnummer column on association_members, and the
 * record_brf_transfer() RPC (happy path with a partial share, buyer who is
 * not an admitted member, share above the holding, date before the holding,
 * non-writer refused).
 */

async function insertMember(companyId: string, userId: string, memberNumber: string, admittedOn = '2020-01-01', exitedOn: string | null = null): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on, exited_on)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, userId, memberNumber, `Medlem ${memberNumber}`, admittedOn, exitedOn],
  )
  return res.rows[0].id
}

async function insertApartment(companyId: string, userId: string, number = '1'): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.brf_apartments (company_id, user_id, apartment_number, location, upplaten_med, insats, upplatelseavgift)
     VALUES ($1, $2, $3, 'Storgatan 1, 2 tr', 'bostadsratt', 150000, 25000) RETURNING id`,
    [companyId, userId, number],
  )
  return res.rows[0].id
}

async function insertHolding(companyId: string, userId: string, apartmentId: string, memberId: string, share: number, from = '2020-01-01'): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.brf_apartment_holdings (company_id, user_id, apartment_id, member_id, share, from_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, userId, apartmentId, memberId, share, from],
  )
  return res.rows[0].id
}

async function callTransfer(actor: string, apartmentId: string, input: Record<string, unknown>) {
  const res = await withUserContext(actor, (c) =>
    c.query<{ r: Record<string, unknown> }>(`SELECT public.record_brf_transfer($1::uuid, $2::jsonb) AS r`, [
      apartmentId,
      JSON.stringify(input),
    ]),
  )
  return res.rows[0].r
}

describe('brf apartment register: RLS and retention', () => {
  it('lets company members read, writers insert as themselves, strangers see nothing, nobody deletes', async () => {
    const { userId, companyId } = await seedCompany()
    const apartmentId = await insertApartment(companyId, userId)
    const stranger = await insertAuthUser()
    expect(
      (await withUserContext(userId, (c) => c.query(`SELECT id FROM public.brf_apartments WHERE id = $1`, [apartmentId]))).rows,
    ).toHaveLength(1)
    expect(
      (await withUserContext(stranger, (c) => c.query(`SELECT id FROM public.brf_apartments WHERE id = $1`, [apartmentId]))).rows,
    ).toHaveLength(0)

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await expect(
      withUserContext(viewer, (c) =>
        c.query(
          `INSERT INTO public.brf_apartments (company_id, user_id, apartment_number, location, upplaten_med)
           VALUES ($1, $2, '2', 'x', 'bostadsratt')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    // A writer may not attribute the row to someone else.
    await expect(
      withUserContext(userId, (c) =>
        c.query(
          `INSERT INTO public.brf_apartments (company_id, user_id, apartment_number, location, upplaten_med)
           VALUES ($1, $2, '3', 'x', 'bostadsratt')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.brf_apartments WHERE id = $1`, [apartmentId])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps transfers append-only and pledges and holdings undeletable', async () => {
    const { userId, companyId } = await seedCompany()
    const apartmentId = await insertApartment(companyId, userId)
    const a = await insertMember(companyId, userId, '1')
    const b = await insertMember(companyId, userId, '2')
    const holdingId = await insertHolding(companyId, userId, apartmentId, a, 1)
    const transfer = await getPool().query<{ id: string }>(
      `INSERT INTO public.brf_apartment_transfers (company_id, user_id, apartment_id, transfer_date, kind, share, from_member_id, to_member_id, price)
       VALUES ($1, $2, $3, '2026-03-01', 'sale', 1, $4, $5, 2500000) RETURNING id`,
      [companyId, userId, apartmentId, a, b],
    )
    const pledge = await getPool().query<{ id: string }>(
      `INSERT INTO public.brf_pledges (company_id, user_id, apartment_id, member_id, creditor, notified_on)
       VALUES ($1, $2, $3, $4, 'Banken AB', '2026-01-15') RETURNING id`,
      [companyId, userId, apartmentId, a],
    )
    await expect(
      withUserContext(userId, (c) =>
        c.query(`UPDATE public.brf_apartment_transfers SET price = 1 WHERE id = $1`, [transfer.rows[0].id]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.brf_apartment_transfers WHERE id = $1`, [transfer.rows[0].id])),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.brf_pledges WHERE id = $1`, [pledge.rows[0].id])),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.brf_apartment_holdings WHERE id = $1`, [holdingId])),
    ).rejects.toMatchObject({ code: '42501' })
    // Releasing a pledge is an update, allowed for a writer.
    const released = await withUserContext(userId, (c) =>
      c.query(`UPDATE public.brf_pledges SET released_on = '2026-06-01' WHERE id = $1 RETURNING released_on`, [pledge.rows[0].id]),
    )
    expect(released.rows).toHaveLength(1)
  })

  it('stores the personnummer only as ciphertext and never lets a sale carry no price kind mismatch', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertMember(companyId, userId, '9')
    await getPool().query(`UPDATE public.association_members SET personal_number_ciphertext = 'enc:abc' WHERE id = $1`, [memberId])
    const row = await getPool().query<{ c: string }>(`SELECT personal_number_ciphertext AS c FROM public.association_members WHERE id = $1`, [memberId])
    expect(row.rows[0].c).toBe('enc:abc')
    const apartmentId = await insertApartment(companyId, userId, '7')
    const other = await insertMember(companyId, userId, '10')
    // A gift with a price violates the price/kind CHECK.
    await expect(
      getPool().query(
        `INSERT INTO public.brf_apartment_transfers (company_id, user_id, apartment_id, transfer_date, kind, share, from_member_id, to_member_id, price)
         VALUES ($1, $2, $3, '2026-03-01', 'gift', 1, $4, $5, 100)`,
        [companyId, userId, apartmentId, memberId, other],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('brf apartment register: holdings guard', () => {
  it('refuses open shares above the whole apartment and a member of another company', async () => {
    const { userId, companyId } = await seedCompany()
    const apartmentId = await insertApartment(companyId, userId)
    const a = await insertMember(companyId, userId, '1')
    const b = await insertMember(companyId, userId, '2')
    await insertHolding(companyId, userId, apartmentId, a, 0.5)
    await insertHolding(companyId, userId, apartmentId, b, 0.5)
    const c = await insertMember(companyId, userId, '3')
    await expect(insertHolding(companyId, userId, apartmentId, c, 0.25)).rejects.toMatchObject({ code: '23514' })
    // A closed holding does not count.
    await getPool().query(`UPDATE public.brf_apartment_holdings SET to_date = '2025-12-31' WHERE member_id = $1`, [b])
    await expect(insertHolding(companyId, userId, apartmentId, c, 0.5, '2026-01-01')).resolves.toBeTruthy()

    const other = await seedCompany()
    const foreign = await insertMember(other.companyId, other.userId, '1')
    await expect(insertHolding(companyId, userId, apartmentId, foreign, 0.1)).rejects.toMatchObject({ code: '23514' })
  })
})

describe('record_brf_transfer', () => {
  it('moves a partial share, keeps history and logs both members (happy path)', async () => {
    const { userId, companyId } = await seedCompany()
    const apartmentId = await insertApartment(companyId, userId)
    const seller = await insertMember(companyId, userId, '1')
    const buyer = await insertMember(companyId, userId, '2', '2026-02-01')
    await insertHolding(companyId, userId, apartmentId, seller, 1, '2015-06-01')
    // withUserContext rolls back at the end, so every read happens inside
    // the same transaction as the RPC (as the owner, under RLS).
    await withUserContext(userId, async (c) => {
      const call = async (input: Record<string, unknown>) =>
        (await c.query<{ r: Record<string, unknown> }>(`SELECT public.record_brf_transfer($1::uuid, $2::jsonb) AS r`, [apartmentId, JSON.stringify(input)])).rows[0].r
      const r = await call({
        from_member_id: seller,
        to_member_id: buyer,
        share: 0.5,
        transfer_date: '2026-03-01',
        kind: 'sale',
        price: 1250000,
        forvarv_date: '2015-06-01',
        forvarv_price: 800000,
        kapitaltillskott: 12000,
      })
      expect(r).toMatchObject({ ok: true, seller_remaining_share: 0.5, buyer_share: 0.5 })
      const open = await c.query<{ member_id: string; share: string; from_date: string }>(
        `SELECT member_id, share::text, from_date::text FROM public.brf_apartment_holdings WHERE apartment_id = $1 AND to_date IS NULL ORDER BY member_id`,
        [apartmentId],
      )
      expect(open.rows).toHaveLength(2)
      expect(open.rows.map((row) => Number(row.share))).toEqual([0.5, 0.5])
      expect(open.rows.every((row) => row.from_date === '2026-03-01')).toBe(true)
      const closed = await c.query<{ to_date: string; closed_by_transfer_id: string }>(
        `SELECT to_date::text, closed_by_transfer_id FROM public.brf_apartment_holdings WHERE apartment_id = $1 AND to_date IS NOT NULL`,
        [apartmentId],
      )
      expect(closed.rows).toEqual([{ to_date: '2026-03-01', closed_by_transfer_id: r.transfer_id }])
      const transfer = await c.query<{ price: string; kapitaltillskott: string; user_id: string }>(
        `SELECT price::text, kapitaltillskott::text, user_id FROM public.brf_apartment_transfers WHERE id = $1`,
        [r.transfer_id as string],
      )
      expect(transfer.rows[0]).toMatchObject({ price: '1250000.00', kapitaltillskott: '12000.00', user_id: userId })
      const events = await c.query<{ member_id: string; details: { direction: string } }>(
        `SELECT member_id, details FROM public.association_member_events WHERE event_type = 'transfer' AND (details->>'transfer_id') = $1 ORDER BY details->>'direction'`,
        [r.transfer_id as string],
      )
      expect(events.rows.map((e) => e.details.direction)).toEqual(['in', 'out'])

      // The buyer buys the rest: the open holdings collapse into one whole share.
      const r2 = await call({
        from_member_id: seller,
        to_member_id: buyer,
        share: 0.5,
        transfer_date: '2026-09-01',
        kind: 'sale',
        price: 1300000,
      })
      expect(r2).toMatchObject({ ok: true, seller_remaining_share: 0, buyer_share: 1 })
      const afterwards = await c.query<{ member_id: string; share: string }>(
        `SELECT member_id, share::text FROM public.brf_apartment_holdings WHERE apartment_id = $1 AND to_date IS NULL`,
        [apartmentId],
      )
      expect(afterwards.rows).toEqual([{ member_id: buyer, share: '1.000000' }])
    })
  })

  it('refuses a förvärvare who is not an admitted member on the transfer date (BRL 6 kap. 5 §)', async () => {
    const { userId, companyId } = await seedCompany()
    const apartmentId = await insertApartment(companyId, userId)
    const seller = await insertMember(companyId, userId, '1')
    await insertHolding(companyId, userId, apartmentId, seller, 1)
    const admittedLater = await insertMember(companyId, userId, '2', '2026-06-01')
    const exited = await insertMember(companyId, userId, '3', '2019-01-01', '2025-01-01')
    const other = await seedCompany()
    const foreign = await insertMember(other.companyId, other.userId, '1')
    for (const buyer of [admittedLater, exited, foreign]) {
      const r = await callTransfer(userId, apartmentId, {
        from_member_id: seller,
        to_member_id: buyer,
        share: 1,
        transfer_date: '2026-03-01',
        kind: 'sale',
        price: 1,
      })
      expect(r).toMatchObject({ ok: false, code: 'BRF_TRANSFER_BUYER_NOT_MEMBER' })
    }
    expect(
      (await getPool().query(`SELECT id FROM public.brf_apartment_transfers WHERE apartment_id = $1`, [apartmentId])).rows,
    ).toHaveLength(0)
  })

  it('refuses a share above the holding, a date before the holding, a non-holder and a non-writer', async () => {
    const { userId, companyId } = await seedCompany()
    const apartmentId = await insertApartment(companyId, userId)
    const a = await insertMember(companyId, userId, '1')
    const b = await insertMember(companyId, userId, '2')
    const c = await insertMember(companyId, userId, '3')
    await insertHolding(companyId, userId, apartmentId, a, 0.5, '2021-01-01')
    await insertHolding(companyId, userId, apartmentId, b, 0.5, '2021-01-01')
    const base = { to_member_id: c, transfer_date: '2026-03-01', kind: 'gift' }
    expect(await callTransfer(userId, apartmentId, { ...base, from_member_id: a, share: 0.75 })).toMatchObject({
      ok: false,
      code: 'BRF_TRANSFER_SHARE_EXCEEDS_HOLDING',
    })
    expect(
      await callTransfer(userId, apartmentId, { ...base, from_member_id: a, share: 0.5, transfer_date: '2020-12-31' }),
    ).toMatchObject({ ok: false, code: 'BRF_TRANSFER_DATE_BEFORE_HOLDING' })
    expect(await callTransfer(userId, apartmentId, { ...base, from_member_id: c, to_member_id: a, share: 0.5 })).toMatchObject({
      ok: false,
      code: 'BRF_TRANSFER_SELLER_NOT_HOLDER',
    })
    expect(await callTransfer(userId, apartmentId, { ...base, from_member_id: a, to_member_id: a, share: 0.5 })).toMatchObject({
      ok: false,
      code: 'BRF_TRANSFER_SAME_MEMBER',
    })
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    expect(await callTransfer(viewer, apartmentId, { ...base, from_member_id: a, share: 0.5 })).toMatchObject({
      ok: false,
      code: 'BRF_TRANSFER_FORBIDDEN',
    })
    const outsider = await insertAuthUser()
    expect(await callTransfer(outsider, apartmentId, { ...base, from_member_id: a, share: 0.5 })).toMatchObject({
      ok: false,
      code: 'BRF_APARTMENT_NOT_FOUND',
    })
  })
})
