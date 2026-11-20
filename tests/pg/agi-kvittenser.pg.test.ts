import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * agi_kvittenser (20261014150000): every AGI kvittens Skatteverket returned,
 * kept. Members read their company's receipts and record new ones, viewers
 * and strangers cannot write, a re-read records nothing twice, a correction's
 * receipt is added beside the original's, nobody can change or remove a row,
 * and a row leaves only with its company.
 */

function receipt(uuidKvittens: string, signeradTid: string) {
  return { uuidKvittens, signeradAv: '191212121212', signeradTid, arbetsgivare: '165561234567', period: '202609' }
}

async function record(
  client: Pool | PoolClient,
  params: { companyId: string; uuidKvittens: string; signeradTid: string; recordedBy?: string },
): Promise<number> {
  // The writers' upsert with ignoreDuplicates is this statement.
  const { rowCount } = await client.query(
    `INSERT INTO public.agi_kvittenser
       (company_id, period_year, period_month, uuid_kvittens, signerad_tid, receipt, recorded_by)
     VALUES ($1, 2026, 9, $2, $3, $4::jsonb, $5)
     ON CONFLICT (company_id, uuid_kvittens) DO NOTHING`,
    [
      params.companyId,
      params.uuidKvittens,
      params.signeradTid,
      JSON.stringify(receipt(params.uuidKvittens, params.signeradTid)),
      params.recordedBy ?? 'interactive',
    ],
  )
  return rowCount ?? 0
}

async function receiptsFor(companyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ uuid_kvittens: string }>(
    `SELECT uuid_kvittens FROM public.agi_kvittenser
      WHERE company_id = $1 AND period_year = 2026 AND period_month = 9
      ORDER BY signerad_tid DESC`,
    [companyId],
  )
  return rows.map((row) => row.uuid_kvittens)
}

