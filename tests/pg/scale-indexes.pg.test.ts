import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'

/**
 * The indexes of 2026-11-12 (migrations 20261112214701 to 20261112214705)
 * serve the statements they were built for; the read cron's backfill since
 * 20261115130917 dropped the older index its function's plan preferred.
 *
 * Each of those statements read a whole table on production because no index
 * matched it: a lookup by a column with no index, a foreign-key check on a
 * child with no index on the key, a cron's "next rows to work on" across all
 * companies. An index only helps if the planner can use it for the statement
 * as the application sends it, and for a partial index that means proving the
 * index predicate from the statement's own WHERE clause on a generic plan
 * (SQL functions and prepared statements never see the parameter values).
 * That proof is what this file checks: the statement is planned the way it
 * runs in production, with sequential scans, bitmap scans and sorts priced
 * out, and the plan must name the index. The tables are nearly empty here, so
 * nothing is said about speed: the before and after plans from production
 * are in the migrations and the merge request.
 */

interface PlanNode {
  'Node Type': string
  'Index Name'?: string
  Plans?: PlanNode[]
}

/** Priced out so the plan shows what an index can do for the statement, not what is cheapest on an empty table. */
const PLANNER_SETTINGS = ['enable_seqscan = off', 'enable_bitmapscan = off', 'enable_sort = off']

function indexNames(node: PlanNode): string[] {
  return [...(node['Index Name'] ? [node['Index Name']] : []), ...(node.Plans ?? []).flatMap(indexNames)]
}

/** The indexes in the generic plan of one statement, planned as a prepared statement with its parameters unknown. */
async function statementIndexes(sql: string, paramTypes: string[], args: string[]): Promise<string[]> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    for (const setting of PLANNER_SETTINGS) await client.query(`SET LOCAL ${setting}`)
    await client.query('SET LOCAL plan_cache_mode = force_generic_plan')
    await client.query(`PREPARE scale_index_probe${paramTypes.length ? ` (${paramTypes.join(', ')})` : ''} AS ${sql}`)
    const { rows } = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (FORMAT JSON) EXECUTE scale_index_probe${args.length ? ` (${args.join(', ')})` : ''}`,
    )
    return indexNames(rows[0]['QUERY PLAN'][0].Plan)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    // A prepared statement outlives the transaction and the pool reuses the connection.
    await client.query('DEALLOCATE scale_index_probe').catch(() => {})
    client.release()
  }
}

/**
 * The indexes in the plans of the statements a function call runs, the SQL
 * function's own query included: auto_explain, preloaded in the
 * supabase/postgres image, reports nested statements to the client as
 * NOTICEs (the pattern of arkiv-folder-pages.pg.test.ts). `before` runs in the
 * same transaction, which is rolled back.
 */
async function functionIndexes(call: string, before: string[] = []): Promise<string[]> {
  const client = await getClient()
  const notices: string[] = []
  const onNotice = (notice: { message?: string }) => {
    if (notice.message) notices.push(notice.message)
  }
  client.on('notice', onNotice)
  try {
    await client.query('BEGIN')
    for (const statement of before) await client.query(statement)
    for (const setting of PLANNER_SETTINGS) await client.query(`SET LOCAL ${setting}`)
    for (const setting of ['log_min_duration = 0', 'log_nested_statements = on', 'log_format = json', 'log_level = notice']) {
      await client.query(`SET LOCAL auto_explain.${setting}`)
    }
    await client.query(call)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.off('notice', onNotice)
    client.release()
  }
  return notices
    .filter((message) => message.includes('"Plan"'))
    .flatMap((message) => indexNames((JSON.parse(message.slice(message.indexOf('{'))) as { Plan: PlanNode }).Plan))
}

const NO_ONE = `'00000000-0000-4000-8000-000000000001'::uuid`

describe('document_attachments: lookups and cron scans', () => {
  it('finds the document behind a proxied download by its storage path', async () => {
    // GET /api/storage/[...path]: every document view read all 363 000 rows (prod, 1 430 ms cold).
    const indexes = await statementIndexes(
      `SELECT mime_type, file_name FROM public.document_attachments WHERE storage_path = $1 LIMIT $2 OFFSET $3`,
      ['text', 'int', 'int'],
      [`'documents/company/file.pdf'`, '1', '0'],
    )
    expect(indexes).toContain('idx_document_attachments_storage_path')
  })

  it('hands the read cron its retry shelf oldest stamp first, the reasons a parameter', async () => {
    // "read_error = ANY (p_reasons)" is strict, which proves the index's "read_error IS NOT NULL".
    const indexes = await functionIndexes(
      `SELECT * FROM public.document_retry_candidates(ARRAY['ai_gated', 'ai_unconfigured', 'partial:ai_gated', 'partial:ai_unconfigured', 'partial:budget']::text[], 100)`,
    )
    expect(indexes).toContain('idx_document_attachments_read_retry')
  })

  it('finds the newest untyped, read documents across companies for the classify cron', async () => {
    // The statement as PostgREST sends it: the page_count bound and the limit are parameters.
    const indexes = await statementIndexes(
      `SELECT company_id FROM public.document_attachments
       WHERE doc_type IS NULL AND NOT pages_read_at IS NULL AND page_count > $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      ['int', 'int', 'int'],
      ['0', '500', '0'],
    )
    expect(indexes).toContain('idx_document_attachments_untyped_recent')
  })

  it('hands the read cron its unread documents without the structured archives', async () => {
    // The function is planned with its limit as an unknown parameter. While idx_document_attachments_pages_unread
    // (unread rows by created_at, archives included: 92 579 of its 109 395 entries on prod)
    // existed, production's plan was a parallel scan of it. 20261115130917 dropped it, so the
    // function's own predicate must be enough for the planner to take the narrower index.
    const { rows } = await getPool().query<{ dropped: boolean }>(
      `SELECT to_regclass('public.idx_document_attachments_pages_unread') IS NULL AS dropped`,
    )
    expect(rows[0].dropped).toBe(true)
    const indexes = await functionIndexes(`SELECT * FROM public.document_backfill_candidates(200)`)
    expect(indexes).toContain('idx_document_attachments_backfill_unread')
  })
})

