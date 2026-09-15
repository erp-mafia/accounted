import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput, EntityType } from '@/types'
import { isEntityType } from '@/lib/company/entity-type'
import {
  createJournalEntry,
  findFiscalPeriod,
  getSwedishLocalDate,
  reverseEntry,
} from '@/lib/bookkeeping/engine'
import { roundOre } from '@/lib/money'

/**
 * Migration of a company's legal form when its books are NOT empty (design
 * section 11 in docs/research/ekonomisk-forening-support-design.md).
 *
 * The empty-books class goes through correct_company_entity_type (PATCH
 * /api/company/current). Everything else is planned here: the read-only
 * preview (preview_company_entity_type_change) is snapshotted, the accounts
 * whose meaning changes with the form get a remap proposal each, the owner
 * decides per account (confirm with a target account, or skip), and apply
 * runs in two steps that are each individually auditable:
 *
 *   1. apply_company_entity_type_migration(): flips the form and adds the
 *      target form's missing seeded accounts, refusing when the decision
 *      accounts moved since planning (a stale plan).
 *   2. one reclassification verifikat through the bookkeeping engine for the
 *      confirmed remaps, linked on the migration row.
 *
 * Nothing is deleted or renamed. A rollback reverses the verifikat (storno)
 * and flips the form back through rollback_company_entity_type_migration().
 */

export type EntityTypeMigrationErrorCode =
  | 'ENTITY_TYPE_MIGRATION_FORBIDDEN'
  | 'ENTITY_TYPE_MIGRATION_NOT_FOUND'
  | 'ENTITY_TYPE_MIGRATION_UNSUPPORTED'
  | 'ENTITY_TYPE_MIGRATION_SAME_FORM'
  | 'ENTITY_TYPE_MIGRATION_EMPTY_BOOKS'
  | 'ENTITY_TYPE_MIGRATION_NOT_PLANNED'
  | 'ENTITY_TYPE_MIGRATION_NOT_APPLIED'
  | 'ENTITY_TYPE_MIGRATION_STALE'
  | 'ENTITY_TYPE_MIGRATION_UNDECIDED_ACCOUNT'
  | 'ENTITY_TYPE_MIGRATION_INVALID_PLAN'
  | 'ENTITY_TYPE_MIGRATION_NO_OPEN_PERIOD'
  | 'ENTITY_TYPE_MIGRATION_RECLASSIFICATION_NOT_REVERSED'

export class EntityTypeMigrationError extends Error {
  readonly code: EntityTypeMigrationErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: EntityTypeMigrationErrorCode, details?: Record<string, unknown>) {
    super(code)
    this.name = 'EntityTypeMigrationError'
    this.code = code
    this.details = details
  }
}

/** Codes the two RPCs return; anything unknown is treated as a stale plan. */
const RPC_CODES = new Set<EntityTypeMigrationErrorCode>([
  'ENTITY_TYPE_MIGRATION_FORBIDDEN',
  'ENTITY_TYPE_MIGRATION_NOT_FOUND',
  'ENTITY_TYPE_MIGRATION_UNSUPPORTED',
  'ENTITY_TYPE_MIGRATION_SAME_FORM',
  'ENTITY_TYPE_MIGRATION_NOT_PLANNED',
  'ENTITY_TYPE_MIGRATION_NOT_APPLIED',
  'ENTITY_TYPE_MIGRATION_STALE',
  'ENTITY_TYPE_MIGRATION_INVALID_PLAN',
  'ENTITY_TYPE_MIGRATION_RECLASSIFICATION_NOT_REVERSED',
])

function rpcError(result: { code?: string; [key: string]: unknown }): EntityTypeMigrationError {
  const code = result.code ?? ''
  const known = RPC_CODES.has(code as EntityTypeMigrationErrorCode)
  const { ok: _ok, code: _code, ...details } = result
  return new EntityTypeMigrationError(
    known ? (code as EntityTypeMigrationErrorCode) : 'ENTITY_TYPE_MIGRATION_STALE',
    Object.keys(details).length > 0 ? details : undefined,
  )
}