describe('agi_kvittenser', () => {
  let userId: string
  let companyId: string
  let viewerId: string
  let strangerId: string
  const original = `kvittens-${randomUUID()}`

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    strangerId = await insertAuthUser()
    await record(getPool(), { companyId, uuidKvittens: original, signeradTid: '2026-10-12T08:00:00Z', recordedBy: 'cron' })
  })

  it('lets a member record a receipt and read the period back', async () => {
    const correction = `kvittens-${randomUUID()}`
    const seen = await withUserContext(userId, async (client) => {
      expect(await record(client, { companyId, uuidKvittens: correction, signeradTid: '2026-10-20T09:00:00Z' })).toBe(1)
      return (
        await client.query<{ uuid_kvittens: string }>(
          `SELECT uuid_kvittens FROM public.agi_kvittenser WHERE company_id = $1 ORDER BY signerad_tid DESC`,
          [companyId],
        )
      ).rows.map((row) => row.uuid_kvittens)
    })
    expect(seen).toEqual([correction, original])
  })

  it("adds a correction's receipt beside the original's and records a re-read once", async () => {
    const correction = `kvittens-${randomUUID()}`
    expect(await record(getPool(), { companyId, uuidKvittens: correction, signeradTid: '2026-10-25T09:00:00Z' })).toBe(1)
    expect(await record(getPool(), { companyId, uuidKvittens: correction, signeradTid: '2026-10-25T09:00:00Z' })).toBe(0)
    expect(await record(getPool(), { companyId, uuidKvittens: original, signeradTid: '2026-10-12T08:00:00Z' })).toBe(0)
    const kept = await receiptsFor(companyId)
    expect(kept[0]).toBe(correction)
    expect(kept).toContain(original)
    expect(kept.filter((id) => id === correction)).toHaveLength(1)
  })

  it('shows a viewer the receipts and a stranger nothing', async () => {
    const viewer = await withUserContext(viewerId, async (client) =>
      (await client.query(`SELECT 1 FROM public.agi_kvittenser WHERE uuid_kvittens = $1`, [original])).rowCount,
    )
    expect(viewer).toBe(1)
    const stranger = await withUserContext(strangerId, async (client) =>
      (await client.query(`SELECT 1 FROM public.agi_kvittenser WHERE uuid_kvittens = $1`, [original])).rowCount,
    )
    expect(stranger).toBe(0)
  })

  it('refuses a receipt recorded by a viewer or a stranger', async () => {
    await expect(
      withUserContext(viewerId, (client) =>
        record(client, { companyId, uuidKvittens: `kvittens-${randomUUID()}`, signeradTid: '2026-10-21T09:00:00Z' }),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      withUserContext(strangerId, (client) =>
        record(client, { companyId, uuidKvittens: `kvittens-${randomUUID()}`, signeradTid: '2026-10-21T09:00:00Z' }),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('gives members no UPDATE or DELETE privilege', async () => {
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.agi_kvittenser SET signerad_tid = now() WHERE uuid_kvittens = $1`, [original]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (client) => client.query(`DELETE FROM public.agi_kvittenser WHERE uuid_kvittens = $1`, [original])),
    ).rejects.toThrow(/permission denied/)
  })

  it('refuses UPDATE and a direct DELETE even for the table owner', async () => {
    await expect(
      getPool().query(`UPDATE public.agi_kvittenser SET receipt = '{}'::jsonb WHERE uuid_kvittens = $1`, [original]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.agi_kvittenser WHERE uuid_kvittens = $1`, [original])).rejects.toThrow(
      /append-only/,
    )
    expect(await receiptsFor(companyId)).toContain(original)
  })

  it('still refuses UPDATE under gnubok.allow_delete, but lets a DELETE through', async () => {
    const id = `kvittens-${randomUUID()}`
    await record(getPool(), { companyId, uuidKvittens: id, signeradTid: '2026-10-22T09:00:00Z' })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await expect(
        client.query(`UPDATE public.agi_kvittenser SET receipt = '{}'::jsonb WHERE uuid_kvittens = $1`, [id]),
      ).rejects.toThrow(/append-only/)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.agi_kvittenser WHERE uuid_kvittens = $1`, [id])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    expect(await receiptsFor(companyId)).not.toContain(id)
  })

  it("the migration's backfill copies a declaration's receipt once, as stored", async () => {
    const migration = readFileSync(
      resolve(__dirname, '../../supabase/migrations/20261014150000_agi_kvittenser_history.sql'),
      'utf8',
    )
    const backfill = migration.match(/INSERT INTO public\.agi_kvittenser[\s\S]*?DO NOTHING;/)?.[0]
    expect(backfill).toBeDefined()
    const c = await seedCompany()
    const kvittensnummer = `kvittens-${randomUUID()}`
    const responseData = {
      signeradAv: '191212121212',
      signeradTid: '2026-03-12T07:45:00Z',
      submittedAtEstimated: false,
      uuidKvittens: kvittensnummer,
      reconciledBy: 'cron',
    }
    await getPool().query(
      `INSERT INTO public.agi_declarations
         (company_id, user_id, period_year, period_month, xml_content, status, individuppgifter,
          kvittensnummer, submitted_at, response_data)
       VALUES ($1, $2, 2026, 2, '<xml/>', 'submitted', '[]'::jsonb, $3, '2026-03-12T07:45:00Z', $4::jsonb)`,
      [c.companyId, c.userId, kvittensnummer, JSON.stringify(responseData)],
    )
    // An unfiled declaration has nothing to copy.
    await getPool().query(
      `INSERT INTO public.agi_declarations (company_id, user_id, period_year, period_month, xml_content, individuppgifter)
       VALUES ($1, $2, 2026, 3, '<xml/>', '[]'::jsonb)`,
      [c.companyId, c.userId],
    )

    await getPool().query(backfill!)
    await getPool().query(backfill!)

    const { rows } = await getPool().query(
      `SELECT period_year, period_month, uuid_kvittens, signerad_tid, receipt, recorded_by
         FROM public.agi_kvittenser WHERE company_id = $1`,
      [c.companyId],
    )
    expect(rows).toEqual([
      {
        period_year: 2026,
        period_month: 2,
        uuid_kvittens: kvittensnummer,
        signerad_tid: new Date('2026-03-12T07:45:00Z'),
        receipt: responseData,
        recorded_by: 'backfill',
      },
    ])
  })

  it('checks the row shape', async () => {
    const insert = (uuidKvittens: string, receiptJson: string, recordedBy: string, month = 9) =>
      getPool().query(
        `INSERT INTO public.agi_kvittenser (company_id, period_year, period_month, uuid_kvittens, receipt, recorded_by)
         VALUES ($1, 2026, $2, $3, $4::jsonb, $5)`,
        [companyId, month, uuidKvittens, receiptJson, recordedBy],
      )
    await expect(insert('', '{}', 'cron')).rejects.toThrow(/check constraint/)
    await expect(insert(`kvittens-${randomUUID()}`, '[]', 'cron')).rejects.toThrow(/check constraint/)
    await expect(insert(`kvittens-${randomUUID()}`, '{}', 'someone')).rejects.toThrow(/check constraint/)
    await expect(insert(`kvittens-${randomUUID()}`, '{}', 'cron', 13)).rejects.toThrow(/check constraint/)
  })
})
