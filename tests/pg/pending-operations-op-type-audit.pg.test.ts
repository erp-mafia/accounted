import { readFileSync } from 'fs'
import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Audit: every operation type the codebase can stage must be accepted by the
 * pending_operations_operation_type_check constraint.
 *
 * Guards against the bug class where an MCP tool ships with its executor and
 * risk tier but without the constraint-expansion migration: the staging
 * INSERT then fails with check_violation on every real call while dry_run
 * (which skips the INSERT) previews clean. That exact gap shipped with
 * gnubok_link_document_to_voucher and went unnoticed until agent feedback
 * (dev_docs/mcp_optimization_plan.md P0-1). It also catches the inverse
 * hazard: expand-types migrations hand-copy the full list, so one authored on
 * a stale branch can silently drop a type added in between.
 *
 * Op types are collected from BOTH code-side sources of truth:
 *  1. literal types passed to stagePendingOperation() in the MCP server
 *  2. keys of OPERATION_RISK_TIERS (imported, not parsed)
 * and the PendingOperationType union in src/types is checked against the
 * constraint's definition itself.
 */

const SERVER_TS = resolve(__dirname, '../../src/extensions/general/mcp-server/server.ts')
const TYPES_TS = resolve(__dirname, '../../src/types/index.ts')

/** Every literal of the PendingOperationType union in src/types/index.ts. */
function extractPendingOperationTypeUnion(): string[] {
  const src = readFileSync(TYPES_TS, 'utf8')
  const start = src.indexOf('export type PendingOperationType =')
  const end = src.indexOf('\nexport ', start + 1)
  const body = src.slice(start, end).replace(/\/\/[^\n]*/g, '')
  return [...body.matchAll(/\|\s*'([a-z0-9_]+)'/g)].map((m) => m[1])
}

// Matches `stagePendingOperation(<client>, <companyId>, <userId>, '<op_type>'`
// across line breaks. If the staging signature changes, the call-site count
// assertion below fails loudly: update this regex together with the signature.
const STAGE_CALL_RE = /stagePendingOperation\(\s*[\w.]+,\s*[\w.]+,\s*[\w.]+,\s*'([a-z_]+)'/g

function extractStagedOpTypes(): { types: Set<string>; callSites: number } {
  const src = readFileSync(SERVER_TS, 'utf8')
  const types = new Set<string>()
  let callSites = 0
  for (const match of src.matchAll(STAGE_CALL_RE)) {
    types.add(match[1])
    callSites++
  }
  return { types, callSites }
}

describe('pending_operations operation_type CHECK audit', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('extraction still matches the staging call sites', () => {
    const { types, callSites } = extractStagedOpTypes()
    // 44 call sites / 43 distinct types as of 2026-07-03. The floor is a
    // canary: a big drop means the regex no longer matches the code shape,
    // not that tools were removed.
    expect(callSites).toBeGreaterThanOrEqual(40)
    expect(types.size).toBeGreaterThanOrEqual(40)
  })

  it('accepts every op type staged in code or tiered in risk-tiers', async () => {
    const { types: staged } = extractStagedOpTypes()
    const union = new Set([...staged, ...Object.keys(OPERATION_RISK_TIERS)])

    const rejected: string[] = []
    const client = await getPool().connect()
    try {
      for (const opType of union) {
        await client.query('BEGIN')
        try {
          await client.query(
            `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
             VALUES ($1, $2, $3, $4)`,
            [userId, companyId, opType, `op-type audit: ${opType}`],
          )
        } catch (err) {
          rejected.push(`${opType}: ${(err as Error).message}`)
        } finally {
          await client.query('ROLLBACK')
        }
      }
    } finally {
      client.release()
    }

    expect(
      rejected,
      `op types staged in code but rejected by pending_operations constraints: ` +
        `add them to pending_operations_operation_type_check in a new migration:\n${rejected.join('\n')}`,
    ).toEqual([])
  })

  it('the final CHECK holds every PendingOperationType in src/types (a rebuilt list never drops one)', async () => {
    const types = extractPendingOperationTypeUnion()
    // A floor, as above: a big drop means the parse no longer matches the union.
    expect(types.length).toBeGreaterThanOrEqual(150)
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.pending_operations'::regclass
          AND conname = 'pending_operations_operation_type_check'`,
    )
    expect(rows).toHaveLength(1)
    const allowed = new Set([...rows[0].def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]))
    // Values main and this stack added in parallel: a rebuild from a stale list drops them first.
    for (const type of ['cancel_draft_entry', 'mark_agi_period_filed', 'open_collection_case', 'collection_case_action']) {
      expect(types).toContain(type)
    }
    const missing = types.filter((type) => !allowed.has(type))
    expect(
      missing,
      `PendingOperationType values the final pending_operations_operation_type_check rejects: ` +
        `a later migration rebuilt the list from a stale copy. Re-state the latest list:\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it('accepts link_document_to_voucher (regression: shipped without constraint expansion)', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'link_document_to_voucher', 'regression: koppla bilaga till verifikat')`,
        [userId, companyId],
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('accepts post_kontantmetod_cutoff for the staged year-end posting flow', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'post_kontantmetod_cutoff', 'kontantmetod cut-off')`,
        [userId, companyId],
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