export interface DecisionAccount {
  account: string
  /** Posted balance, credit-positive (credit − debit), whole öre. */
  balance: number
}

export interface EntityTypePreview {
  ok: boolean
  code?: string
  current_entity_type: string
  target_entity_type: string
  same_form: boolean
  empty_books_path_available: boolean
  caller_role: string
  blockers: Record<string, number>
  decision_accounts: DecisionAccount[]
}

export type RemapDecision = 'confirmed' | 'skipped'

export interface RemapProposal {
  account_from: string
  /** Proposed target account; null when the account keeps its meaning or no
   * automatic mapping exists. */
  account_to: string | null
  /** The credit-positive balance the proposal moves. */
  amount: number
  /** 'plausible': the design names the mapping; 'review': a human must look;
   * 'keep': the account keeps its meaning under the target form. */
  plausibility: 'plausible' | 'review' | 'keep'
  /** Every proposal starts skipped: the owner confirms each remap explicitly. */
  decision: RemapDecision
  reason: string
}

export interface RemapPlanEntry {
  account_from: string
  account_to: string | null
  amount: number
  decision: RemapDecision
  reason?: string
}

export interface EntityTypeMigrationRow {
  id: string
  company_id: string
  user_id: string
  from_entity_type: string
  to_entity_type: string
  preview: EntityTypePreview
  remap_plan: RemapPlanEntry[]
  status: 'planned' | 'applied' | 'rolled_back'
  applied_at: string | null
  applied_by: string | null
  rolled_back_at: string | null
  reclassification_journal_entry_id: string | null
  rollback_journal_entry_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

type Rule = { to: string | null; plausibility: RemapProposal['plausibility']; reason: string }

/**
 * Remap rules per (from, to) pair for the decision accounts the preview
 * reports. The design's principle: a mapping is proposed only where the BAS
 * meaning under the new form is the same post with another number; anything
 * that can be several things (a 2893 balance is a member loan, an expense
 * payable or a bad owner classification) needs review.
 */
const RULES: Record<string, Record<string, Rule>> = {
  'aktiebolag>ekonomisk_forening': {
    '2081': { to: '2083', plausibility: 'plausible', reason: 'Aktiekapital finns inte i en förening; det inbetalda kapitalet är medlemsinsatser (ÅRL 3 kap. 10 b §).' },
    '2082': { to: '2083', plausibility: 'plausible', reason: 'Ej registrerat aktiekapital motsvarar tecknade men ännu inte registrerade insatser.' },
    '2087': { to: null, plausibility: 'keep', reason: '2087 är bunden överkursfond i ett aktiebolag men insatsemission i en förening; saldot står kvar och granskas i årsredovisningen.' },
    '2091': { to: null, plausibility: 'keep', reason: 'Balanserat resultat behåller sin betydelse.' },
    '2098': { to: null, plausibility: 'keep', reason: 'Vinst eller förlust från föregående år behåller sin betydelse.' },
    '2099': { to: null, plausibility: 'keep', reason: 'Årets resultat behåller sin betydelse.' },
    '2893': { to: '2890', plausibility: 'review', reason: 'Skuld till aktieägare kan vara ett medlemslån, en utläggsskuld eller en felklassad ägarpost: avgör innan omföring till 2890.' },
  },
  'enskild_firma>ekonomisk_forening': {
    '2010': { to: '2083', plausibility: 'review', reason: 'Eget kapital i en enskild firma är ägarens; i en förening är det inbetalda kapitalet medlemsinsatser (2083) och resten balanserat resultat (2091). Dela upp innan omföring.' },
    '2013': { to: '2890', plausibility: 'review', reason: 'Egna uttag saknar motsvarighet i en förening: ett uttag är en skuld till eller fordran på medlemmen.' },
    '2018': { to: '2083', plausibility: 'review', reason: 'Egna insättningar kan vara medlemsinsatser eller lån från medlemmen.' },
  },
  'ideell_forening>ekonomisk_forening': {
    '2067': { to: '2091', plausibility: 'plausible', reason: 'Balanserat överskott är balanserat resultat i en ekonomisk förening.' },
    '2068': { to: '2091', plausibility: 'plausible', reason: 'Överskott från föregående år förs till balanserat resultat.' },
    '2069': { to: '2099', plausibility: 'plausible', reason: 'Årets resultat i en ideell förening (2069) motsvarar 2099.' },
    '2890': { to: null, plausibility: 'keep', reason: 'Övriga kortfristiga skulder behåller sin betydelse.' },
  },
}

function ruleFor(from: string, to: string, account: string): Rule {
  const rule = RULES[`${from}>${to}`]?.[account]
  if (rule) return rule
  return {
    to: null,
    plausibility: 'review',
    reason: 'Ingen automatisk omföring finns för kontot vid detta byte av företagsform: granska saldot.',
  }
}

/** Build the remap proposals for a preview. Pure; exported for tests. */
export function buildRemapProposals(preview: EntityTypePreview): RemapProposal[] {
  return preview.decision_accounts
    .filter((row) => roundOre(row.balance) !== 0)
    .map((row) => {
      const rule = ruleFor(preview.current_entity_type, preview.target_entity_type, row.account)
      return {
        account_from: row.account,
        account_to: rule.to,
        amount: roundOre(row.balance),
        plausibility: rule.plausibility,
        decision: 'skipped' as const,
        reason: rule.reason,
      }
    })
}

/**
 * Check a plan against the snapshot: every nonzero decision account needs a
 * decision, a confirmed remap needs a target account that differs from the
 * source, and no entry may point outside the snapshot. Pure; exported for
 * tests. Returns the confirmed entries with the snapshot's balances (the
 * caller's amount is ignored: the RPC proves the balances have not moved).
 */
export function validateRemapPlan(
  preview: EntityTypePreview,
  plan: RemapPlanEntry[],
): { account_from: string; account_to: string; balance: number }[] {
  const balances = new Map<string, number>()
  for (const row of preview.decision_accounts) {
    const balance = roundOre(row.balance)
    if (balance !== 0) balances.set(row.account, balance)
  }
  const decided = new Map<string, RemapPlanEntry>()
  for (const entry of plan) {
    if (!balances.has(entry.account_from)) {
      throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_INVALID_PLAN', { account: entry.account_from })
    }
    if (decided.has(entry.account_from)) {
      throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_INVALID_PLAN', {
        account: entry.account_from,
        reason: 'duplicate',
      })
    }
    if (entry.decision === 'confirmed') {
      if (!entry.account_to || !/^\d{4}$/.test(entry.account_to) || entry.account_to === entry.account_from) {
        throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_INVALID_PLAN', {
          account: entry.account_from,
          reason: 'account_to',
        })
      }
    }
    decided.set(entry.account_from, entry)
  }
  const undecided = [...balances.keys()].filter((account) => !decided.has(account))
  if (undecided.length > 0) {
    throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_UNDECIDED_ACCOUNT', { accounts: undecided })
  }
  return [...decided.values()]
    .filter((entry): entry is RemapPlanEntry & { account_to: string } => entry.decision === 'confirmed')
    .map((entry) => ({
      account_from: entry.account_from,
      account_to: entry.account_to,
      balance: balances.get(entry.account_from) ?? 0,
    }))
}