describe("a company's rows by company", () => {
  it("locks a company's bank connections in id order", async () => {
    // lock_cash_account_booking_state() and guard_bank_booking_context(), on every bank row booked.
    const locked = await statementIndexes(
      `SELECT 1 FROM public.bank_connections WHERE company_id = $1 ORDER BY id FOR SHARE`,
      ['uuid'],
      [NO_ONE],
    )
    expect(locked).toContain('idx_bank_connections_company_id')
  })

  it("reads a company's mapping rules by priority", async () => {
    // lib/transactions/propose.ts, on every booking proposal.
    const indexes = await statementIndexes(
      `SELECT * FROM public.mapping_rules WHERE company_id = $1 AND is_active = $2 ORDER BY priority DESC`,
      ['uuid', 'boolean'],
      [NO_ONE, 'true'],
    )
    expect(indexes).toContain('idx_mapping_rules_company_priority')
  })

  it("reads a company's supplier payments from a date", async () => {
    const indexes = await statementIndexes(
      `SELECT supplier_invoice_id, transaction_id FROM public.supplier_invoice_payments WHERE company_id = $1 AND payment_date >= $2`,
      ['uuid', 'date'],
      [NO_ONE, `'2026-01-01'::date`],
    )
    expect(indexes).toContain('idx_supplier_invoice_payments_company_date')
  })
})

describe('document_classifications', () => {
  it('answers whether documents were classified before, current or not', async () => {
    // classifyUnclassifiedDocuments: the only document_id index was partial on is_current.
    const indexes = await statementIndexes(
      `SELECT document_id FROM public.document_classifications WHERE document_id = ANY ($1)`,
      ['uuid[]'],
      [`ARRAY[${NO_ONE}]`],
    )
    expect(indexes).toContain('idx_document_classifications_document_id')
  })

  it("lists a company's classifications newest first", async () => {
    const indexes = await statementIndexes(
      `SELECT id, document_id, doc_type, decided_by, created_at FROM public.document_classifications
       WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      ['uuid', 'int', 'int'],
      [NO_ONE, '50', '0'],
    )
    expect(indexes).toContain('idx_document_classifications_company_created')
  })
})

describe('foreign-key checks when a document, a company or a user is deleted', () => {
  // The lookup Postgres runs per deleted parent row. Without an index on the
  // key each one read the child table whole (prod: 1.4 s per deleted sandbox user).
  const checks: Array<[table: string, key: string, index: string]> = [
    ['document_classifications', 'document_id', 'idx_document_classifications_document_id'],
    ['document_classifications', 'company_id', 'idx_document_classifications_company_created'],
    ['document_classifications', 'decided_by_user_id', 'idx_document_classifications_decided_by_user'],
    ['document_jobs', 'company_id', 'idx_document_jobs_company_id'],
    ['payment_match_log', 'company_id', 'idx_payment_match_log_company_id'],
    ['categorization_templates', 'user_id', 'idx_categorization_templates_user_id'],
    ['suggestion_log', 'resolved_by', 'idx_suggestion_log_resolved_by'],
    ['sie_import_chunks', 'user_id', 'idx_sie_import_chunks_user_id'],
    ['parties', 'user_id', 'idx_parties_user_id'],
    ['party_facts', 'user_id', 'idx_party_facts_user_id'],
  ]

  it.each(checks)('%s by %s', async (table, key, index) => {
    const indexes = await statementIndexes(`SELECT 1 FROM ONLY public.${table} x WHERE ${key} = $1 FOR KEY SHARE OF x`, ['uuid'], [NO_ONE])
    expect(indexes).toContain(index)
  })
})
