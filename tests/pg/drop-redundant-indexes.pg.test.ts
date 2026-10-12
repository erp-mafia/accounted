import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20261012100500_drop_redundant_indexes.sql.
 *
 * Every dropped index was redundant next to an index that stays. What has to
 * hold after the drop is a catalog property, so that is what this asserts:
 *
 *   - the dropped index is gone,
 *   - the index that made it redundant still exists on the same table, is
 *     valid, leads with the same columns and carries the expected predicate,
 *   - no foreign key lost its covering index. Postgres probes the child table
 *     once per deleted or re-keyed parent row (`SELECT 1 FROM child WHERE
 *     fk = $1 FOR KEY SHARE`); a foreign key with no index leading on its
 *     columns turns every probe into a seq scan.
 *
 * Several dropped names exist only on prod (created outside the migration
 * history). On a database built from migrations they never existed, so their
 * absence is trivially true here; the kept-index and foreign-key assertions
 * still run for their tables.
 */

type Drop = {
  index: string
  table: string
  /** The index that stays and made `index` redundant. */
  keptBy: string
  /**
   * Leading key columns `keptBy` must still serve: the dropped index's full key
   * for exact duplicates and left prefixes, only `user_id` for the unused
   * (user_id, x) composites whose plain user_id index stays.
   */
  leads: string[]
  /** Expected pg_get_expr predicate of `keptBy`, null for a full index. */
  keptPredicate: string | null
  /**
   * The dropped index was partial. A partial index never served a foreign-key
   * probe (the probe qual does not imply its predicate), so its drop cannot
   * uncover one.
   */
  droppedPartial?: true
}

