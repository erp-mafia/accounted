import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertTransaction, seedCompany, setActiveCompany } from './fixtures'

/**
 * One click under the company's and the rule's control (migration
 * 20261030131517, accounted#130 step 1):
 *   - company_settings.direct_booking_enabled defaults on, an owner can turn
 *     it off, a member cannot (the settings policy is owner/admin), and the
 *     change is audited;
 *   - categorization_templates.always_review defaults off, anyone who may
 *     write can set it, a viewer cannot, and the change is a rule change in
 *     the audit trail, unlike the learning columns;
 *   - suggestion_log.review_shown is written in the INSERT and, like every
 *     column of the table, never changed afterwards.
 *
 * withUserContext always rolls back, so a write made as a member is read
 * back, audit row included, inside the same transaction: RESET ROLE drops
 * to the connection's own role there, which reads audit_log whatever its
 * policies say.
 */

let ownerId: string
let companyId: string
let transactionId: string

async function member(role: 'member' | 'viewer'): Promise<string> {
  const userId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId, role })
  await setActiveCompany(userId, companyId)
  return userId
}

async function template(): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.categorization_templates (id, company_id, counterparty_name, debit_account, credit_account, source, occurrence_count)
     VALUES ($1, $2, $3, '6540', '1930', 'sie_import', 140)`,
    [id, companyId, `leverantor ${id.slice(0, 8)}`],
  )
  return id
}

async function auditedAlwaysReview(
  client: Pool | PoolClient,
  templateId: string,
): Promise<Array<{ old: string | null; new: string | null }>> {
  const { rows } = await client.query<{ old: string | null; new: string | null }>(
    `SELECT old_state->>'always_review' AS old, new_state->>'always_review' AS new
       FROM public.audit_log
      WHERE table_name = 'categorization_templates' AND record_id = $1 AND action = 'UPDATE'
      ORDER BY created_at, id`,
    [templateId],
  )
  return rows
}

beforeAll(async () => {
  ;({ userId: ownerId, companyId } = await seedCompany())
  await setActiveCompany(ownerId, companyId)
  await getPool().query(`INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ownerId, companyId])
  transactionId = await insertTransaction({ companyId, userId: ownerId })
})

describe('company_settings.direct_booking_enabled', () => {
  it('is on for a company that never touched it', async () => {
    const { rows } = await getPool().query<{ on: boolean }>(
      `SELECT direct_booking_enabled AS on FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0]!.on).toBe(true)
  })

  it('cannot be switched by a member: the settings row is owner and admin only', async () => {
    const memberId = await member('member')
    const written = await withUserContext(memberId, (client) =>
      client.query(`UPDATE public.company_settings SET direct_booking_enabled = false WHERE company_id = $1 RETURNING company_id`, [companyId]),
    )
    expect(written.rowCount).toBe(0)
  })

  it('is switched off by the owner, and the change is in the audit trail', async () => {
    const { written, audited } = await withUserContext(ownerId, async (client) => {
      const written = await client.query(
        `UPDATE public.company_settings SET direct_booking_enabled = false WHERE company_id = $1 RETURNING direct_booking_enabled`,
        [companyId],
      )
      await client.query('RESET ROLE')
      const audited = await client.query<{ old: string; new: string }>(
        `SELECT old_state->>'direct_booking_enabled' AS old, new_state->>'direct_booking_enabled' AS new
           FROM public.audit_log
          WHERE table_name = 'company_settings' AND company_id = $1 AND action = 'UPDATE'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [companyId],
      )
      return { written: written.rows, audited: audited.rows }
    })
    expect(written).toEqual([{ direct_booking_enabled: false }])
    expect(audited).toEqual([{ old: 'true', new: 'false' }])
  })
})

describe('categorization_templates.always_review', () => {
  it('defaults off, and an imported rule keeps its source until a booking here lifts it', async () => {
    const id = await template()
    const { rows } = await getPool().query<{ always_review: boolean; source: string }>(
      `SELECT always_review, source FROM public.categorization_templates WHERE id = $1`,
      [id],
    )
    expect(rows).toEqual([{ always_review: false, source: 'sie_import' }])
  })

  it('is set by anyone who may write, and logged as a rule change', async () => {
    const id = await template()
    const memberId = await member('member')
    const { written, audited, afterLearning } = await withUserContext(memberId, async (client) => {
      const written = await client.query(
        `UPDATE public.categorization_templates SET always_review = true WHERE id = $1 AND company_id = $2 RETURNING always_review`,
        [id, companyId],
      )
      await client.query('RESET ROLE')
      const audited = await auditedAlwaysReview(client, id)
      // A learning-only write after it adds nothing to the trail.
      await client.query(
        `UPDATE public.categorization_templates SET occurrence_count = occurrence_count + 1, last_seen_date = CURRENT_DATE WHERE id = $1`,
        [id],
      )
      return { written: written.rows, audited, afterLearning: await auditedAlwaysReview(client, id) }
    })
    expect(written).toEqual([{ always_review: true }])
    expect(audited).toEqual([{ old: 'false', new: 'true' }])
    expect(afterLearning).toHaveLength(1)
  })

  it('cannot be set by a viewer', async () => {
    const id = await template()
    const viewerId = await member('viewer')
    const written = await withUserContext(viewerId, (client) =>
      client.query(`UPDATE public.categorization_templates SET always_review = true WHERE id = $1 RETURNING id`, [id]),
    )
    expect(written.rowCount).toBe(0)
    expect(await auditedAlwaysReview(getPool(), id)).toEqual([])
  })
})

describe('suggestion_log.review_shown', () => {
  const SUGGESTIONS = JSON.stringify([{ source: 'counterparty_template', source_id: 'cp:x', rank: 0, proposal: {}, confidence: 0.95 }])
  const FINAL = JSON.stringify({ journal_entry_id: null, account: '6540', vat_treatment: null, lines: [] })

  // Written on the connection's own role so the rows persist for the reads
  // below (withUserContext rolls back); RLS on the insert is not what this pins.
  async function decision(reviewShown: boolean | null): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.suggestion_log
         (company_id, kind, transaction_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, review_shown)
       VALUES ($1, 'bank_line', $2, $3::jsonb, 0, $4::jsonb, 'accepted', 'user', $5, $6)
       RETURNING id`,
      [companyId, transactionId, SUGGESTIONS, FINAL, ownerId, reviewShown],
    )
    return rows[0]!.id
  }

  it('is readable by the company, as the receipts read it', async () => {
    const id = await decision(false)
    const read = await withUserContext(ownerId, (client) =>
      client.query<{ review_shown: boolean | null }>(`SELECT review_shown FROM public.suggestion_log WHERE id = $1`, [id]),
    )
    expect(read.rows).toEqual([{ review_shown: false }])
  })

  it('keeps a one click, a review and an unsaid decision apart', async () => {
    const ids = [await decision(false), await decision(true), await decision(null)]
    const { rows } = await getPool().query<{ id: string; review_shown: boolean | null }>(
      `SELECT id, review_shown FROM public.suggestion_log WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    const byId = new Map(rows.map((r) => [r.id, r.review_shown]))
    expect(ids.map((id) => byId.get(id))).toEqual([false, true, null])
  })

  it('is never changed afterwards: the decision log stays append-only', async () => {
    const id = await decision(false)
    await expect(getPool().query(`UPDATE public.suggestion_log SET review_shown = true WHERE id = $1`, [id])).rejects.toThrow(/append-only/)
  })
})