/**
 * Lines that move each confirmed credit-positive balance from its old
 * account to its new one. A credit balance is debited away and credited on
 * the target; a debit balance the other way round. Pure; exported for tests.
 */
export function reclassificationLines(
  remaps: { account_from: string; account_to: string; balance: number }[],
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  for (const remap of remaps) {
    const amount = roundOre(Math.abs(remap.balance))
    if (amount === 0) continue
    const description = `Omklassificering ${remap.account_from} → ${remap.account_to} vid byte av företagsform`
    if (remap.balance > 0) {
      lines.push({ account_number: remap.account_from, debit_amount: amount, credit_amount: 0, line_description: description })
      lines.push({ account_number: remap.account_to, debit_amount: 0, credit_amount: amount, line_description: description })
    } else {
      lines.push({ account_number: remap.account_to, debit_amount: amount, credit_amount: 0, line_description: description })
      lines.push({ account_number: remap.account_from, debit_amount: 0, credit_amount: amount, line_description: description })
    }
  }
  return lines
}

async function previewChange(
  supabase: SupabaseClient,
  companyId: string,
  target: EntityType,
): Promise<EntityTypePreview> {
  const { data, error } = await supabase.rpc('preview_company_entity_type_change', {
    p_company_id: companyId,
    p_entity_type: target,
  })
  if (error) throw error
  const result = (data ?? {}) as Partial<EntityTypePreview> & { code?: string }
  if (!result.ok) {
    // The preview shares its codes with the empty-books RPC.
    const code = result.code ?? ''
    if (code === 'ENTITY_TYPE_CHANGE_FORBIDDEN') throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_FORBIDDEN')
    if (code === 'ENTITY_TYPE_CHANGE_UNSUPPORTED') throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_UNSUPPORTED')
    throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_NOT_FOUND')
  }
  return result as EntityTypePreview
}

