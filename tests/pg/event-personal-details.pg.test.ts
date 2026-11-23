import { beforeAll, describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'

/**
 * Events are kept; what can name a person leaves them after 30 days
 * (20261123190000_event_personal_details_after_30_days):
 * event_data_without_personal_details is what stays of an event,
 * remove_event_personal_details applies it to event_log business events and
 * event_outbox rows older than 30 days, an outbox row keeps its payload while
 * a delivery is owed, and event_log stays append-only apart from that one
 * change, which the database writes itself.
 */

const ID = '5f0c8a1e-2b3c-4d5e-8f90-a1b2c3d4e5f6'
const CUSTOMER_ID = '0b6f3c2d-1e4a-4b5c-9d8e-7f6a5b4c3d2e'
const USER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

/** An invoice.created payload as emitted: the invoice with its customer and lines. */
const INVOICE_EVENT = {
  userId: USER_ID,
  invoice: {
    id: ID,
    invoice_number: '2026-001',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    created_at: '2026-10-01T09:15:00.123+00:00',
    status: 'sent',
    currency: 'SEK',
    total: 1250.5,
    is_credit_note: false,
    our_reference: 'Anna Andersson',
    notes: 'Tack för beställningen',
    customer_id: CUSTOMER_ID,
    customer: {
      id: CUSTOMER_ID,
      name: 'Anna Andersson',
      email: 'anna@example.se',
      phone: '0701234567',
      address_line1: 'Storgatan 1',
      postal_code: '12345',
      city: 'Stockholm',
      country: 'SE',
      org_number: '5566778899',
      personal_number: '198001011234',
      birth_date: '1980-01-01',
      customer_type: 'individual',
      default_payment_terms: 30,
      invoice_email_cc_addresses: ['ekonomi@example.se', 'Bo Berg <bo@example.se>'],
    },
    items: [
      { description: 'Konsulttimmar', quantity: 2, unit: 'tim', unit_price: 500, account_number: '3001', vat_treatment: 'standard_25' },
      { description: 'Resa', quantity: 1, unit: 'st', unit_price: 250.5, account_number: 'Bank 1930', vat_treatment: 'Standard 25' },
    ],
    previous_attributes: { status: 'draft', our_reference: 'Bo' },
    counterparty_account: '1234',
    'anna@example.se': 'a key that is an e-mail address',
    'Anna Andersson': true,
  },
}

/** What stays of it: ids, dates, amounts, flags, codes under code keys, BAS accounts under account keys. */
const INVOICE_EVENT_KEPT = {
  userId: USER_ID,
  invoice: {
    id: ID,
    invoice_number: null,
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    created_at: '2026-10-01T09:15:00.123+00:00',
    status: 'sent',
    currency: 'SEK',
    total: 1250.5,
    is_credit_note: false,
    our_reference: null,
    notes: null,
    customer_id: CUSTOMER_ID,
    customer: {
      id: CUSTOMER_ID,
      name: null,
      email: null,
      phone: null,
      address_line1: null,
      postal_code: null,
      city: null,
      country: 'SE',
      org_number: null,
      personal_number: null,
      birth_date: null,
      customer_type: 'individual',
      default_payment_terms: 30,
      invoice_email_cc_addresses: [null, null],
    },
    items: [
      { description: null, quantity: 2, unit: 'tim', unit_price: 500, account_number: '3001', vat_treatment: 'standard_25' },
      { description: null, quantity: 1, unit: 'st', unit_price: 250.5, account_number: null, vat_treatment: null },
    ],
    previous_attributes: { status: 'draft', our_reference: null },
    counterparty_account: null,
  },
}

async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return runAsServiceRole(async (client) => (await client.query(sql, params)).rows as T[])
}

async function removeBatch(limit = 1000): Promise<number> {
  const [{ n }] = await asService<{ n: number }>(`SELECT public.remove_event_personal_details($1) AS n`, [limit])
  return n
}

/** Run batches until none is left: rows other files committed are done first. */
async function drain(): Promise<void> {
  for (let i = 0; i < 100; i++) if ((await removeBatch(10000)) === 0) return
  throw new Error('remove_event_personal_details did not finish')
}

async function insertEvent(params: { userId: string; companyId: string; eventType: string; data: unknown; days: number }): Promise<string> {
  const { rows } = await getPool().query<{ sequence: string }>(
    `INSERT INTO public.event_log (user_id, company_id, event_type, data, created_at)
     VALUES ($1, $2, $3, $4::jsonb, now() - make_interval(days => $5))
     RETURNING sequence`,
    [params.userId, params.companyId, params.eventType, JSON.stringify(params.data), params.days],
  )
  return rows[0]!.sequence
}

