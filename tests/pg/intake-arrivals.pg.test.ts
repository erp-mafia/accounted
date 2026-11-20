import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from './fixtures'

/**
 * arrivals + arrival_outputs (20261016051000): one row per delivery into a
 * company and what it produced. Members read and record their own company's
 * arrivals, strangers see nothing, nobody changes or deletes a row while the
 * company exists, (company, source, source_ref) is the idempotency key, and
 * the company's own deletion takes its arrivals with it.
 */

type Db = Pool | PoolClient

async function insertArrival(
  client: Db,
  params: { companyId: string; sourceRef?: string; source?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.arrivals (company_id, source, source_ref, received_at, sender, subject, fetched_by)
     VALUES ($1, $2, $3, now(), '{"from":"faktura@leverantor.example"}'::jsonb, 'Faktura 1001',
             '{"type":"webhook","label":"resend-inbound"}'::jsonb)
     RETURNING id`,
    [params.companyId, params.source ?? 'intake_email', params.sourceRef ?? `em_${randomUUID()}`],
  )
  return rows[0]!.id
}

async function insertOutput(
  client: Db,
  params: { arrivalId: string; companyId: string; outputId?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.arrival_outputs (arrival_id, company_id, output_kind, output_id, role)
     VALUES ($1, $2, 'document', $3, 'attachment')
     RETURNING id`,
    [params.arrivalId, params.companyId, params.outputId ?? randomUUID()],
  )
  return rows[0]!.id
}

async function count(table: 'arrivals' | 'arrival_outputs', id: string): Promise<number> {
  const { rowCount } = await getPool().query(`SELECT 1 FROM public.${table} WHERE id = $1`, [id])
  return rowCount ?? 0
}

