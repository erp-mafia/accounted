/**
 * Reads and writes `company_formations` for the signed-in user. Every
 * statement runs on the service role and is scoped to the user's own id
 * (the table has no write policies), so payment, company and setup columns
 * can only change through the functions here.
 *
 * Personnummer: a valid number the founder typed is sealed into
 * `personnummerSealed` (the salary module's AES-256-GCM key) with only its
 * last four digits kept readable; an invalid one is never stored. Answers
 * leave the server through `publicAnswers`, which strips the sealed values.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'
import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'
import { type FormationAnswers, formationAnswersSchema } from './answers'
import { blockingIssues } from './rules'

/** 'paid' and the stripe_* columns are unused: nothing sets them. */
export const FORMATION_STATUSES = ['draft', 'paid', 'submitted', 'set_up', 'cancelled'] as const
export type FormationStatus = (typeof FORMATION_STATUSES)[number]

export interface FormationRow {
  id: string
  user_id: string
  status: FormationStatus
  answers: unknown
  stripe_checkout_session_id: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  paid_at: string | null
  submitted_at: string | null
  deed_date: string | null
  company_id: string | null
  setup_state: Record<string, unknown>
  set_up_at: string | null
  created_at: string
  updated_at: string
}

export interface FormationView {
  id: string
  status: FormationStatus
  answers: FormationAnswers
  /**
   * Every answer the documents need is given and breaks no rule, so the
   * package opens. The package is free: nothing else gates it.
   */
  ready: boolean
  submittedAt: string | null
  deedDate: string | null
  companyId: string | null
  setUpAt: string | null
}

const COLUMNS =
  'id, user_id, status, answers, stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id, paid_at, submitted_at, deed_date, company_id, setup_state, set_up_at, created_at, updated_at'

/** Parse stored answers; a row written by an older shape still loads with defaults. */
export function parseStoredAnswers(raw: unknown): FormationAnswers {
  const parsed = formationAnswersSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : formationAnswersSchema.parse({})
}

/** The answers as the browser may see them: no sealed values, no plain numbers. */
export function publicAnswers(answers: FormationAnswers): FormationAnswers {
  return {
    ...answers,
    parties: answers.parties.map((p) => {
      if (p.type !== 'person') return p
      const { personnummerSealed: _sealed, ...rest } = p
      return { ...rest, personnummer: '' }
    }),
  }
}

/**
 * Merge what the browser sent with what is stored: a typed valid number is
 * sealed, an empty field keeps the sealed number of the same party, and a
 * sealed value sent from the browser is ignored.
 */
export function sealAnswers(incoming: FormationAnswers, previous: FormationAnswers | null, now = new Date()): FormationAnswers {
  const before = new Map((previous?.parties ?? []).map((p) => [p.id, p]))
  return {
    ...incoming,
    parties: incoming.parties.map((p) => {
      if (p.type !== 'person') return p
      const prior = before.get(p.id)
      const { personnummerSealed: _ignored, personnummerLast4: _last4, ...rest } = p
      const typed = (p.personnummer ?? '').trim()
      if (typed) {
        const full = expandPersonnummerTo12(typed, now)
        if (full && validatePersonnummer(full).valid) {
          return { ...rest, personnummer: '', personnummerSealed: encryptPersonnummer(full), personnummerLast4: full.slice(-4) }
        }
        // Not a valid number: never stored. The browser keeps what was typed.
        return { ...rest, personnummer: '' }
      }
      if (prior && prior.type === 'person' && prior.personnummerSealed) {
        return { ...rest, personnummer: '', personnummerSealed: prior.personnummerSealed, personnummerLast4: prior.personnummerLast4 }
      }
      return { ...rest, personnummer: '' }
    }),
  }
}

/** Server-side only: the answers with every sealed number opened, for documents and setup. */
export function openAnswers(answers: FormationAnswers): FormationAnswers {
  return {
    ...answers,
    parties: answers.parties.map((p) =>
      p.type === 'person' && p.personnummerSealed ? { ...p, personnummer: decryptPersonnummer(p.personnummerSealed) } : p,
    ),
  }
}

/** The stored answers break no rule (a sealed personnummer counts as given). */
export function isReady(row: Pick<FormationRow, 'answers'>): boolean {
  return blockingIssues(parseStoredAnswers(row.answers)).length === 0
}

export function toView(row: FormationRow): FormationView {
  return {
    id: row.id,
    status: row.status,
    answers: publicAnswers(parseStoredAnswers(row.answers)),
    ready: isReady(row),
    submittedAt: row.submitted_at,
    deedDate: row.deed_date,
    companyId: row.company_id,
    setUpAt: row.set_up_at,
  }
}

export async function getFormation(service: SupabaseClient, userId: string, id: string): Promise<FormationRow | null> {
  const { data, error } = await service.from('company_formations').select(COLUMNS).eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) throw error
  return (data as FormationRow | null) ?? null
}

/** The user's current formation: the newest one that is not cancelled. */
export async function currentFormation(service: SupabaseClient, userId: string): Promise<FormationRow | null> {
  const { data, error } = await service
    .from('company_formations')
    .select(COLUMNS)
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as FormationRow | null) ?? null
}

export async function createFormation(service: SupabaseClient, userId: string, answers: FormationAnswers): Promise<FormationRow> {
  const sealed = sealAnswers(answers, null)
  const { data, error } = await service
    .from('company_formations')
    .insert({ user_id: userId, answers: sealed })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data as FormationRow
}

export class FormationStateError extends Error {
  constructor(public readonly code: 'FORMATION_NOT_FOUND' | 'FORMATION_LOCKED' | 'FORMATION_INCOMPLETE' | 'FORMATION_ALREADY_SET_UP') {
    super(code)
  }
}

/** Save answers while the company is not yet set up. */
export async function saveAnswers(service: SupabaseClient, userId: string, id: string, incoming: FormationAnswers): Promise<FormationRow> {
  const row = await getFormation(service, userId, id)
  if (!row) throw new FormationStateError('FORMATION_NOT_FOUND')
  if (row.status === 'set_up' || row.status === 'cancelled') throw new FormationStateError('FORMATION_LOCKED')
  const sealed = sealAnswers(incoming, parseStoredAnswers(row.answers))
  const { data, error } = await service
    .from('company_formations')
    .update({ answers: sealed })
    .eq('user_id', userId)
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data as FormationRow
}

/** The founder says every founder has signed and the application is sent in. */
export async function markSubmitted(service: SupabaseClient, userId: string, id: string, deedDate: string): Promise<FormationRow> {
  const row = await getFormation(service, userId, id)
  if (!row) throw new FormationStateError('FORMATION_NOT_FOUND')
  if (row.status === 'set_up') throw new FormationStateError('FORMATION_ALREADY_SET_UP')
  if (!isReady(row)) throw new FormationStateError('FORMATION_INCOMPLETE')
  const { data, error } = await service
    .from('company_formations')
    .update({ status: 'submitted', submitted_at: new Date().toISOString(), deed_date: deedDate })
    .eq('user_id', userId)
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data as FormationRow
}