export async function listMigrations(supabase: SupabaseClient, companyId: string): Promise<EntityTypeMigrationRow[]> {
  const { data, error } = await supabase
    .from('company_entity_type_migrations')
    .select('id, company_id, user_id, from_entity_type, to_entity_type, preview, remap_plan, status, applied_at, applied_by, rolled_back_at, reclassification_journal_entry_id, rollback_journal_entry_id, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as EntityTypeMigrationRow[]
}

export async function getMigration(
  supabase: SupabaseClient,
  companyId: string,
  migrationId: string,
): Promise<EntityTypeMigrationRow> {
  const { data, error } = await supabase
    .from('company_entity_type_migrations')
    .select('id, company_id, user_id, from_entity_type, to_entity_type, preview, remap_plan, status, applied_at, applied_by, rolled_back_at, reclassification_journal_entry_id, rollback_journal_entry_id, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', migrationId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_NOT_FOUND')
  return data as unknown as EntityTypeMigrationRow
}

/**
 * Snapshot the preview and store a planned migration with the remap
 * proposals as its initial plan (every proposal skipped). A company whose
 * books are empty is sent to the direct correction instead.
 */
export async function planMigration(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  target: EntityType,
): Promise<{ migration: EntityTypeMigrationRow; proposals: RemapProposal[] }> {
  if (!isEntityType(target)) throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_UNSUPPORTED')
  const preview = await previewChange(supabase, companyId, target)
  if (preview.same_form) throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_SAME_FORM')
  if (preview.caller_role !== 'owner') throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_FORBIDDEN')
  if (preview.empty_books_path_available) throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_EMPTY_BOOKS')

  const proposals = buildRemapProposals(preview)
  const { data, error } = await supabase
    .from('company_entity_type_migrations')
    .insert({
      company_id: companyId,
      user_id: userId,
      from_entity_type: preview.current_entity_type,
      to_entity_type: preview.target_entity_type,
      preview,
      remap_plan: proposals.map(({ account_from, account_to, amount, decision, reason }) => ({
        account_from,
        account_to,
        amount,
        decision,
        reason,
      })),
      status: 'planned',
    })
    .select('id, company_id, user_id, from_entity_type, to_entity_type, preview, remap_plan, status, applied_at, applied_by, rolled_back_at, reclassification_journal_entry_id, rollback_journal_entry_id, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return { migration: data as unknown as EntityTypeMigrationRow, proposals }
}

export interface ApplyMigrationResult {
  migration: EntityTypeMigrationRow
  /** Id of the reclassification verifikat, null when nothing was confirmed. */
  reclassification_journal_entry_id: string | null
  added_accounts: number
}

/**
 * Apply a planned migration: validate the owner's plan against the snapshot,
 * resolve the open fiscal period for the reclassification date BEFORE the
 * form flips (so a missing period never leaves a half-applied migration),
 * flip the form through the RPC, then post the reclassification verifikat
 * for the confirmed remaps and link it on the row.
 */
export async function applyMigration(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  migrationId: string,
  plan: RemapPlanEntry[],
  entryDate?: string,
): Promise<ApplyMigrationResult> {
  const migration = await getMigration(supabase, companyId, migrationId)
  if (migration.status !== 'planned') {
    throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_NOT_PLANNED', { status: migration.status })
  }
  const remaps = validateRemapPlan(migration.preview, plan)
  const date = entryDate ?? getSwedishLocalDate()
  let fiscalPeriodId: string | null = null
  if (remaps.length > 0) {
    fiscalPeriodId = await findFiscalPeriod(supabase, companyId, date)
    if (!fiscalPeriodId) throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_NO_OPEN_PERIOD', { date })
  }

  const { data, error } = await supabase.rpc('apply_company_entity_type_migration', {
    p_migration_id: migrationId,
    p_remap_plan: plan,
  })
  if (error) throw error
  const result = (data ?? {}) as { ok?: boolean; code?: string; added_accounts?: number }
  if (!result.ok) throw rpcError(result)

  let entryId: string | null = null
  if (remaps.length > 0 && fiscalPeriodId) {
    const entry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: fiscalPeriodId,
      entry_date: date,
      description: `Omklassificering av eget kapital vid byte av företagsform (${migration.from_entity_type} → ${migration.to_entity_type})`,
      source_type: 'system',
      source_id: migrationId,
      notes: `Byte av företagsform ${migrationId}: omföringar bekräftade av ägaren.`,
      lines: reclassificationLines(remaps),
    })
    entryId = entry.id
    const { error: linkError } = await supabase
      .from('company_entity_type_migrations')
      .update({ reclassification_journal_entry_id: entryId })
      .eq('id', migrationId)
      .eq('company_id', companyId)
    if (linkError) throw linkError
  }

  return {
    migration: await getMigration(supabase, companyId, migrationId),
    reclassification_journal_entry_id: entryId,
    added_accounts: result.added_accounts ?? 0,
  }
}

/**
 * Roll an applied migration back: storno of the reclassification verifikat
 * through the engine (linked on the row so the RPC can see it), then the
 * form flips back. Accounts added on apply are kept.
 */
export async function rollbackMigration(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  migrationId: string,
  reversalDate?: string,
): Promise<EntityTypeMigrationRow> {
  const migration = await getMigration(supabase, companyId, migrationId)
  if (migration.status !== 'applied') {
    throw new EntityTypeMigrationError('ENTITY_TYPE_MIGRATION_NOT_APPLIED', { status: migration.status })
  }
  if (migration.reclassification_journal_entry_id && !migration.rollback_journal_entry_id) {
    const storno = await reverseEntry(
      supabase,
      companyId,
      userId,
      migration.reclassification_journal_entry_id,
      reversalDate ?? getSwedishLocalDate(),
    )
    const { error: linkError } = await supabase
      .from('company_entity_type_migrations')
      .update({ rollback_journal_entry_id: storno.id })
      .eq('id', migrationId)
      .eq('company_id', companyId)
    if (linkError) throw linkError
  }

  const { data, error } = await supabase.rpc('rollback_company_entity_type_migration', {
    p_migration_id: migrationId,
  })
  if (error) throw error
  const result = (data ?? {}) as { ok?: boolean; code?: string }
  if (!result.ok) throw rpcError(result)
  return getMigration(supabase, companyId, migrationId)
}
