/**
 * Changes of the aktiekapital: nyemission (ABL 13 kap.), fondemission
 * (12 kap.) and minskning (20 kap.), from the decision to Bolagsverket's
 * registration.
 *
 *   Nyemission: the allotted shares go into the aktiebok genast (13:18) as
 *   nyemission entries carrying the decision; the payment is booked on
 *   2082 Ej registrerat aktiekapital (kvotvärde) and 2097 Fri överkursfond
 *   (överkurs); full payment comes before registration (13:28); on
 *   registration the capital moves to 2081 (13:29). The decision is filed
 *   within six months (13:27).
 *   Fondemission: filed genast; on registration the fund (12:1) moves to
 *   2081 and new shares, if any, go into the aktiebok (12:10).
 *   Minskning: filed within four months (20:19); effective on registration
 *   (20:20), when 2081 moves to 2091 (loss cover, free fund) or to 2890
 *   (repayment owed to the holders); the cancelled shares are struck from
 *   the aktiebok genast (20:21) and their holders told by post (20:18).
 *
 * Each date the law sets becomes a deadline (deadlines.ts). Aktiebok entries
 * other than a nyemission's allotment are made in Ägare och aktiebok, which
 * holds the share numbers; the warnings say when.
 */
import { addDaysIso, addMonthsIso, todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { checkPartyRef, type PartyRef } from '../people'
import { registerShareEvent } from '../share-register'
import { completeCapitalDeadlines, upsertCapitalDeadline } from './deadlines'
import { fondemissionLines, minskningLines, nyemissionPaymentLines, nyemissionRegistrationLines, postCapitalEntry, type CapitalLine } from './postings'
import {
  CAPITAL_CHANGE_LABELS_SV,
  DEFAULT_BANK_ACCOUNT,
  minskningTargetAccount,
  type CapitalChangeKind,
  type CapitalChangeStatus,
  type CapitalDecidedBy,
  type FondemissionSourceAccount,
  type MinskningPurpose,
} from './types'

export interface Allotment {
  party_id: string | null
  name?: string | null
  share_count: number
  amount: number
  share_register_event_id: string | null
}

export interface CapitalChangeRow {
  id: string
  kind: CapitalChangeKind
  decided_on: string
  decided_by: CapitalDecidedBy
  decision_id: string | null
  document_id: string | null
  share_class_id: string | null
  share_count: number
  share_capital_amount: number
  price_per_share: number | null
  premium_amount: number
  subscription_start: string | null
  subscription_end: string | null
  source_account: FondemissionSourceAccount | null
  purpose: MinskningPurpose | null
  target_account: string | null
  allotments: Allotment[]
  registered_on: string | null
  payment_entry_id: string | null
  registration_entry_id: string | null
  status: CapitalChangeStatus
  note: string | null
  created_at: string
}


function normalise(row: Record<string, unknown>): CapitalChangeRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    ...(row as unknown as CapitalChangeRow),
    share_count: Number(row.share_count),
    share_capital_amount: Number(row.share_capital_amount),
    price_per_share: num(row.price_per_share),
    premium_amount: Number(row.premium_amount ?? 0),
    allotments: Array.isArray(row.allotments) ? (row.allotments as Allotment[]) : [],
  }
}

