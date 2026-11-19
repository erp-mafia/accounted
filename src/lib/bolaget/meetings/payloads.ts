/**
 * The terms of each kind of decision, validated in code before a decision
 * is stored (corporate_decisions.payload). One schema per kind; strict, so
 * nothing else (a personnummer among it) rides along. Names and party ids
 * only.
 *
 * The capital kinds (utdelning, nyemission, fondemission, minskning,
 * optioner, återbetalning av villkorat tillskott) are stored here and booked
 * by a later wave, which reads them through loadDecision (./store.ts).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { COMPANY_ROLE_KINDS } from '../types'
import type { DecisionKind } from './types'

const Uuid = z.string().uuid()
const Money = z.number().min(0).max(1e13)
const SignedMoney = z.number().min(-1e13).max(1e13)
const Count = z.number().int().min(1).max(1_000_000_000)
const Name = z.string().trim().min(1).max(200)
const IsoDate = saneIsoDateSchema
const Kind = z.enum(['person', 'company'])
// A company's org number (a revisionsbolag). Never a personnummer: the service refuses one.
const Org = z.string().trim().max(20)

/** A person or company the decision names: an existing party, or a name. */
const PartyRef = { party_id: Uuid.nullish(), name: Name }

export const BOARD_ELECTION_ROLES = ['styrelseledamot', 'styrelseordforande', 'styrelsesuppleant'] as const
export const AUDITOR_ELECTION_ROLES = ['revisor', 'huvudansvarig_revisor', 'revisorssuppleant'] as const

export const DECISION_PAYLOAD_SCHEMAS = {
  /** ABL 7:11 p. 1: the stämma adopts the resultaträkning and balansräkning. */
  faststallande_rr_br: z
    .object({
      fiscal_period_id: Uuid.nullish(),
      annual_report_version_id: Uuid.nullish(),
    })
    .strict(),
  /** ABL 7:11 p. 2: the disposition of the profit or loss in the adopted balansräkning. */
  resultatdisposition: z
    .object({
      fiscal_period_id: Uuid.nullish(),
      /** The stämma followed the board's proposal (ÅRL 6:2). */
      follows_board_proposal: z.boolean().default(true),
      /** Fritt eget kapital at the stämma's disposal. */
      available_amount: SignedMoney.nullish(),
      dividend_total: Money.nullish(),
      carried_forward: SignedMoney.nullish(),
      board_proposal_text: z.string().trim().max(4000).nullish(),
    })
    .strict(),
  /** ABL 18:3: the amount per share and, outside an avstämningsbolag, the betalningsdag. */
  utdelning: z
    .object({
      amount_per_share: Money,
      share_count: Count,
      total_amount: Money,
      payment_date: IsoDate.nullish(),
      share_class_code: z.string().trim().max(12).nullish(),
      fiscal_period_id: Uuid.nullish(),
    })
    .strict(),
  /** ABL 7:11 p. 3: discharge for each board member and the VD. */
  ansvarsfrihet: z
    .object({
      fiscal_period_id: Uuid.nullish(),
      persons: z
        .array(
          z
            .object({
              ...PartyRef,
              roles: z.array(z.enum(COMPANY_ROLE_KINDS)).max(6).default([]),
              granted: z.boolean().default(true),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  /** ABL 8:8: the stämma elects the board (and suppleanter). */
  val_styrelse: z
    .object({
      members: z.array(z.object({ ...PartyRef, role: z.enum(BOARD_ELECTION_ROLES) }).strict()).max(30),
      /** e.g. "intill slutet av nästa årsstämma" (ABL 8:13). */
      term: z.string().trim().max(200).nullish(),
    })
    .strict(),
  /** ABL 9:8: the stämma elects the revisor. */
  val_revisor: z
    .object({
      auditors: z
        .array(
          z
            .object({
              ...PartyRef,
              kind: Kind.default('person'),
              org_number: Org.nullish(),
              role: z.enum(AUDITOR_ELECTION_ROLES),
            })
            .strict(),
        )
        .max(10),
      term: z.string().trim().max(200).nullish(),
      /** The bolagsordning has no revisor (ABL 9:1 second para). */
      no_auditor: z.boolean().default(false),
    })
    .strict(),
  arvoden: z
    .object({
      board_fees: z.array(z.object({ ...PartyRef, amount: Money }).strict()).max(30).default([]),
      board_fee_total: Money.nullish(),
      auditor_fee: z.string().trim().max(500).nullish(),
    })
    .strict(),
  /** ABL 3:4-5: decided by the stämma, filed with Bolagsverket at once. */
  andrad_bolagsordning: z
    .object({
      sections: z.string().trim().max(500).nullish(),
      new_wording: z.string().trim().max(8000).nullish(),
    })
    .strict(),
  /** ABL 13 kap. */
  nyemission: z
    .object({
      share_count: Count,
      price_per_share: Money,
      share_class_code: z.string().trim().max(12).nullish(),
      subscription_end: IsoDate.nullish(),
      payment_date: IsoDate.nullish(),
      subscribers: z.array(z.object({ ...PartyRef, share_count: Count }).strict()).max(100).default([]),
    })
    .strict(),
  /** ABL 12 kap. */
  fondemission: z
    .object({
      amount: Money,
      new_share_count: Count.nullish(),
      source: z.string().trim().max(200).nullish(),
    })
    .strict(),
  /** ABL 20 kap. */
  minskning: z
    .object({
      amount: Money,
      purpose: z.enum(['tackning_forlust', 'aterbetalning', 'fri_fond']).nullish(),
      cancelled_share_count: Count.nullish(),
    })
    .strict(),
  /** ABL 14 kap. */
  optioner: z
    .object({
      option_count: Count,
      strike_price: Money,
      subscription_end: IsoDate.nullish(),
      exercise_end: IsoDate.nullish(),
    })
    .strict(),
  /** K2 15.6: repayment of a villkorat tillskott needs a stämma decision. */
  aterbetalning_villkorat_tillskott: z
    .object({
      total_amount: Money,
      recipients: z.array(z.object({ ...PartyRef, amount: Money }).strict()).max(50).default([]),
      payment_date: IsoDate.nullish(),
    })
    .strict(),
  /** A procedural item (öppnande, val av ordförande, ...) or anything else. */
  ovrigt: z
    .object({
      topic: z.string().trim().max(60).nullish(),
    })
    .strict(),
} as const satisfies Record<DecisionKind, z.ZodType>

export type DecisionPayloads = { [K in DecisionKind]: z.output<(typeof DECISION_PAYLOAD_SCHEMAS)[K]> }
export type DecisionPayload<K extends DecisionKind> = DecisionPayloads[K]

export type PayloadCheck<K extends DecisionKind> =
  | { ok: true; payload: DecisionPayload<K> }
  | { ok: false; issues: Array<{ field: string; message: string }> }

/** The payload of a kind, validated; defaults filled in. */
export function parseDecisionPayload<K extends DecisionKind>(kind: K, payload: unknown): PayloadCheck<K> {
  const schema = DECISION_PAYLOAD_SCHEMAS[kind] as unknown as z.ZodType<DecisionPayload<K>>
  const parsed = schema.safeParse(payload ?? {})
  if (parsed.success) return { ok: true, payload: parsed.data }
  return { ok: false, issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }
}
