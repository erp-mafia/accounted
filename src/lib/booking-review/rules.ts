/**
 * Booking review rules (accounted#130 step 2): reading them, and writing them
 * through the two SECURITY DEFINER functions that alone may (owner or admin,
 * from a signed-in session; every change in audit_log and
 * behandlingshistorik). See ./match.ts for what a rule matches.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createLogger } from '@/lib/logger'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { BOOKING_REVIEW_VAT_CLASSES, type BookingReviewRule } from './match'

const log = createLogger('booking-review/rules')

/** Postgres / PostgREST codes meaning "the table is not in this database yet". */
const NOT_IN_DATABASE: ReadonlySet<string> = new Set(['42P01', 'PGRST205', '42883', 'PGRST202'])

const COLUMNS =
  'id, rule_id, version, accounts, counterparty_key, counterparty_label, amount_from_sek, vat_treatment, note, valid_from, created_by, created_at, revoked_at, revoked_by, revoked_reason'

function toRule(row: Record<string, unknown>): BookingReviewRule {
  const amount = row.amount_from_sek
  return {
    ...(row as unknown as BookingReviewRule),
    amount_from_sek: amount === null || amount === undefined ? null : Number(amount),
  }
}

/**
 * The company's active rules. Fails open to none, logged: every door asks
 * here only to refuse early and clearly; commit_journal_entry is the line
 * that holds whatever this read says.
 */
export async function loadActiveBookingReviewRules(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BookingReviewRule[]> {
  const { data, error } = await supabase
    .from('booking_review_rules')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })
  if (error) {
    if (!(error.code && NOT_IN_DATABASE.has(error.code))) {
      log.warn('booking review rules could not be read; the database still holds them', { companyId, code: error.code })
    }
    return []
  }
  return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(toRule)
}

/** Every version of every rule, newest first: the active ones and the archived history (/rules). */
export async function listBookingReviewRules(supabase: SupabaseClient, companyId: string): Promise<BookingReviewRule[]> {
  const { data, error } = await supabase
    .from('booking_review_rules')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    if (error.code && NOT_IN_DATABASE.has(error.code)) return []
    throw error
  }
  return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(toRule)
}

/** A new rule, as the /rules form sends it. At least one criterion. */
export const BookingReviewRuleInputSchema = z
  .object({
    accounts: z.array(accountNumberSchema).max(50).optional(),
    counterparty: z.string().trim().min(2).max(200).optional(),
    amount_from_sek: z.number().positive().max(100_000_000).optional(),
    vat_treatment: z.enum(BOOKING_REVIEW_VAT_CLASSES).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine(
    (b) => (b.accounts?.length ?? 0) > 0 || !!b.counterparty || b.amount_from_sek !== undefined || !!b.vat_treatment,
    { message: 'Ange minst ett av konton, motpart, belopp eller momsbehandling' },
  )

export type BookingReviewRuleInput = z.infer<typeof BookingReviewRuleInputSchema>

/** What the write functions refuse with, by the code their message starts with. */
export type BookingReviewRuleRefusal = 'forbidden' | 'not_found' | 'unknown_counterparty' | 'invalid'

export class BookingReviewRuleWriteError extends Error {
  constructor(
    readonly refusal: BookingReviewRuleRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'BookingReviewRuleWriteError'
  }
}

function refusalOf(error: { message?: string; code?: string }): BookingReviewRuleWriteError | null {
  const message = error.message ?? ''
  if (message.startsWith('BOOKING_REVIEW_RULE_FORBIDDEN')) return new BookingReviewRuleWriteError('forbidden', message)
  if (message.startsWith('BOOKING_REVIEW_RULE_NOT_FOUND')) return new BookingReviewRuleWriteError('not_found', message)
  if (message.startsWith('BOOKING_REVIEW_RULE_UNKNOWN_COUNTERPARTY')) {
    return new BookingReviewRuleWriteError('unknown_counterparty', message)
  }
  if (message.startsWith('BOOKING_REVIEW_RULE_INVALID')) return new BookingReviewRuleWriteError('invalid', message)
  return null
}

/** Create a rule (save_booking_review_rule). Runs as the signed-in person: owner or admin. */
export async function createBookingReviewRule(
  supabase: SupabaseClient,
  companyId: string,
  input: BookingReviewRuleInput,
): Promise<{ id: string; rule_id: string; version: number }> {
  const { data, error } = await supabase.rpc('save_booking_review_rule', {
    p_company_id: companyId,
    p_accounts: input.accounts && input.accounts.length > 0 ? input.accounts : null,
    p_counterparty: input.counterparty ?? null,
    p_amount_from_sek: input.amount_from_sek ?? null,
    p_vat_treatment: input.vat_treatment ?? null,
    p_note: input.note ?? null,
    p_supersedes: null,
  })
  if (error) throw refusalOf(error) ?? error
  const result = data as { id: string; rule_id: string; version: number }
  return { id: result.id, rule_id: result.rule_id, version: result.version }
}

/** Archive a rule (archive_booking_review_rule): it stops matching now, its history stays. */
export async function archiveBookingReviewRule(
  supabase: SupabaseClient,
  companyId: string,
  ruleId: string,
): Promise<{ id: string; rule_id: string; version: number }> {
  const { data, error } = await supabase.rpc('archive_booking_review_rule', {
    p_company_id: companyId,
    p_rule_id: ruleId,
  })
  if (error) throw refusalOf(error) ?? error
  const result = data as { id: string; rule_id: string; version: number }
  return { id: result.id, rule_id: result.rule_id, version: result.version }
}
