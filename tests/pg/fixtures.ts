import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import type { PoolClient } from 'pg'

async function importFixtureBatch(client:PoolClient,params:{sourceType?:string;companyId:string;userId:string}):Promise<string|null> {
  if(params.sourceType!=='import') return null
  return (await client.query(`INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES($1,$2,'pg-import-fixture.se',md5(gen_random_uuid()::text),4,'completed') RETURNING id`,[params.companyId,params.userId])).rows[0].id
}

// Minimal fixture inserters for pg-real tests. All inserts go through the
// pool (superuser `postgres`), which bypasses RLS: that is intentional for
// seeding. RLS is exercised only where a test explicitly opens a user
// context via withUserContext().

export async function insertAuthUser(id: string = randomUUID()): Promise<string> {
  // auth.users has many columns but most default. We only need `id` and a
  // non-conflicting `email`. Everything else (role, aud, timestamps, etc.)
  // has a default or is nullable in the supabase/postgres image.
  await getPool().query(
    `INSERT INTO auth.users (id, email, instance_id)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [id, `pg-real-${id}@test.invalid`],
  )
  return id
}

export async function insertCompany(params: {
  createdBy: string
  name?: string
  entityType?: 'enskild_firma' | 'aktiebolag' | 'ideell_forening'
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.companies (id, name, entity_type, created_by)
     VALUES ($1, $2, $3, $4)`,
    [id, params.name ?? 'Test AB', params.entityType ?? 'aktiebolag', params.createdBy],
  )
  return id
}

export async function insertCompanyMember(params: {
  companyId: string
  userId: string
  role?: 'owner' | 'admin' | 'member' | 'viewer'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_members (company_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [params.companyId, params.userId, params.role ?? 'owner'],
  )
}

export async function insertFiscalPeriod(params: {
  userId: string
  companyId: string
  isClosed?: boolean
  periodStart?: string
  periodEnd?: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.fiscal_periods
       (id, user_id, company_id, name, period_start, period_end, is_closed, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.name ?? '2026',
      params.periodStart ?? '2026-01-01',
      params.periodEnd ?? '2026-12-31',
      params.isClosed ?? false,
      params.isClosed ? new Date() : null,
    ],
  )
  return id
}

// One-call helper: creates user + company + owner membership + open fiscal
// period. Returns the IDs tests need.
export async function seedCompany(overrides: { isClosed?: boolean } = {}): Promise<{
  userId: string
  companyId: string
  fiscalPeriodId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    isClosed: overrides.isClosed,
  })
  return { userId, companyId, fiscalPeriodId }
}

// Insert a cash account (cash_accounts row). ledger_account is unique per
// company; is_primary defaults false to avoid the one-primary partial index.
export async function insertCashAccount(params: {
  companyId: string
  ledgerAccount: string
  currency?: string
  iban?: string | null
  externalUid?: string | null
  isPrimary?: boolean
  enabled?: boolean
  source?: 'enable_banking' | 'manual' | 'sie_import'
  bankConnectionId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.cash_accounts
       (id, company_id, ledger_account, currency, iban, external_uid,
        is_primary, enabled, source, bank_connection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.companyId,
      params.ledgerAccount,
      params.currency ?? 'SEK',
      params.iban ?? null,
      params.externalUid ?? null,
      params.isPrimary ?? false,
      params.enabled ?? true,
      params.source ?? 'manual',
      params.bankConnectionId ?? null,
    ],
  )
  return id
}