const DROPPED: Drop[] = [
  // A. Non-unique exact duplicates of a unique index.
  {
    index: 'idx_account_reconciliations_latest',
    table: 'account_reconciliations',
    keptBy: 'ux_account_reconciliations_active',
    leads: ['company_id', 'account_key', 'through_date'],
    keptPredicate: '(reopened_at IS NULL)',
    droppedPartial: true,
  },
  {
    index: 'idx_agent_profiles_company',
    table: 'agent_profiles',
    keptBy: 'agent_profiles_company_id_key',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_agi_period',
    table: 'agi_declarations',
    keptBy: 'agi_declarations_company_id_period_year_period_month_key',
    leads: ['company_id', 'period_year', 'period_month'],
    keptPredicate: null,
  },
  {
    index: 'idx_annual_report_profiles_period',
    table: 'annual_report_profiles',
    keptBy: 'annual_report_profiles_company_period_unique',
    leads: ['company_id', 'fiscal_period_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_annual_report_versions_period',
    table: 'annual_report_versions',
    keptBy: 'annual_report_versions_number_unique',
    leads: ['company_id', 'fiscal_period_id', 'version_number'],
    keptPredicate: null,
  },
  {
    index: 'idx_bankid_identities_user_id',
    table: 'bankid_identities',
    keptBy: 'bankid_identities_user_id_key',
    leads: ['user_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_booking_template_embeddings_template_id',
    table: 'booking_template_embeddings',
    keptBy: 'booking_template_embeddings_template_id_key',
    leads: ['template_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_brand_signup_allowlist_brand_email',
    table: 'brand_signup_allowlist',
    keptBy: 'brand_signup_allowlist_unique_email',
    leads: ['brand_id', 'email'],
    keptPredicate: null,
  },
  {
    index: 'idx_calendar_feeds_feed_token',
    table: 'calendar_feeds',
    keptBy: 'calendar_feeds_feed_token_key',
    leads: ['feed_token'],
    keptPredicate: null,
  },
  {
    index: 'idx_company_invitations_token_hash',
    table: 'company_invitations',
    keptBy: 'company_invitations_token_hash_key',
    leads: ['token_hash'],
    keptPredicate: null,
  },
  {
    index: 'idx_company_settings_company_id',
    table: 'company_settings',
    keptBy: 'company_settings_company_id_key',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_invoice_reminders_action_token',
    table: 'invoice_reminders',
    keptBy: 'invoice_reminders_action_token_key',
    leads: ['action_token'],
    keptPredicate: null,
  },
  {
    index: 'idx_knowledge_documents_hash',
    table: 'knowledge_documents',
    keptBy: 'knowledge_documents_content_hash_key',
    leads: ['content_hash'],
    keptPredicate: null,
  },
  {
    index: 'idx_salary_worked_days_employee_date',
    table: 'salary_worked_days',
    keptBy: 'idx_salary_worked_days_unique',
    leads: ['employee_id', 'work_date'],
    keptPredicate: null,
  },
  {
    index: 'idx_team_invitations_token_hash',
    table: 'team_invitations',
    keptBy: 'team_invitations_token_hash_key',
    leads: ['token_hash'],
    keptPredicate: null,
  },

  // B. Unused left prefixes of a longer index.
  {
    index: 'idx_audit_log_user_id',
    table: 'audit_log',
    keptBy: 'idx_audit_log_actor_type',
    leads: ['user_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_accrual_schedules_company',
    table: 'accrual_schedules',
    keptBy: 'idx_accrual_schedules_company_status',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_arsredovisning_narratives_company',
    table: 'arsredovisning_narratives',
    keptBy: 'arsredovisning_narratives_unique_period',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_arsredovisning_sigreq_company',
    table: 'arsredovisning_signature_requests',
    keptBy: 'idx_arsredovisning_sigreq_version',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_rot_rut_payout_requests_company_id',
    table: 'rot_rut_payout_requests',
    keptBy: 'idx_rot_rut_payout_requests_company_status',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_sales_orders_company_id',
    table: 'sales_orders',
    keptBy: 'idx_sales_orders_company_status',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_tax_assessment_notices_company',
    table: 'tax_assessment_notices',
    keptBy: 'tax_assessment_notices_company_period_type_date_key',
    leads: ['company_id'],
    keptPredicate: null,
  },
  {
    index: 'idx_agi_company',
    table: 'agi_declarations',
    keptBy: 'agi_declarations_company_id_period_year_period_month_key',
    leads: ['company_id'],
    keptPredicate: null,
  },

  // C. Unused (user_id, x) composites; the plain user_id index stays.
  ...(
    [
      ['idx_journal_entries_user_date', 'journal_entries', 'idx_journal_entries_user_id'],
      ['idx_transactions_user_date', 'transactions', 'idx_transactions_user_id'],
      ['idx_transactions_unmatched', 'transactions', 'idx_transactions_user_id'],
      ['idx_transactions_user_category', 'transactions', 'idx_transactions_user_id'],
      ['idx_invoices_user_due_date', 'invoices', 'idx_invoices_user_id'],
      ['idx_invoices_user_status', 'invoices', 'idx_invoices_user_id'],
      ['idx_invoice_inbox_items_user_created', 'invoice_inbox_items', 'idx_invoice_inbox_items_user_id'],
      ['idx_suppliers_name', 'suppliers', 'idx_suppliers_user_id'],
      ['idx_suppliers_is_active', 'suppliers', 'idx_suppliers_user_id'],
      ['idx_deadlines_user_completed', 'deadlines', 'idx_deadlines_user_id'],
      ['idx_deadlines_user_date', 'deadlines', 'idx_deadlines_user_id'],
    ] as const
  ).map(([index, table, keptBy]): Drop => ({
    index,
    table,
    keptBy,
    leads: ['user_id'],
    keptPredicate: null,
    // idx_transactions_unmatched is WHERE journal_entry_id IS NULL.
    ...(index === 'idx_transactions_unmatched' ? { droppedPartial: true as const } : {}),
  })),
]

type IndexRow = {
  index_name: string
  table_name: string
  is_valid: boolean
  key_columns: string[]
  predicate: string | null
}

async function loadIndexes(tables: string[]): Promise<IndexRow[]> {
  const { rows } = await getPool().query<IndexRow>(
    `SELECT ci.relname AS index_name,
            ct.relname AS table_name,
            i.indisvalid AS is_valid,
            ARRAY(
              SELECT a.attname::text
                FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE k.ord <= i.indnkeyatts
               ORDER BY k.ord
            ) AS key_columns,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       JOIN pg_class ci ON ci.oid = i.indexrelid
       JOIN pg_class ct ON ct.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = ct.relnamespace AND n.nspname = 'public'
      WHERE ct.relname = ANY($1::text[])`,
    [tables],
  )
  return rows
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

describe('drop redundant indexes.pg', () => {
  const tables = [...new Set(DROPPED.map((d) => d.table))]

  it('drops every redundant index', async () => {
    const { rows } = await getPool().query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'i'
          AND relname = ANY($1::text[])`,
      [DROPPED.map((d) => d.index)],
    )
    expect(rows.map((r) => r.relname).sort()).toEqual([])
  })

  it('keeps the index that made each dropped one redundant, with the same leading columns', async () => {
    const byName = new Map((await loadIndexes(tables)).map((row) => [row.index_name, row]))
    for (const drop of DROPPED) {
      const kept = byName.get(drop.keptBy)
      expect(kept, `${drop.index}: covering index ${drop.keptBy} is missing`).toBeDefined()
      expect(`${drop.keptBy}:${kept!.table_name}:${kept!.is_valid}`).toBe(
        `${drop.keptBy}:${drop.table}:true`,
      )
      expect(`${drop.keptBy}:${kept!.key_columns.slice(0, drop.leads.length).join(',')}`).toBe(
        `${drop.keptBy}:${drop.leads.join(',')}`,
      )
      expect(`${drop.keptBy}:${kept!.predicate ?? 'none'}`).toBe(
        `${drop.keptBy}:${drop.keptPredicate ?? 'none'}`,
      )
    }
  })

  it('leaves every foreign key a dropped index served with a covering index', async () => {
    const { rows: fks } = await getPool().query<{
      conname: string
      table_name: string
      columns: string[]
    }>(
      `SELECT c.conname,
              ct.relname AS table_name,
              ARRAY(
                SELECT a.attname::text
                  FROM unnest(c.conkey) AS k(attnum)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ) AS columns
         FROM pg_constraint c
         JOIN pg_class ct ON ct.oid = c.conrelid
        WHERE c.contype = 'f'
          AND ct.relnamespace = 'public'::regnamespace
          AND ct.relname = ANY($1::text[])`,
      [tables],
    )
    const indexes = await loadIndexes(tables)

    // A foreign key a dropped full index could serve: its columns are a
    // leading prefix (in any order) of what the dropped index led with.
    const served = fks.filter((fk) =>
      DROPPED.some(
        (drop) =>
          !drop.droppedPartial &&
          drop.table === fk.table_name &&
          fk.columns.length <= drop.leads.length &&
          sameSet(fk.columns, drop.leads.slice(0, fk.columns.length)),
      ),
    )
    expect(served.length).toBeGreaterThan(0)

    const uncovered = served
      .filter(
        (fk) =>
          !indexes.some(
            (ix) =>
              ix.table_name === fk.table_name &&
              ix.is_valid &&
              ix.predicate === null &&
              sameSet(ix.key_columns.slice(0, fk.columns.length), fk.columns),
          ),
      )
      .map((fk) => `${fk.table_name}.${fk.conname}`)
    expect(uncovered).toEqual([])
  })
})
