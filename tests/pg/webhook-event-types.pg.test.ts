import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Migration 20261016001000_webhooks_event_types: a subscription lists one or
// more event types in webhooks.event_types; webhooks.event_type stays and
// always names a listed type. The webhooks_sync_event_types trigger keeps the
// two consistent for writers that know only one of them, and the CHECKs
// refuse a contradiction instead of guessing.

interface TypesRow {
  event_type: string
  event_types: string[]
}

async function insertWebhook(
  companyId: string,
  fields: { event_type?: string; event_types?: string[] | null },
): Promise<string> {
  const id = randomUUID()
  const columns = ['id', 'company_id', 'name', 'webhook_url', 'secret', ...Object.keys(fields)]
  const values = [
    id,
    companyId,
    'pg-test',
    'https://example.com/hook',
    `whsec_${randomUUID().replace(/-/g, '')}`,
    ...Object.values(fields),
  ]
  await getPool().query(
    `INSERT INTO public.webhooks (${columns.join(', ')})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  )
  return id
}

async function readTypes(id: string): Promise<TypesRow> {
  const { rows } = await getPool().query<TypesRow>(
    `SELECT event_type, event_types FROM public.webhooks WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('webhooks.event_types: writers that know one column', () => {
  it('a legacy insert with only event_type gets a one-entry list', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, { event_type: 'invoice.paid' })
    expect(await readTypes(id)).toEqual({ event_type: 'invoice.paid', event_types: ['invoice.paid'] })
  })

  it('an insert with only event_types gets event_type = the first entry', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, {
      event_types: ['journal_entry.committed', 'invoice.paid'],
    })
    expect(await readTypes(id)).toEqual({
      event_type: 'journal_entry.committed',
      event_types: ['journal_entry.committed', 'invoice.paid'],
    })
  })

  it('an empty list is filled from event_type', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, { event_type: 'period.locked', event_types: [] })
    expect(await readTypes(id)).toEqual({ event_type: 'period.locked', event_types: ['period.locked'] })
  })

  it('a legacy update of only event_type moves the list with it', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, { event_types: ['invoice.paid', 'invoice.sent'] })
    await getPool().query(`UPDATE public.webhooks SET event_type = 'customer.created' WHERE id = $1`, [id])
    expect(await readTypes(id)).toEqual({ event_type: 'customer.created', event_types: ['customer.created'] })
  })

  it('replacing the list without the current event_type moves event_type to the new first entry', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, { event_types: ['invoice.paid', 'invoice.sent'] })
    await getPool().query(
      `UPDATE public.webhooks SET event_types = ARRAY['period.locked', 'period.unlocked'] WHERE id = $1`,
      [id],
    )
    expect(await readTypes(id)).toEqual({
      event_type: 'period.locked',
      event_types: ['period.locked', 'period.unlocked'],
    })
  })

  it('replacing the list with one that still holds event_type keeps it', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, { event_types: ['invoice.paid'] })
    await getPool().query(
      `UPDATE public.webhooks SET event_types = ARRAY['credit_note.created', 'invoice.paid'] WHERE id = $1`,
      [id],
    )
    expect(await readTypes(id)).toEqual({
      event_type: 'invoice.paid',
      event_types: ['credit_note.created', 'invoice.paid'],
    })
  })

  it('the service role (the v1 routes) writes both columns', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId, { event_type: 'invoice.paid' })
    await runAsServiceRole((client) =>
      client.query(
        `UPDATE public.webhooks SET event_type = 'agi.generated', event_types = ARRAY['agi.generated', 'salary_run.booked']
          WHERE id = $1`,
        [id],
      ),
    )
    expect(await readTypes(id)).toEqual({
      event_type: 'agi.generated',
      event_types: ['agi.generated', 'salary_run.booked'],
    })
  })
})

describe('webhooks.event_types: shape guarantees', () => {
  it('refuses an event_type that is not listed when both are set', async () => {
    const { companyId } = await seedCompany()
    await expect(
      insertWebhook(companyId, { event_type: 'invoice.paid', event_types: ['period.locked'] }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'webhooks_event_type_listed' })
  })

  it('refuses a NULL inside the list', async () => {
    const { companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.webhooks (company_id, name, webhook_url, secret, event_types)
         VALUES ($1, 'pg-test', 'https://example.com/hook', 'whsec_x', ARRAY['invoice.paid', NULL])`,
        [companyId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'webhooks_event_types_no_null' })
  })

  it('refuses a row with neither column', async () => {
    const { companyId } = await seedCompany()
    await expect(insertWebhook(companyId, {})).rejects.toMatchObject({ code: '23502' })
  })

  it('end users can read the new column, like every other non-credential column', async () => {
    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT has_column_privilege('authenticated', 'public.webhooks'::regclass, 'event_types', 'SELECT') AS ok`,
    )
    expect(rows[0].ok).toBe(true)
  })
})

describe('webhooks.event_types: the dispatch lookup', () => {
  it('matches a webhook on any listed type, and not on an unlisted one', async () => {
    const { companyId } = await seedCompany()
    const multi = await insertWebhook(companyId, { event_types: ['invoice.paid', 'journal_entry.committed'] })
    const legacy = await insertWebhook(companyId, { event_type: 'journal_entry.committed' })

    // The filter lib/webhooks/handler.ts sends: event_types=cs.{<type>}.
    const match = async (eventType: string) => {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM public.webhooks
          WHERE company_id = $1 AND event_types @> ARRAY[$2]::text[] AND active AND disabled_at IS NULL
          ORDER BY id`,
        [companyId, eventType],
      )
      return rows.map((r) => r.id).sort()
    }

    expect(await match('journal_entry.committed')).toEqual([multi, legacy].sort())
    expect(await match('invoice.paid')).toEqual([multi])
    expect(await match('period.locked')).toEqual([])
  })
})
