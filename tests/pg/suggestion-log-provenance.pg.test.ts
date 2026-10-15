import { randomUUID } from 'crypto'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertTransaction, seedCompany } from './fixtures'

/**
 * suggestion_log decision provenance (20261016003000): the rules version,
 * policy version, inputs hash, guards and confidence band a decision was made
 * under are written in the same insert as the rest of the row, checked for
 * shape, and as unchangeable afterwards as every other column.
 */

const SUGGESTIONS = JSON.stringify([
  { source: 'rule', source_id: 'rule:r1', rank: 0, proposal: { debit_account: '5410', credit_account: '1930' }, confidence: 0.92 },
])
const FINAL = JSON.stringify({ journal_entry_id: null, account: '5410', vat_treatment: 'standard_25', lines: [] })
const HASH = 'a'.repeat(64)
const POLICY = 'direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none'
const CHECKS = JSON.stringify([
  { id: 'already_booked', result: 'pass', detail: null },
  { id: 'duplicate', result: 'warn', detail: 'force:journal_entry:x' },
])

interface Provenance {
  rule_version?: string | null
  policy_version?: string | null
  input_hash?: string | null
  checks?: string | null
  confidence_band?: string | null
  pending_operation_id?: string | null
  acted_on?: number | null
  outcome?: string
}

async function insertDecision(
  client: Pool | PoolClient,
  params: { companyId: string; transactionId: string; resolvedBy: string } & Provenance,
): Promise<string> {
  const actedOn = params.acted_on === undefined ? 0 : params.acted_on
  const outcome = params.outcome ?? (actedOn === null ? 'manual' : 'accepted')
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.suggestion_log
       (company_id, kind, transaction_id, suggestions, acted_on, final, outcome, actor_type, resolved_by,
        rule_version, policy_version, input_hash, checks, confidence_band, pending_operation_id)
     VALUES ($1, 'bank_line', $2, $3::jsonb, $4, $5::jsonb, $6, 'user', $7, $8, $9, $10, $11::jsonb, $12, $13)
     RETURNING id`,
    [
      params.companyId,
      params.transactionId,
      SUGGESTIONS,
      actedOn,
      FINAL,
      outcome,
      params.resolvedBy,
      params.rule_version ?? null,
      params.policy_version ?? null,
      params.input_hash ?? null,
      params.checks ?? null,
      params.confidence_band ?? null,
      params.pending_operation_id ?? null,
    ],
  )
  return rows[0]!.id
}

describe('suggestion_log decision provenance', () => {
  let userId: string
  let companyId: string
  let transactionId: string
  let full: (overrides?: Provenance) => Promise<string>

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    transactionId = await insertTransaction({ companyId, userId })
    full = (overrides = {}) =>
      insertDecision(getPool(), {
        companyId,
        transactionId,
        resolvedBy: userId,
        rule_version: 'bank-proposals.1+a38016f12abc',
        policy_version: POLICY,
        input_hash: HASH,
        checks: CHECKS,
        confidence_band: 'direct',
        pending_operation_id: randomUUID(),
        ...overrides,
      })
  })

  it('lets a member record the whole provenance in the insert and read it back', async () => {
    const operationId = randomUUID()
    const row = await withUserContext(userId, async (client) => {
      const id = await insertDecision(client, {
        companyId,
        transactionId,
        resolvedBy: userId,
        rule_version: 'bank-proposals.1+a38016f12abc',
        policy_version: POLICY,
        input_hash: HASH,
        checks: CHECKS,
        confidence_band: 'review',
        pending_operation_id: operationId,
      })
      return (
        await client.query(
          `SELECT rule_version, policy_version, input_hash, checks, confidence_band, pending_operation_id
             FROM public.suggestion_log WHERE id = $1`,
          [id],
        )
      ).rows[0]
    })
    expect(row).toEqual({
      rule_version: 'bank-proposals.1+a38016f12abc',
      policy_version: POLICY,
      input_hash: HASH,
      checks: JSON.parse(CHECKS),
      confidence_band: 'review',
      pending_operation_id: operationId,
    })
  })

  it('keeps accepting a row without any of it: older writers and dismissals', async () => {
    const id = await insertDecision(getPool(), { companyId, transactionId, resolvedBy: userId, acted_on: null })
    const { rows } = await getPool().query(
      `SELECT rule_version, policy_version, input_hash, checks, confidence_band, pending_operation_id
         FROM public.suggestion_log WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({
      rule_version: null,
      policy_version: null,
      input_hash: null,
      checks: null,
      confidence_band: null,
      pending_operation_id: null,
    })
  })

  it('names any operation: no foreign key ties the decision to the pending_operations row', async () => {
    await expect(full({ pending_operation_id: randomUUID() })).resolves.toMatch(/^[0-9a-f-]{36}$/)
  })

  it('takes an inputs hash only as 64 lowercase hex characters', async () => {
    await expect(full({ input_hash: 'A'.repeat(64) })).rejects.toThrow(/suggestion_log_input_hash/)
    await expect(full({ input_hash: 'a'.repeat(63) })).rejects.toThrow(/suggestion_log_input_hash/)
    await expect(full({ input_hash: `sha256:${'a'.repeat(57)}` })).rejects.toThrow(/suggestion_log_input_hash/)
  })

  it('takes checks only as a list of {id, result} with a known result', async () => {
    await expect(full({ checks: '[]' })).resolves.toBeTruthy()
    await expect(full({ checks: '{"id":"chart","result":"pass"}' })).rejects.toThrow(/suggestion_log_checks/)
    await expect(full({ checks: '[{"result":"pass"}]' })).rejects.toThrow(/suggestion_log_checks/)
    await expect(full({ checks: '[{"id":"chart","result":"maybe"}]' })).rejects.toThrow(/suggestion_log_checks/)
    await expect(full({ checks: '[{"id":7,"result":"pass"}]' })).rejects.toThrow(/suggestion_log_checks/)
    await expect(full({ checks: '["chart"]' })).rejects.toThrow(/suggestion_log_checks/)
  })

  it('takes a confidence band only from the vocabulary, for an acted-on suggestion, under a policy', async () => {
    await expect(full({ confidence_band: 'auto' })).rejects.toThrow(/suggestion_log_confidence_band/)
    await expect(full({ confidence_band: 'direct', acted_on: null })).rejects.toThrow(/suggestion_log_confidence_band/)
    await expect(full({ confidence_band: 'direct', policy_version: null })).rejects.toThrow(/suggestion_log_confidence_band/)
    // A policy without a band is fine (nothing was acted on).
    await expect(full({ confidence_band: null, acted_on: null })).resolves.toBeTruthy()
  })

  it('refuses to change any of it afterwards, even for the table owner', async () => {
    const id = await full()
    for (const assignment of [
      `rule_version = 'bank-proposals.2'`,
      `policy_version = NULL`,
      `input_hash = '${'b'.repeat(64)}'`,
      `checks = '[]'::jsonb`,
      `confidence_band = 'review'`,
      `pending_operation_id = NULL`,
    ]) {
      await expect(getPool().query(`UPDATE public.suggestion_log SET ${assignment} WHERE id = $1`, [id])).rejects.toThrow(
        /append-only/,
      )
    }
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.suggestion_log SET confidence_band = 'review' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/permission denied/)
  })
})