describe('intake arrivals (pg)', () => {
  let userA: string
  let companyA: string
  let userB: string
  let companyB: string
  let arrivalA: string
  let outputA: string

  beforeAll(async () => {
    ;({ userId: userA, companyId: companyA } = await seedCompany())
    ;({ userId: userB, companyId: companyB } = await seedCompany())
    arrivalA = await insertArrival(getPool(), { companyId: companyA })
    outputA = await insertOutput(getPool(), { arrivalId: arrivalA, companyId: companyA })
  })

  it('lets a member record an arrival and its output and read them back', async () => {
    const read = await withUserContext(userA, async (client) => {
      const id = await insertArrival(client, { companyId: companyA })
      await insertOutput(client, { arrivalId: id, companyId: companyA })
      const arrival = await client.query(`SELECT source, subject FROM public.arrivals WHERE id = $1`, [id])
      const outputs = await client.query(`SELECT output_kind, role FROM public.arrival_outputs WHERE arrival_id = $1`, [id])
      return { arrival: arrival.rows, outputs: outputs.rows }
    })
    expect(read.arrival).toEqual([{ source: 'intake_email', subject: 'Faktura 1001' }])
    expect(read.outputs).toEqual([{ output_kind: 'document', role: 'attachment' }])
  })

  it("keeps one company's arrivals out of another company's reach", async () => {
    const seenByB = await withUserContext(userB, async (client) => ({
      arrivals: (await client.query(`SELECT 1 FROM public.arrivals WHERE id = $1`, [arrivalA])).rowCount,
      outputs: (await client.query(`SELECT 1 FROM public.arrival_outputs WHERE id = $1`, [outputA])).rowCount,
    }))
    expect(seenByB).toEqual({ arrivals: 0, outputs: 0 })

    const stranger = await insertAuthUser()
    const seenByStranger = await withUserContext(stranger, async (client) =>
      (await client.query(`SELECT 1 FROM public.arrivals WHERE company_id = $1`, [companyA])).rowCount,
    )
    expect(seenByStranger).toBe(0)
  })

  it("refuses an arrival or an output written into another company", async () => {
    await expect(
      withUserContext(userB, (client) => insertArrival(client, { companyId: companyA })),
    ).rejects.toThrow(/row-level security/)
    await expect(
      withUserContext(userB, (client) => insertOutput(client, { arrivalId: arrivalA, companyId: companyA })),
    ).rejects.toThrow(/row-level security/)
  })

  it('refuses an output whose company is not its arrival\'s company', async () => {
    // Even the superuser: the composite key ties an output to its arrival's company.
    await expect(insertOutput(getPool(), { arrivalId: arrivalA, companyId: companyB })).rejects.toThrow(
      /arrival_outputs_arrival_fkey/,
    )
  })

  it('is idempotent on (company, source, source_ref) and on (arrival, kind, output)', async () => {
    const ref = `em_${randomUUID()}`
    const first = await insertArrival(getPool(), { companyId: companyA, sourceRef: ref })
    await expect(insertArrival(getPool(), { companyId: companyA, sourceRef: ref })).rejects.toThrow(
      /arrivals_company_source_ref_key/,
    )
    // ON CONFLICT DO NOTHING is the write path's way of saying "already here".
    const again = await getPool().query(
      `INSERT INTO public.arrivals (company_id, source, source_ref, received_at)
       VALUES ($1, 'intake_email', $2, now())
       ON CONFLICT (company_id, source, source_ref) DO NOTHING RETURNING id`,
      [companyA, ref],
    )
    expect(again.rowCount).toBe(0)
    // The same reference under another source, or in another company, is a different arrival.
    await insertArrival(getPool(), { companyId: companyA, sourceRef: ref, source: 'whatsapp' })
    await insertArrival(getPool(), { companyId: companyB, sourceRef: ref })

    const outputId = randomUUID()
    await insertOutput(getPool(), { arrivalId: first, companyId: companyA, outputId })
    await expect(insertOutput(getPool(), { arrivalId: first, companyId: companyA, outputId })).rejects.toThrow(
      /arrival_outputs_unique/,
    )
  })

  it('refuses every UPDATE and DELETE while the company exists, even for the service role', async () => {
    await expect(
      getPool().query(`UPDATE public.arrivals SET subject = 'Ändrad' WHERE id = $1`, [arrivalA]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.arrivals WHERE id = $1`, [arrivalA])).rejects.toThrow(
      /append-only/,
    )
    await expect(
      getPool().query(`UPDATE public.arrival_outputs SET position = 3 WHERE id = $1`, [outputA]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.arrival_outputs WHERE id = $1`, [outputA])).rejects.toThrow(
      /append-only/,
    )
    await expect(
      runAsServiceRole((client) => client.query(`DELETE FROM public.arrivals WHERE id = $1`, [arrivalA])),
    ).rejects.toThrow(/append-only/)
    expect(await count('arrivals', arrivalA)).toBe(1)
    expect(await count('arrival_outputs', outputA)).toBe(1)
  })

  it('gives a member no UPDATE or DELETE at all', async () => {
    await expect(
      withUserContext(userA, (client) =>
        client.query(`UPDATE public.arrivals SET subject = 'Ändrad' WHERE id = $1`, [arrivalA]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userA, (client) => client.query(`DELETE FROM public.arrivals WHERE id = $1`, [arrivalA])),
    ).rejects.toThrow(/permission denied/)
  })

  it('lets the service role record an arrival (webhooks, crons, MCP)', async () => {
    const id = randomUUID()
    await runAsServiceRole((client) =>
      client.query(
        `INSERT INTO public.arrivals (id, company_id, source, source_ref, received_at, original_path, original_sha256, original_mime, original_size)
         VALUES ($1, $2, 'peppol', $3, now(), $4, $5, 'application/xml', 120)`,
        [id, companyA, `peppol-${id}`, `documents/${companyA}/u/peppol.xml`, 'a'.repeat(64)],
      ),
    )
    expect(await count('arrivals', id)).toBe(1)
  })

  it('checks the row shape', async () => {
    const insert = (columns: string, values: string, params: unknown[]) =>
      getPool().query(
        `INSERT INTO public.arrivals (company_id, source, source_ref, received_at, ${columns})
         VALUES ($1, 'upload', $2, now(), ${values})`,
        [companyA, randomUUID(), ...params],
      )
    // No original metadata without the original.
    await expect(insert('original_sha256', '$3', ['b'.repeat(64)])).rejects.toThrow(/arrivals_original_consistent/)
    await expect(insert('original_path, original_sha256', '$3, $4', ['p', 'NOT-A-HASH'])).rejects.toThrow(
      /original_sha256/,
    )
    await expect(insert('sender', `'[]'::jsonb`, [])).rejects.toThrow(/sender/)
    await expect(
      getPool().query(
        `INSERT INTO public.arrival_outputs (arrival_id, company_id, output_kind, output_id, role)
         VALUES ($1, $2, 'supplier', $3, 'attachment')`,
        [arrivalA, companyA, randomUUID()],
      ),
    ).rejects.toThrow(/output_kind/)
  })

  it("goes with its company: the company's deletion takes arrivals and outputs", async () => {
    const owner = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: company, userId: owner })
    const arrival = await insertArrival(getPool(), { companyId: company })
    const output = await insertOutput(getPool(), { arrivalId: arrival, companyId: company })

    await getPool().query(`DELETE FROM public.companies WHERE id = $1`, [company])

    expect(await count('arrivals', arrival)).toBe(0)
    expect(await count('arrival_outputs', output)).toBe(0)
  })
})