async function eventRow(sequence: string): Promise<{ data: unknown; removed: boolean }> {
  const { rows } = await getPool().query<{ data: unknown; removed: boolean }>(
    `SELECT data, personal_details_removed_at IS NOT NULL AS removed FROM public.event_log WHERE sequence = $1`,
    [sequence],
  )
  return rows[0]!
}

async function enqueue(companyId: string, payload: unknown, consumers: string[]): Promise<string> {
  const rows = await asService<{ id: string }>(
    `SELECT public.enqueue_event('invoice.created', $1, $2::jsonb, $3::text[], NULL, NULL) AS id`,
    [companyId, JSON.stringify(payload), consumers],
  )
  return rows[0]!.id
}

async function settle(outboxId: string, status: 'done' | 'dead', days: number): Promise<void> {
  await getPool().query(
    `UPDATE public.event_deliveries
        SET status = $2, done_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END, lease_until = NULL
      WHERE outbox_id = $1`,
    [outboxId, status],
  )
  await ageOutbox(outboxId, days)
}

async function ageOutbox(outboxId: string, days: number): Promise<void> {
  await getPool().query(`UPDATE public.event_outbox SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [
    outboxId,
    days,
  ])
}

async function outboxRow(id: string): Promise<{ payload: unknown; removed: boolean }> {
  const { rows } = await getPool().query<{ payload: unknown; removed: boolean }>(
    `SELECT payload, personal_details_removed_at IS NOT NULL AS removed FROM public.event_outbox WHERE id = $1`,
    [id],
  )
  return rows[0]!
}

let company: { userId: string; companyId: string }

beforeAll(async () => {
  company = await seedCompany()
})

describe('event_data_without_personal_details (pg)', () => {
  it('keeps ids, dates, amounts, flags and codes and removes names, contact details and free text', async () => {
    const [{ kept }] = await asService<{ kept: unknown }>(
      `SELECT public.event_data_without_personal_details($1::jsonb) AS kept`,
      [JSON.stringify(INVOICE_EVENT)],
    )
    expect(kept).toEqual(INVOICE_EVENT_KEPT)
  })

  it('leaves data that names nobody as it was', async () => {
    const plain = { entry: { id: ID, entry_date: '2026-10-01', voucher_number: 7, lines: [{ account_number: '1930', debit_amount: 100, credit_amount: 0 }] } }
    const [{ kept, again }] = await asService<{ kept: unknown; again: unknown }>(
      `SELECT public.event_data_without_personal_details($1::jsonb) AS kept,
              public.event_data_without_personal_details(public.event_data_without_personal_details($1::jsonb)) AS again`,
      [JSON.stringify(plain)],
    )
    expect(kept).toEqual(plain)
    expect(again).toEqual(plain)
  })
})

describe('remove_event_personal_details on event_log (pg)', () => {
  it('takes personal details out of business events past 30 days; newer events and agent telemetry keep theirs', async () => {
    await drain()
    const { userId, companyId } = company
    const old = await insertEvent({ userId, companyId, eventType: 'invoice.created', data: INVOICE_EVENT, days: 31 })
    const ancient = await insertEvent({ userId, companyId, eventType: 'transaction.synced', data: INVOICE_EVENT, days: 400 })
    const recent = await insertEvent({ userId, companyId, eventType: 'invoice.created', data: INVOICE_EVENT, days: 29 })
    const telemetry = await insertEvent({ userId, companyId, eventType: 'mcp.tool_called', data: INVOICE_EVENT, days: 31 })

    expect(await removeBatch()).toBe(2)
    expect(await eventRow(old)).toEqual({ data: INVOICE_EVENT_KEPT, removed: true })
    expect(await eventRow(ancient)).toEqual({ data: INVOICE_EVENT_KEPT, removed: true })
    expect(await eventRow(recent)).toEqual({ data: INVOICE_EVENT, removed: false })
    expect(await eventRow(telemetry)).toEqual({ data: INVOICE_EVENT, removed: false })

    // Done is done: the next night finds nothing.
    expect(await removeBatch()).toBe(0)
  })

  it('does at most p_limit rows of each table per call, oldest first', async () => {
    await drain()
    const { userId, companyId } = company
    const oldest = await insertEvent({ userId, companyId, eventType: 'customer.created', data: INVOICE_EVENT, days: 90 })
    const middle = await insertEvent({ userId, companyId, eventType: 'customer.created', data: INVOICE_EVENT, days: 60 })
    const newest = await insertEvent({ userId, companyId, eventType: 'customer.created', data: INVOICE_EVENT, days: 45 })

    expect(await removeBatch(2)).toBe(2)
    expect((await eventRow(oldest)).removed).toBe(true)
    expect((await eventRow(middle)).removed).toBe(true)
    expect((await eventRow(newest)).removed).toBe(false)
    expect(await removeBatch(2)).toBe(1)
    expect((await eventRow(newest)).removed).toBe(true)
  })

  it('refuses a batch size out of range', async () => {
    await expect(removeBatch(0)).rejects.toMatchObject({ code: '22023' })
    await expect(removeBatch(10001)).rejects.toMatchObject({ code: '22023' })
  })
})

describe('event_log stays append-only (pg)', () => {
  it('allows one update, setting personal_details_removed_at, and writes data itself', async () => {
    const { userId, companyId } = company
    const sequence = await insertEvent({ userId, companyId, eventType: 'invoice.created', data: INVOICE_EVENT, days: 1 })

    await expect(
      getPool().query(`UPDATE public.event_log SET data = '{"forged": true}' WHERE sequence = $1`, [sequence]),
    ).rejects.toMatchObject({ code: '23514' })
    // The marker cannot carry another change with it.
    await expect(
      getPool().query(
        `UPDATE public.event_log SET personal_details_removed_at = now(), data = '{"forged": true}' WHERE sequence = $1`,
        [sequence],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.event_log SET personal_details_removed_at = now(), event_type = 'invoice.paid' WHERE sequence = $1`,
        [sequence],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    expect(await eventRow(sequence)).toEqual({ data: INVOICE_EVENT, removed: false })

    await getPool().query(`UPDATE public.event_log SET personal_details_removed_at = now() WHERE sequence = $1`, [sequence])
    expect(await eventRow(sequence)).toEqual({ data: INVOICE_EVENT_KEPT, removed: true })

    // Once set, nothing changes it, the marker included.
    await expect(
      getPool().query(`UPDATE public.event_log SET personal_details_removed_at = now() WHERE sequence = $1`, [sequence]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.event_log SET personal_details_removed_at = NULL WHERE sequence = $1`, [sequence]),
    ).rejects.toMatchObject({ code: '23514' })

    // Deleting is unchanged: a company's events go with it.
    const { rowCount } = await getPool().query(`DELETE FROM public.event_log WHERE sequence = $1`, [sequence])
    expect(rowCount).toBe(1)
  })
})

describe('remove_event_personal_details on event_outbox (pg)', () => {
  it('takes personal details out of events past 30 days once no delivery is owed', async () => {
    await drain()
    const { companyId } = company
    const done = await enqueue(companyId, INVOICE_EVENT, ['webhooks'])
    await settle(done, 'done', 31)
    const dead = await enqueue(companyId, INVOICE_EVENT, ['webhooks'])
    await settle(dead, 'dead', 31)
    const owed = await enqueue(companyId, INVOICE_EVENT, ['webhooks'])
    await ageOutbox(owed, 40)
    const recent = await enqueue(companyId, INVOICE_EVENT, ['webhooks'])
    await settle(recent, 'done', 29)

    expect(await removeBatch()).toBe(2)
    expect(await outboxRow(done)).toEqual({ payload: INVOICE_EVENT_KEPT, removed: true })
    expect(await outboxRow(dead)).toEqual({ payload: INVOICE_EVENT_KEPT, removed: true })
    // The consumer still runs on the payload.
    expect(await outboxRow(owed)).toEqual({ payload: INVOICE_EVENT, removed: false })
    expect(await outboxRow(recent)).toEqual({ payload: INVOICE_EVENT, removed: false })

    // Once its delivery is done, the next night takes it.
    await settle(owed, 'done', 40)
    expect(await removeBatch()).toBe(1)
    expect(await outboxRow(owed)).toEqual({ payload: INVOICE_EVENT_KEPT, removed: true })
  })
})

describe('privileges (pg)', () => {
  it('only the service role runs the removal and the projection', async () => {
    const { rows } = await getPool().query<{ role: string; remove: boolean; project: boolean }>(
      `SELECT r AS role,
              has_function_privilege(r, 'public.remove_event_personal_details(integer)', 'EXECUTE') AS remove,
              has_function_privilege(r, 'public.event_data_without_personal_details(jsonb, text)', 'EXECUTE') AS project
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
        ORDER BY r`,
    )
    expect(rows).toEqual([
      { role: 'anon', remove: false, project: false },
      { role: 'authenticated', remove: false, project: false },
      { role: 'service_role', remove: true, project: true },
    ])
  })
})
