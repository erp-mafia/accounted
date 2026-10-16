import { randomUUID } from 'crypto'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertTransaction, seedCompany } from './fixtures'

/**
 * suggestion_log (20261011140008): one row per bookkeeping decision. Members
 * read their own company's rows and record their own decisions, viewers and
 * strangers cannot write, nobody can change a row, and a row leaves only
 * with the bank line, inbox item, document or company it describes. An
 * approved staged operation is a decision too (kind 'operation',
 * 20261016150000), named by its pending_operation_id.
 */

const SUGGESTIONS = JSON.stringify([
  { source: 'assistant', rank: 0, proposal: { account: '5410', vat_treatment: 'standard_25' }, confidence: 0.8 },
  { source: 'rule', rank: 1, proposal: { account: '6110', vat_treatment: 'standard_25' } },
])
const FINAL = JSON.stringify({ account: '5410', vat_treatment: 'standard_25' })

async function insertDecision(
  client: Pool | PoolClient,
  params: { companyId: string; transactionId: string; resolvedBy: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.suggestion_log
       (company_id, kind, transaction_id, suggestions, acted_on, final, outcome, actor_type, resolved_by)
     VALUES ($1, 'bank_line', $2, $3::jsonb, 0, $4::jsonb, 'accepted', 'user', $5)
     RETURNING id`,
    [params.companyId, params.transactionId, SUGGESTIONS, FINAL, params.resolvedBy],
  )
  return rows[0]!.id
}

async function rowExists(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`SELECT 1 FROM public.suggestion_log WHERE id = $1`, [id])
  return rowCount === 1
}

describe('suggestion_log', () => {
  let userId: string
  let companyId: string
  let viewerId: string
  let strangerId: string
  let transactionId: string
  let decisionId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    strangerId = await insertAuthUser()
    transactionId = await insertTransaction({ companyId, userId })
    decisionId = await insertDecision(getPool(), { companyId, transactionId, resolvedBy: userId })
  })

  it('lets a member record their own decision and read it back', async () => {
    const recorded = await withUserContext(userId, async (client) => {
      const id = await insertDecision(client, { companyId, transactionId, resolvedBy: userId })
      return (await client.query(`SELECT outcome, acted_on FROM public.suggestion_log WHERE id = $1`, [id])).rows
    })
    expect(recorded).toEqual([{ outcome: 'accepted', acted_on: 0 }])
  })

  it('shows a viewer the company rows and a stranger nothing', async () => {
    const viewer = await withUserContext(viewerId, async (client) =>
      (await client.query(`SELECT 1 FROM public.suggestion_log WHERE id = $1`, [decisionId])).rowCount,
    )
    expect(viewer).toBe(1)
    const stranger = await withUserContext(strangerId, async (client) =>
      (await client.query(`SELECT 1 FROM public.suggestion_log WHERE id = $1`, [decisionId])).rowCount,
    )
    expect(stranger).toBe(0)
  })

  it("refuses a decision recorded in another user's name, or by a viewer or a stranger", async () => {
    await expect(
      withUserContext(userId, (client) => insertDecision(client, { companyId, transactionId, resolvedBy: viewerId })),
    ).rejects.toThrow(/row-level security/)
    await expect(
      withUserContext(viewerId, (client) => insertDecision(client, { companyId, transactionId, resolvedBy: viewerId })),
    ).rejects.toThrow(/row-level security/)
    await expect(
      withUserContext(strangerId, (client) => insertDecision(client, { companyId, transactionId, resolvedBy: strangerId })),
    ).rejects.toThrow(/row-level security/)
  })

  it('gives members no UPDATE or DELETE privilege', async () => {
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.suggestion_log SET outcome = 'changed' WHERE id = $1`, [decisionId]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (client) => client.query(`DELETE FROM public.suggestion_log WHERE id = $1`, [decisionId])),
    ).rejects.toThrow(/permission denied/)
  })

  it('refuses UPDATE and a direct DELETE even for the table owner', async () => {
    await expect(
      getPool().query(`UPDATE public.suggestion_log SET outcome = 'changed' WHERE id = $1`, [decisionId]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.suggestion_log WHERE id = $1`, [decisionId])).rejects.toThrow(
      /append-only/,
    )
    expect(await rowExists(decisionId)).toBe(true)
  })

  it('still refuses UPDATE under gnubok.allow_delete, but lets a DELETE through', async () => {
    const id = await insertDecision(getPool(), { companyId, transactionId, resolvedBy: userId })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await expect(
        client.query(`UPDATE public.suggestion_log SET outcome = 'changed' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.suggestion_log WHERE id = $1`, [id])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    expect(await rowExists(id)).toBe(false)
  })

  it('goes with the bank line it describes', async () => {
    const dismissed = await insertTransaction({ companyId, userId, description: 'Avfärdad rad' })
    const id = await insertDecision(getPool(), { companyId, transactionId: dismissed, resolvedBy: userId })
    await getPool().query(`DELETE FROM public.transactions WHERE id = $1`, [dismissed])
    expect(await rowExists(id)).toBe(false)
  })

  it('checks the row shape', async () => {
    const insert = (columns: string, values: string, params: unknown[]) =>
      getPool().query(
        `INSERT INTO public.suggestion_log (company_id, kind, actor_type, ${columns})
         VALUES ($1, 'bank_line', 'user', ${values})`,
        [companyId, ...params],
      )
    // A bank-line decision names its bank line.
    await expect(insert(`outcome, final`, `'manual', $2::jsonb`, [FINAL])).rejects.toThrow(/suggestion_log_subject/)
    // acted_on is set exactly for accepted and changed, and points into the list.
    await expect(
      insert(`transaction_id, outcome, final`, `$2, 'accepted', $3::jsonb`, [transactionId, FINAL]),
    ).rejects.toThrow(/suggestion_log_acted_on/)
    await expect(
      insert(`transaction_id, suggestions, acted_on, outcome, final`, `$2, $3::jsonb, 2, 'changed', $4::jsonb`, [
        transactionId,
        SUGGESTIONS,
        FINAL,
      ]),
    ).rejects.toThrow(/suggestion_log_acted_on/)
    await expect(
      insert(`transaction_id, suggestions, outcome, final`, `$2, '{}'::jsonb, 'manual', $3::jsonb`, [
        transactionId,
        FINAL,
      ]),
    ).rejects.toThrow(/suggestion_log_acted_on/)
    // Only a dismissal has nothing booked.
    await expect(insert(`transaction_id, outcome`, `$2, 'manual'`, [transactionId])).rejects.toThrow(
      /suggestion_log_final/,
    )
    await expect(
      insert(`transaction_id, outcome, final`, `$2, 'dismissed', $3::jsonb`, [transactionId, FINAL]),
    ).rejects.toThrow(/suggestion_log_final/)
    const { rowCount } = await insert(`transaction_id, outcome`, `$2, 'dismissed'`, [transactionId])
    expect(rowCount).toBe(1)
  })

  it('records an approved staged operation as a decision whose subject is the operation', async () => {
    const operationId = randomUUID()
    const suggestions = JSON.stringify([
      { source: 'pending_operation', source_id: operationId, rank: 0, proposal: { operation_type: 'create_voucher', risk_level: 'medium' }, matches_final: true },
    ])
    const final = JSON.stringify({ journal_entry_id: randomUUID(), operation_type: 'create_voucher' })
    const insertOperation = (client: Pool | PoolClient, pendingOperationId: string | null) =>
      client.query<{ id: string }>(
        `INSERT INTO public.suggestion_log
           (company_id, kind, pending_operation_id, suggestions, acted_on, final, outcome, actor_type, resolved_by,
            policy_version, confidence_band, input_hash)
         VALUES ($1, 'operation', $2, $3::jsonb, 0, $4::jsonb, 'accepted', 'user', $5,
                 'staged-approval.1;approver=person', 'review', $6)
         RETURNING id`,
        [companyId, pendingOperationId, suggestions, final, userId, 'b'.repeat(64)],
      )

    // A member records the approval they made, and reads it back: no bank
    // line, inbox item or document, the operation is the subject.
    const recorded = await withUserContext(userId, async (client) => {
      const { rows } = await insertOperation(client, operationId)
      return (
        await client.query(
          `SELECT kind, pending_operation_id, transaction_id, inbox_item_id, document_id, confidence_band
             FROM public.suggestion_log WHERE id = $1`,
          [rows[0]!.id],
        )
      ).rows
    })
    expect(recorded).toEqual([
      { kind: 'operation', pending_operation_id: operationId, transaction_id: null, inbox_item_id: null, document_id: null, confidence_band: 'review' },
    ])

    // Without the operation it names nothing.
    await expect(insertOperation(getPool(), null)).rejects.toThrow(/suggestion_log_subject/)
    // A kind outside the vocabulary is refused.
    await expect(
      getPool().query(
        `INSERT INTO public.suggestion_log (company_id, kind, pending_operation_id, outcome, actor_type)
         VALUES ($1, 'voucher', $2, 'dismissed', 'user')`,
        [companyId, operationId],
      ),
    ).rejects.toThrow(/suggestion_log_kind_check/)
    // The bank-line and underlag subjects are unchanged: an operation id does not stand in for them.
    await expect(
      getPool().query(
        `INSERT INTO public.suggestion_log (company_id, kind, pending_operation_id, outcome, actor_type)
         VALUES ($1, 'bank_line', $2, 'dismissed', 'user')`,
        [companyId, operationId],
      ),
    ).rejects.toThrow(/suggestion_log_subject/)
    await expect(
      getPool().query(
        `INSERT INTO public.suggestion_log (company_id, kind, pending_operation_id, outcome, actor_type)
         VALUES ($1, 'inbox_item', $2, 'dismissed', 'user')`,
        [companyId, operationId],
      ),
    ).rejects.toThrow(/suggestion_log_subject/)
  })

  it('refuses an actor outside the commit vocabulary', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.suggestion_log (id, company_id, kind, transaction_id, outcome, actor_type)
         VALUES ($1, $2, 'bank_line', $3, 'dismissed', 'robot')`,
        [randomUUID(), companyId, transactionId],
      ),
    ).rejects.toThrow(/actor_type/)
  })
})