export async function loadCapitalChanges(ctx: OperationContext): Promise<CapitalChangeRow[]> {
  const { data, error } = await ctx.supabase.from('capital_changes').select('id, kind, decided_on, decided_by, decision_id, document_id, share_class_id, share_count, share_capital_amount, price_per_share, premium_amount, subscription_start, subscription_end, source_account, purpose, target_account, allotments, registered_on, payment_entry_id, registration_entry_id, status, note, created_at').eq('company_id', ctx.companyId).order('decided_on', { ascending: false })
  if (error) throw new Error(`capital_changes read failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normalise)
}

async function loadCapitalChange(ctx: OperationContext, id: string): Promise<CapitalChangeRow | null> {
  const { data, error } = await ctx.supabase.from('capital_changes').select('id, kind, decided_on, decided_by, decision_id, document_id, share_class_id, share_count, share_capital_amount, price_per_share, premium_amount, subscription_start, subscription_end, source_account, purpose, target_account, allotments, registered_on, payment_entry_id, registration_entry_id, status, note, created_at').eq('company_id', ctx.companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(`capital_changes read failed: ${error.message}`)
  return data ? normalise(data as Record<string, unknown>) : null
}

/** Kvotvärde from the company settings (aktiekapital / antal aktier), or null when either is missing. */
async function quotaValue(ctx: OperationContext): Promise<number | null> {
  const { data } = await ctx.supabase.from('company_settings').select('aktiekapital, antal_aktier').eq('company_id', ctx.companyId).maybeSingle()
  const row = data as { aktiekapital: number | string | null; antal_aktier: number | string | null } | null
  const capital = Number(row?.aktiekapital ?? 0)
  const shares = Number(row?.antal_aktier ?? 0)
  return capital > 0 && shares > 0 ? capital / shares : null
}

function warning(code: string, sv: string, en: string): OperationWarning {
  return { code, message_sv: sv, message_en: en }
}

export interface CapitalChangeInput {
  kind: CapitalChangeKind
  decided_on: string
  decided_by: CapitalDecidedBy
  decision_id?: string | null
  document_id?: string | null
  share_class_id?: string | null
  /** New shares (emission) or cancelled shares (minskning); 0 when only the kvotvärde changes. */
  share_count: number
  /** The change of aktiekapital; kvotvärde x share_count when absent. */
  share_capital_amount?: number | null
  /** Nyemission: the subscription price per share. */
  price_per_share?: number | null
  subscription_start?: string | null
  subscription_end?: string | null
  /** Fondemission: the fund drawn on (ABL 12:1); 2091 when absent. */
  source_account?: FondemissionSourceAccount | null
  /** Minskning: the purpose (ABL 20:1). */
  purpose?: MinskningPurpose | null
  /** Nyemission: who was allotted how many shares; entered in the aktiebok genast (13:18). */
  allotments?: Array<PartyRef & { share_count: number }> | null
  /** The allotment day; the decision day when absent. */
  allotted_on?: string | null
  note?: string | null
}

export interface CapitalChangeCreated {
  capital_change_id: string
  kind: CapitalChangeKind
  share_capital_amount: number
  premium_amount: number
  share_register_event_ids: string[]
}

function deadlineDrafts(id: string, kind: CapitalChangeKind, decidedOn: string) {
  const key = `bolaget:capital:${id}`
  if (kind === 'nyemission') {
    return [{
      sourceKey: `${key}:registration`,
      title: 'Anmäl nyemissionen till Bolagsverket',
      dueOn: addMonthsIso(decidedOn, 6),
      priority: 'critical' as const,
      notes: `Nyemission beslutad ${decidedOn}. Beslutet ska anmälas för registrering inom sex månader, annars faller det (13 kap. 27 och 30 §§ ABL). Aktierna ska vara fullt betalda innan registrering (13 kap. 28 §).`,
    }]
  }
  if (kind === 'fondemission') {
    return [{
      sourceKey: `${key}:registration`,
      title: 'Anmäl fondemissionen till Bolagsverket',
      dueOn: addDaysIso(decidedOn, 7),
      priority: 'important' as const,
      notes: `Fondemission beslutad ${decidedOn}. Beslutet ska genast anmälas för registrering (12 kap. 10 § ABL).`,
    }]
  }
  return [
    {
      sourceKey: `${key}:registration`,
      title: 'Anmäl minskningen av aktiekapitalet till Bolagsverket',
      dueOn: addMonthsIso(decidedOn, 4),
      priority: 'critical' as const,
      notes: `Minskning av aktiekapitalet beslutad ${decidedOn}. Beslutet ska anmälas för registrering inom fyra månader, annars faller det (20 kap. 19 § ABL).`,
    },
    {
      sourceKey: `${key}:notice`,
      title: 'Underrätta ägarna vars aktier dras in',
      dueOn: addDaysIso(decidedOn, 7),
      priority: 'important' as const,
      notes: `Minskning av aktiekapitalet beslutad ${decidedOn}. Ägare vars aktier dras in ska underrättas skriftligen per post (20 kap. 18 § ABL).`,
    },
  ]
}

export async function createCapitalChange(
  ctx: OperationContext,
  input: CapitalChangeInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<CapitalChangeCreated>> {
  const today = todayIsoStockholm()
  if (input.decided_on > today) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Beslutsdagen kan inte ligga i framtiden.' }
  if (!Number.isInteger(input.share_count) || input.share_count < 0) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange antalet aktier.' }
  const warnings: OperationWarning[] = []
  const quota = await quotaValue(ctx)
  const capital = input.share_capital_amount != null ? roundOre(input.share_capital_amount) : quota !== null ? roundOre(quota * input.share_count) : null
  if (!capital || capital <= 0) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange hur mycket aktiekapitalet ändras (kvotvärdet saknas i företagsinställningarna).' }
  }

  let premium = 0
  const allotments: Array<PartyRef & { share_count: number }> = input.allotments ?? []
  if (input.kind === 'nyemission') {
    if (input.share_count < 1) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'En nyemission ger ut minst en aktie.' }
    if (!(input.price_per_share && input.price_per_share > 0)) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange teckningskursen per aktie.' }
    const paid = roundOre(input.price_per_share * input.share_count)
    if (paid < capital) {
      return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Teckningskursen kan inte vara lägre än kvotvärdet.' }
    }
    premium = roundOre(paid - capital)
    if (allotments.length > 0) {
      const allotted = allotments.reduce((n, a) => n + a.share_count, 0)
      if (allotted !== input.share_count) {
        return { ok: false, code: 'VALIDATION_ERROR', messageSv: `Tilldelningen (${allotted} aktier) stämmer inte med emissionen (${input.share_count} aktier).` }
      }
      for (const a of allotments) checkPartyRef(a, 'tecknaren')
    } else {
      warnings.push(warning(
        'CAPITAL_ALLOTMENT_MISSING',
        'Ange tilldelningen så förs de nya aktierna in i aktieboken genast (13 kap. 18 § ABL).',
        'Give the allotment so the new shares are entered in the share register at once (ABL 13:18).',
      ))
    }
    if (input.decided_by === 'styrelse') {
      warnings.push(warning(
        'CAPITAL_BOARD_DECISION',
        'Ett styrelsebeslut om nyemission kräver bolagsstämmans bemyndigande eller godkännande; utan godkännande förs inget in i aktieboken (13 kap. 32 § ABL).',
        'A board decision on a new issue needs the general meeting\'s authorisation or approval (ABL 13:32).',
      ))
    }
  } else if (input.kind === 'fondemission') {
    warnings.push(warning(
      'CAPITAL_REGISTER_AFTER_REGISTRATION',
      'Nya aktier från fondemissionen förs in i aktieboken när Bolagsverket har registrerat beslutet (12 kap. 10 § ABL), under Ägare och aktiebok.',
      'New bonus shares are entered in the share register once Bolagsverket has registered the decision (ABL 12:10).',
    ))
  } else {
    if (!input.purpose) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange ändamålet med minskningen.' }
    warnings.push(warning(
      'CAPITAL_REGISTER_AFTER_REGISTRATION',
      'Aktier som dras in stryks ur aktieboken genast när minskningen registrerats (20 kap. 21 § ABL), under Ägare och aktiebok.',
      'Cancelled shares are struck from the share register as soon as the reduction is registered (ABL 20:21).',
    ))
  }
  const source = input.kind === 'fondemission' ? input.source_account ?? '2091' : null
  const target = input.kind === 'minskning' && input.purpose ? minskningTargetAccount(input.purpose) : null

  // Every allotment must fit the aktiebok before anything is written.
  const allottedOn = input.allotted_on ?? input.decided_on
  const priceTotal = (count: number) => roundOre((input.price_per_share ?? 0) * count)
  for (const a of allotments) {
    const check = await registerShareEvent(
      ctx,
      { kind: 'nyemission', event_date: allottedOn, share_class_id: input.share_class_id ?? null, to_party_id: a.party_id ?? null, to_name: a.name ?? null, to_kind: a.kind ?? null, to_org_number: a.org_number ?? null, share_count: a.share_count, price_total: priceTotal(a.share_count), decision_id: input.decision_id ?? null },
      { dryRun: true },
    )
    if (!check.ok) return check
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        kind: input.kind,
        kind_label: CAPITAL_CHANGE_LABELS_SV[input.kind],
        decided_on: input.decided_on,
        decided_by: input.decided_by,
        share_count: input.share_count,
        share_capital_amount: capital,
        premium_amount: premium,
        source_account: source,
        target_account: target,
        allotments: allotments.map((a) => ({ party_id: a.party_id ?? null, name: a.name ?? null, share_count: a.share_count })),
        deadlines: deadlineDrafts('preview', input.kind, input.decided_on).map((d) => ({ title: d.title, due_on: d.dueOn })),
        warnings: warnings.map((w) => w.message_sv),
      },
    }
  }

  const created: Allotment[] = []
  for (const a of allotments) {
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'nyemission', event_date: allottedOn, share_class_id: input.share_class_id ?? null, to_party_id: a.party_id ?? null, to_name: a.name ?? null, to_kind: a.kind ?? null, to_org_number: a.org_number ?? null, share_count: a.share_count, price_total: priceTotal(a.share_count), decision_id: input.decision_id ?? null, created_via: ctx.pendingOperationId ? 'mcp' : 'app' },
      { dryRun: false },
    )
    if (!outcome.ok || outcome.dryRun) {
      return outcome.ok ? { ok: false, code: 'UNKNOWN_ERROR' } : { ...outcome, details: { ...(outcome.details ?? {}), entered: created.map((c) => c.share_register_event_id) } }
    }
    created.push({ party_id: outcome.data.to_party_id, share_count: a.share_count, amount: priceTotal(a.share_count), share_register_event_id: outcome.data.share_register_event_id })
  }

  const { data, error } = await ctx.supabase
    .from('capital_changes')
    .insert({
      company_id: ctx.companyId,
      kind: input.kind,
      decided_on: input.decided_on,
      decided_by: input.decided_by,
      decision_id: input.decision_id ?? null,
      document_id: input.document_id ?? null,
      share_class_id: input.share_class_id ?? null,
      share_count: input.share_count,
      share_capital_amount: capital,
      price_per_share: input.kind === 'nyemission' ? input.price_per_share : null,
      premium_amount: premium,
      subscription_start: input.subscription_start ?? null,
      subscription_end: input.subscription_end ?? null,
      source_account: source,
      purpose: input.kind === 'minskning' ? input.purpose : null,
      target_account: target,
      allotments: created,
      status: 'decided',
      note: input.note?.trim() || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single()
  if (error) throw new Error(`capital_changes insert failed: ${error.message}`)
  const id = (data as { id: string }).id
  for (const draft of deadlineDrafts(id, input.kind, input.decided_on)) await upsertCapitalDeadline(ctx, draft)
  return {
    ok: true,
    data: {
      capital_change_id: id,
      kind: input.kind,
      share_capital_amount: capital,
      premium_amount: premium,
      share_register_event_ids: created.map((c) => c.share_register_event_id).filter((x): x is string => Boolean(x)),
    },
    created: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export interface BookCapitalChangeInput {
  capital_change_id: string
  /** payment: a nyemission's subscription money; registration: Bolagsverket registered the decision. */
  step: 'payment' | 'registration'
  /** The day the money came in, or the registration day. */
  date: string
  bank_account?: string | null
}

export interface CapitalChangeBooked {
  capital_change_id: string
  step: 'payment' | 'registration'
  journal_entry_id: string
  status: CapitalChangeStatus
}

export async function bookCapitalChange(
  ctx: OperationContext,
  input: BookCapitalChangeInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<CapitalChangeBooked>> {
  const change = await loadCapitalChange(ctx, input.capital_change_id)
  if (!change) return { ok: false, code: 'CAPITAL_CHANGE_NOT_FOUND' }
  if (change.status !== 'decided') return { ok: false, code: 'CAPITAL_CHANGE_STATUS_INVALID', details: { status: change.status } }
  if (input.date > todayIsoStockholm()) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Datumet kan inte ligga i framtiden.' }
  if (input.date < change.decided_on) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Datumet kan inte ligga före beslutet.' }
  const bank = input.bank_account ?? DEFAULT_BANK_ACCOUNT
  if (!/^19\d\d$/.test(bank)) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange ett bankkonto (19xx).' }

  let lines: CapitalLine[]
  if (input.step === 'payment') {
    if (change.kind !== 'nyemission') return { ok: false, code: 'CAPITAL_CHANGE_STATUS_INVALID', messageSv: 'Bara en nyemission betalas in.' }
    if (change.payment_entry_id) return { ok: false, code: 'CAPITAL_CHANGE_STATUS_INVALID', messageSv: 'Inbetalningen är redan bokförd.' }
    lines = nyemissionPaymentLines(bank, change.share_capital_amount, change.premium_amount)
  } else {
    // Full payment comes before registration (ABL 13:28).
    if (change.kind === 'nyemission' && !change.payment_entry_id) return { ok: false, code: 'CAPITAL_CHANGE_NOT_PAID' }
    lines =
      change.kind === 'nyemission'
        ? nyemissionRegistrationLines(change.share_capital_amount)
        : change.kind === 'fondemission'
          ? fondemissionLines(change.source_account ?? '2091', change.share_capital_amount)
          : minskningLines(change.target_account ?? '2091', change.share_capital_amount)
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        capital_change_id: change.id,
        kind: change.kind,
        step: input.step,
        entry_date: input.date,
        lines: lines.map((l) => ({ account_number: l.account_number, debit: l.debit_amount, credit: l.credit_amount })),
        warnings: [],
      },
    }
  }

  const label = CAPITAL_CHANGE_LABELS_SV[change.kind]
  const entry = await postCapitalEntry({
    supabase: ctx.supabase,
    companyId: ctx.companyId,
    userId: ctx.userId,
    entryDate: input.date,
    description: input.step === 'payment' ? `${label}: inbetalning` : `${label}: registrerad ${input.date}`,
    lines,
    category: null,
    pendingOperationId: ctx.pendingOperationId ?? null,
  })
  const { error } =
    input.step === 'payment'
      ? await ctx.supabase.from('capital_changes').update({ payment_entry_id: entry.id }).eq('company_id', ctx.companyId).eq('id', change.id)
      : await ctx.supabase
          .from('capital_changes')
          .update({ registration_entry_id: entry.id, registered_on: input.date, status: 'registered' })
          .eq('company_id', ctx.companyId)
          .eq('id', change.id)
  if (error) {
    ctx.log.error('[bolaget] capital change booked but not marked', new Error(error.message), { companyId: ctx.companyId, capitalChangeId: change.id })
    return { ok: false, code: 'CAPITAL_CHANGE_UPDATE_FAILED', partialPostedIds: { journal_entry_id: entry.id } }
  }
  if (input.step === 'registration') await completeCapitalDeadlines(ctx, `bolaget:capital:${change.id}:registration`)
  return {
    ok: true,
    data: { capital_change_id: change.id, step: input.step, journal_entry_id: entry.id, status: input.step === 'registration' ? 'registered' : 'decided' },
  }
}