// Insert a bank transaction row. cashAccountId/journalEntryId default null so
// tests can exercise the backfill and the NULL-fallback scoping.
export async function insertTransaction(params: {
  companyId: string
  userId: string
  currency?: string
  amount?: number
  date?: string
  description?: string
  externalId?: string | null
  journalEntryId?: string | null
  cashAccountId?: string | null
  isIgnored?: boolean
  bankFileImportId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        external_id, journal_entry_id, cash_account_id, is_ignored,
        bank_file_import_id, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'uncategorized')`,
    [
      id,
      params.companyId,
      params.userId,
      params.currency ?? 'SEK',
      params.amount ?? -100,
      params.date ?? '2026-06-01',
      params.description ?? 'Test tx',
      params.externalId ?? null,
      params.journalEntryId ?? null,
      params.cashAccountId ?? null,
      params.isIgnored ?? false,
      params.bankFileImportId ?? null,
    ],
  )
  return id
}

// Insert a draft journal entry and return its id. Uses a placeholder
// voucher_number=0 which commit_journal_entry() will overwrite on commit.
export async function insertDraftJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate?: string
  description?: string
  voucherSeries?: string
  status?: 'draft' | 'posted' | 'reversed' | 'cancelled'
  voucherNumber?: number
  sourceType?: string
  sourceId?: string | null
  createdAt?: string
  // Explicit historic timestamps are retained by set_committed_at on posting.
  committedAt?: string | null
  /** Explicit pre-backbone data for tests of retained legacy workflows. */
  legacyImport?: boolean
}): Promise<string> {
  if (params.status === 'posted') {
    return insertPostedJournalEntry(params)
  }

  const id = randomUUID()
  const client=await getPool().connect()
  try {
  await client.query('BEGIN')
  const batch=params.legacyImport ? null : await importFixtureBatch(client,params)
  if(params.legacyImport) await client.query('ALTER TABLE journal_entries DISABLE TRIGGER guard_sie_entry_provenance')
  await client.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, source_id, status, created_at, committed_at,
        import_batch_id,source_ordinal,source_content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()), $13::timestamptz,
       $14,CASE WHEN $14::uuid IS NOT NULL THEN 0 END,CASE WHEN $14::uuid IS NOT NULL THEN repeat('a',64) END)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber ?? 0,
      params.voucherSeries ?? 'A',
      params.entryDate ?? '2026-06-01',
      params.description ?? 'Test entry',
      params.sourceType ?? 'manual',
      params.sourceId ?? null,
      params.status ?? 'draft',
      params.createdAt ?? null,
      params.committedAt ?? null,
      batch,
    ],
  )
  if(params.legacyImport) await client.query('ALTER TABLE journal_entries ENABLE TRIGGER guard_sie_entry_provenance')
  await client.query('COMMIT')
  return id
  } catch(error) {await client.query('ROLLBACK');throw error}
  finally {client.release()}
}

export interface PostedJournalEntryLine {
  accountNumber: string
  debitAmount: number
  creditAmount: number
  currency?: string
  lineDescription?: string | null
  sortOrder?: number
  dimensions?: Record<string, string>
}

// Insert a draft, add all lines, and post in one transaction. All accounting
// guards stay enabled, including the posted-line immutability guard.
export async function insertPostedJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate?: string
  description?: string
  voucherSeries?: string
  voucherNumber?: number
  sourceType?: string
  sourceId?: string | null
  createdAt?: string
  committedAt?: string | null
  legacyImport?: boolean
  lines?: PostedJournalEntryLine[]
}): Promise<string> {
  const id = randomUUID()
  const lines = params.lines ?? [
    { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
    { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
  ]
  const client = await getPool().connect()

  try {
    await client.query('BEGIN')
    const batch=params.legacyImport ? null : await importFixtureBatch(client,params)
    if(params.legacyImport) await client.query('ALTER TABLE journal_entries DISABLE TRIGGER guard_sie_entry_provenance')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, source_id, status, created_at, committed_at,
          import_batch_id,source_ordinal,source_content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft',
               COALESCE($11::timestamptz, now()), $12::timestamptz,
               $13,CASE WHEN $13::uuid IS NOT NULL THEN 0 END,CASE WHEN $13::uuid IS NOT NULL THEN repeat('a',64) END)`,
      [
        id,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.voucherNumber ?? 0,
        params.voucherSeries ?? 'A',
        params.entryDate ?? '2026-06-01',
        params.description ?? 'Test entry',
        params.sourceType ?? 'manual',
        params.sourceId ?? null,
        params.createdAt ?? null,
        params.committedAt ?? null,
        batch,
      ],
    )
    if(params.legacyImport) await client.query('ALTER TABLE journal_entries ENABLE TRIGGER guard_sie_entry_provenance')

    for (const [index, line] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount,
            currency, line_description, sort_order, dimensions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          id,
          line.accountNumber,
          line.debitAmount,
          line.creditAmount,
          line.currency ?? 'SEK',
          line.lineDescription ?? null,
          line.sortOrder ?? index,
          JSON.stringify(line.dimensions ?? {}),
        ],
      )
    }

    await client.query("UPDATE journal_entries SET status='posted' WHERE id=$1",[id])
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// Insert a balanced pair of journal entry lines (1 debit row + 1 credit row
// at the given amount). Needed before commit_journal_entry() because the
// balance constraint trigger fires on draft→posted.
export async function insertBalancedLines(
  journalEntryId: string,
  amount: number = 1000,
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0),
            ($1, '3001', 0, $2)`,
    [journalEntryId, amount],
  )
}
