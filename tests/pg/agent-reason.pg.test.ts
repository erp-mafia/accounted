import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertTransaction, seedCompany } from './fixtures'

/**
 * The agent's reason on a staged write (migration 20261028210000):
 * pending_operations.agent_reason as staged, the decision receipt's own copy
 * in suggestion_log.agent_reason, and behandlingshistorik_decisions() reading
 * it back. Both columns hold 1 to 500 characters or nothing (the writers trim
 * and cut before they get here, so the CHECK is the backstop); the operation's
 * is fixed once it is decided, the receipt's from the insert on.
 */

const SUGGESTIONS = JSON.stringify([
  { source: 'pending_operation', source_id: 'op', rank: 0, proposal: { operation_type: 'categorize_transaction' }, confidence: null },
])
const FINAL = JSON.stringify({ journal_entry_id: null, account: '5410', vat_treatment: 'standard_25', lines: [] })
const REASON = 'Clas Ohlson every month on 5410; the receipt is attached.'

let userId: string
let companyId: string
let fiscalPeriodId: string
let transactionId: string

beforeAll(async () => {
  ;({ userId, companyId, fiscalPeriodId } = await seedCompany())
  transactionId = await insertTransaction({ companyId, userId })
})

async function stage(client: Pool | PoolClient, agentReason: string | null): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params, agent_reason)
     VALUES ($1, $2, 'create_supplier', 'Skapa leverantör', '{}', $3)
     RETURNING id`,
    [userId, companyId, agentReason],
  )
  return rows[0]!.id
}

async function receipt(client: Pool | PoolClient, agentReason: string | null, pendingOperationId: string | null = null): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.suggestion_log
       (company_id, kind, transaction_id, suggestions, acted_on, final, outcome, actor_type, resolved_by,
        pending_operation_id, agent_reason)
     VALUES ($1, 'bank_line', $2, $3::jsonb, 0, $4::jsonb, 'accepted', 'user', $5, $6, $7)
     RETURNING id`,
    [companyId, transactionId, SUGGESTIONS, FINAL, userId, pendingOperationId, agentReason],
  )
  return rows[0]!.id
}

describe('pending_operations.agent_reason', () => {
  it('takes a reason of up to 500 characters, or none, and refuses an empty or longer one', async () => {
    await expect(stage(getPool(), null)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(stage(getPool(), 'x'.repeat(500))).resolves.toMatch(/^[0-9a-f-]{36}$/)
    // char_length counts characters, not bytes: 500 of a multi-byte one fit.
    await expect(stage(getPool(), 'å'.repeat(500))).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(stage(getPool(), 'x'.repeat(501))).rejects.toThrow(/pending_operations_agent_reason_length/)
    await expect(stage(getPool(), '')).rejects.toThrow(/pending_operations_agent_reason_length/)
  })

  it('lets a member read back the reason the server staged', async () => {
    // Staging runs on the service role: pending_operations has no INSERT policy.
    const id = await stage(getPool(), REASON)
    const reason = await withUserContext(userId, async (client) =>
      (await client.query<{ agent_reason: string }>(`SELECT agent_reason FROM public.pending_operations WHERE id = $1`, [id])).rows[0]!
        .agent_reason,
    )
    expect(reason).toBe(REASON)
  })

  it('keeps the reason as it was once the operation is rejected or committed', async () => {
    for (const status of ['rejected', 'committed']) {
      const id = await stage(getPool(), REASON)
      await getPool().query(`UPDATE public.pending_operations SET status = $2, resolved_at = now() WHERE id = $1`, [id, status])
      await expect(
        getPool().query(`UPDATE public.pending_operations SET agent_reason = 'Something else' WHERE id = $1`, [id]),
      ).rejects.toThrow(/terminal state/)
      const { rows } = await getPool().query<{ agent_reason: string }>(`SELECT agent_reason FROM public.pending_operations WHERE id = $1`, [id])
      expect(rows[0]!.agent_reason).toBe(REASON)
    }
  })
})

describe('suggestion_log.agent_reason', () => {
  it('takes the copy in the insert, up to 500 characters, or none', async () => {
    await expect(receipt(getPool(), null)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(receipt(getPool(), 'x'.repeat(500))).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(receipt(getPool(), 'x'.repeat(501))).rejects.toThrow(/suggestion_log_agent_reason_length/)
    await expect(receipt(getPool(), '')).rejects.toThrow(/suggestion_log_agent_reason_length/)
  })

  it('stays append-only: the reason cannot be changed or added afterwards, even by the table owner', async () => {
    const withReason = await receipt(getPool(), REASON)
    const without = await receipt(getPool(), null)
    await expect(getPool().query(`UPDATE public.suggestion_log SET agent_reason = NULL WHERE id = $1`, [withReason])).rejects.toThrow(
      /append-only/,
    )
    await expect(getPool().query(`UPDATE public.suggestion_log SET agent_reason = 'Later' WHERE id = $1`, [without])).rejects.toThrow(
      /append-only/,
    )
    await expect(
      withUserContext(userId, (client) => client.query(`UPDATE public.suggestion_log SET agent_reason = 'Later' WHERE id = $1`, [without])),
    ).rejects.toThrow(/permission denied/)
  })

  it('reaches the behandlingshistorik: behandlingshistorik_decisions returns it with each decision row', async () => {
    const operationId = await stage(getPool(), REASON)
    const withReason = await receipt(getPool(), REASON, operationId)
    const without = await receipt(getPool(), null)
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const rows = await withUserContext(userId, async (client) => {
      const { rows: result } = await client.query<{ rows: Array<{ id: string; agent_reason: string | null }> }>(
        'SELECT * FROM public.behandlingshistorik_decisions($1, $2, $3, $4, $5)',
        [companyId, fiscalPeriodId, from, to, false],
      )
      return result[0]!.rows
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(withReason)?.agent_reason).toBe(REASON)
    expect(byId.get(without)).toHaveProperty('agent_reason', null)
  })
})
