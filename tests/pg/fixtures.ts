import { randomUUID } from 'node:crypto'
import { getPool } from './setup'

// Minimal fixture inserters for pg-real tests. All inserts go through the
// pool (superuser `postgres`), which bypasses RLS — that is intentional for
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
  entityType?: 'enskild_firma' | 'aktiebolag'
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
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        external_id, journal_entry_id, cash_account_id, is_ignored, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'uncategorized')`,
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
  status?: 'draft' | 'posted'
  voucherNumber?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber ?? 0,
      params.voucherSeries ?? 'A',
      params.entryDate ?? '2026-06-01',
      params.description ?? 'Test entry',
      params.status ?? 'draft',
    ],
  )
  return id
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
