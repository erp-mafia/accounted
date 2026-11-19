import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertTransaction, seedCompany } from './fixtures'

/**
 * The request trace id (migration 20261109090000) on pending_operations,
 * business_events and suggestion_log:
 *
 *   - each table takes a W3C trace-id (32 lowercase hex) or NULL, and its
 *     named CHECK refuses anything else (uppercase, wrong length, non-hex);
 *   - a member's own INSERT may carry it (business_events, suggestion_log:
 *     the table-level grant and the existing policies cover the column);
 *   - the append-only rows keep it as written: UPDATE stays refused;
 *   - each table has the partial (company_id, trace_id) index.
 */

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const MALFORMED = [
  '4BF92F3577B34DA6A3CE929D0E0E4736', // uppercase
  '4bf92f3577b34da6a3ce929d0e0e473', // 31 characters
  '4bf92f3577b34da6a3ce929d0e0e47360', // 33 characters
  '4bf92f3577b34da6a3ce929d0e0e473g', // not hex
  '',
]

const SUGGESTIONS = JSON.stringify([
  { source: 'pending_operation', source_id: 'op', rank: 0, proposal: { operation_type: 'categorize_transaction' }, confidence: null },
])
const FINAL = JSON.stringify({ journal_entry_id: null, account: '5410', vat_treatment: 'standard_25', lines: [] })

let userId: string
let companyId: string
let transactionId: string

beforeAll(async () => {
  ;({ userId, companyId } = await seedCompany())
  transactionId = await insertTransaction({ companyId, userId })
})

async function stage(traceId: string | null): Promise<string> {
  // Staging runs on the service role: pending_operations has no member INSERT.
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params, trace_id)
     VALUES ($1, $2, 'create_supplier', 'Skapa leverantör', '{}', $3)
     RETURNING id`,
    [userId, companyId, traceId],
  )
  return rows[0]!.id
}

const EVENT_SQL = `INSERT INTO public.business_events (id, company_id, kind, occurred_on, trace_id)
  VALUES ($1, $2, 'bank.categorized', '2026-03-14', $3)`

async function recordEvent(traceId: string | null, client: Pool | PoolClient = getPool()): Promise<string> {
  const id = randomUUID()
  await client.query(EVENT_SQL, [id, companyId, traceId])
  return id
}

const RECEIPT_SQL = `INSERT INTO public.suggestion_log
  (company_id, kind, transaction_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, trace_id)
  VALUES ($1, 'bank_line', $2, $3::jsonb, 0, $4::jsonb, 'accepted', 'user', $5, $6)
  RETURNING id`

async function receipt(traceId: string | null, client: Pool | PoolClient = getPool()): Promise<string> {
  const { rows } = await client.query<{ id: string }>(RECEIPT_SQL, [companyId, transactionId, SUGGESTIONS, FINAL, userId, traceId])
  return rows[0]!.id
}

describe('trace_id format (migration 20261109090000)', () => {
  it('pending_operations takes a trace id or NULL and refuses a malformed one', async () => {
    await expect(stage(TRACE_ID)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(stage(null)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    for (const bad of MALFORMED) {
      await expect(stage(bad)).rejects.toThrow(/pending_operations_trace_id_format/)
    }
  })

  it('business_events takes a trace id or NULL and refuses a malformed one', async () => {
    await expect(recordEvent(TRACE_ID)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(recordEvent(null)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    for (const bad of MALFORMED) {
      await expect(recordEvent(bad)).rejects.toThrow(/business_events_trace_id_format/)
    }
  })

  it('suggestion_log takes a trace id or NULL and refuses a malformed one', async () => {
    await expect(receipt(TRACE_ID)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(receipt(null)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    for (const bad of MALFORMED) {
      await expect(receipt(bad)).rejects.toThrow(/suggestion_log_trace_id_format/)
    }
  })
})

describe('trace_id under the existing grants and triggers', () => {
  it('a member records a business event and a receipt with a trace id and reads it back', async () => {
    // withUserContext rolls back at the end: write and read in one scope.
    const read = await withUserContext(userId, async (client) => {
      const eventId = await recordEvent(TRACE_ID, client)
      const receiptId = await receipt(TRACE_ID, client)
      return {
        event: (await client.query<{ trace_id: string }>(`SELECT trace_id FROM public.business_events WHERE id = $1`, [eventId]))
          .rows[0]?.trace_id,
        receipt: (await client.query<{ trace_id: string }>(`SELECT trace_id FROM public.suggestion_log WHERE id = $1`, [receiptId]))
          .rows[0]?.trace_id,
      }
    })
    expect(read).toEqual({ event: TRACE_ID, receipt: TRACE_ID })
  })

  it('the append-only rows keep their trace id: UPDATE stays refused', async () => {
    const eventId = await recordEvent(TRACE_ID)
    const receiptId = await receipt(null)
    await expect(
      getPool().query(`UPDATE public.business_events SET trace_id = NULL WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/)
    await expect(
      getPool().query(`UPDATE public.suggestion_log SET trace_id = $2 WHERE id = $1`, [receiptId, TRACE_ID]),
    ).rejects.toThrow(/append-only/)
  })

  it('has the partial (company_id, trace_id) index on each table', async () => {
    const { rows } = await getPool().query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_pending_operations_company_trace', 'idx_business_events_company_trace', 'idx_suggestion_log_company_trace')
        ORDER BY indexname`,
    )
    expect(rows.map((r) => r.tablename)).toEqual(['business_events', 'pending_operations', 'suggestion_log'])
    for (const row of rows) {
      expect(row.indexdef).toMatch(/\(company_id, trace_id\)/)
      expect(row.indexdef).toMatch(/WHERE \(?trace_id IS NOT NULL\)?/)
      expect(row.indexdef).not.toMatch(/UNIQUE/i)
    }
  })

  it('a pending operation without a trace id still updates (the NOT VALID check passes NULL)', async () => {
    const operationId = await stage(null)
    const { rows } = await getPool().query<{ title: string; trace_id: string | null }>(
      `UPDATE public.pending_operations SET title = 'Skapa leverantör (ändrad)' WHERE id = $1 RETURNING title, trace_id`,
      [operationId],
    )
    expect(rows).toEqual([{ title: 'Skapa leverantör (ändrad)', trace_id: null }])
  })
})
