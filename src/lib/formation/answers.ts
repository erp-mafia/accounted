/**
 * The founder's answers for a new aktiebolag with cash share capital: the
 * values verksamt.se's "Registrera aktiebolag med pengar" asks for, plus
 * the few Skatteverket and bank choices that shape the package. Stored as
 * jsonb on `company_formations.answers`; personnummer are sealed before
 * they are stored (see `store.ts`), so this schema validates the plain
 * shape the browser sends and the server seals.
 */

import { z } from 'zod'
import { roundOre } from '@/lib/money'

export const MIN_SHARE_CAPITAL = 25_000
/** verksamt.se's own default for a simple filing: 500 shares at 50 kr. */
export const DEFAULT_SHARE_COUNT = 500
export const MAX_FOUNDERS = 3
export const MAX_NAME_PROPOSALS = 4

export const BANKS = ['seb', 'swedbank', 'handelsbanken', 'nordea', 'danske', 'lunar', 'svea', 'other'] as const
export type BankId = (typeof BANKS)[number]

export const ROLE_KEYS = ['ledamot', 'suppleant', 'ordforande', 'vd'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

const trimmed = (max: number) => z.string().trim().max(max)

export const personSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.literal('person'),
  name: trimmed(120),
  /**
   * What the founder typed (10 or 12 digits). The server never stores it:
   * it seals a valid number into `personnummerSealed` and answers the
   * browser with this field empty and `personnummerLast4` set.
   */
  personnummer: trimmed(20).optional().default(''),
  /** The last four digits of the sealed number, for display. */
  personnummerLast4: z.string().length(4).regex(/^\d+$/).optional(),
  /** AES-GCM sealed 12-digit personnummer. Server-side only, stripped before any answer leaves it. */
  personnummerSealed: z.string().max(400).optional(),
  email: trimmed(200).optional().default(''),
  /** Shares this person subscribes for; 0 = not a founder. */
  shares: z.number().int().min(0).max(100_000_000).default(0),
  roles: z.array(z.enum(ROLE_KEYS)).max(4).default([]),
})

export const companyFounderSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.literal('company'),
  name: trimmed(200),
  orgNumber: trimmed(20),
  /** Names of the people who sign for that company. */
  signatories: z.array(trimmed(120)).max(4).default([]),
  shares: z.number().int().min(0).max(100_000_000).default(0),
  /** People who ultimately control that company, for the beneficial-owner report. */
  controlledBy: z.array(trimmed(120)).max(4).default([]),
})

export const partySchema = z.discriminatedUnion('type', [personSchema, companyFounderSchema])
export type FormationPerson = z.infer<typeof personSchema>
export type FormationCompanyFounder = z.infer<typeof companyFounderSchema>
export type FormationParty = z.infer<typeof partySchema>

export const SIGNATORY_RULES = ['board', 'board_or_each', 'board_or_two'] as const
export type SignatoryRule = (typeof SIGNATORY_RULES)[number]

export const formationAnswersSchema = z.object({
  version: z.literal(1).default(1),
  names: z.array(trimmed(120)).max(MAX_NAME_PROPOSALS).default(['']),
  /** The rest of the sentence after "Aktiebolaget ska bedriva". */
  description: trimmed(1000).default(''),
  /** The municipality (kommun) where the board has its seat. */
  seat: trimmed(80).default(''),
  address: z
    .object({
      co: trimmed(120).default(''),
      street: trimmed(160).default(''),
      postalCode: trimmed(10).default(''),
      city: trimmed(80).default(''),
    })
    .default({ co: '', street: '', postalCode: '', city: '' }),
  companyEmail: trimmed(200).default(''),
  contact: z
    .object({ name: trimmed(120).default(''), email: trimmed(200).default(''), phone: trimmed(40).default('') })
    .default({ name: '', email: '', phone: '' }),
  capital: z
    .object({
      amount: z.number().int().min(0).max(1_000_000_000).default(MIN_SHARE_CAPITAL),
      shares: z.number().int().min(1).max(100_000_000).default(DEFAULT_SHARE_COUNT),
    })
    .default({ amount: MIN_SHARE_CAPITAL, shares: DEFAULT_SHARE_COUNT }),
  parties: z.array(partySchema).max(12).default([]),
  signatoryRule: z.enum(SIGNATORY_RULES).default('board'),
  auditor: z
    .object({ has: z.boolean().default(false), name: trimmed(160).default('') })
    .default({ has: false, name: '' }),
  /** First month of the fiscal year, 1 = January (calendar year). */
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  /** Run the first fiscal year to the second year-end (up to 18 months) instead of the first. */
  extendFirstYear: z.boolean().default(false),
  noticeByEmail: z.boolean().default(true),
  bank: z.enum(BANKS).nullable().default(null),
  tax: z
    .object({
      expectedTurnover: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
      expectedProfit: z.number().int().min(-1_000_000_000).max(1_000_000_000).nullable().default(null),
      ownerSalary: z.enum(['now', 'later', 'no']).default('later'),
      vatPeriod: z.enum(['quarter', 'month', 'year']).default('quarter'),
    })
    .default({ expectedTurnover: null, expectedProfit: null, ownerSalary: 'later', vatPeriod: 'quarter' }),
})

export type FormationAnswers = z.infer<typeof formationAnswersSchema>

export function emptyAnswers(): FormationAnswers {
  return formationAnswersSchema.parse({})
}

export function persons(a: FormationAnswers): FormationPerson[] {
  return a.parties.filter((p): p is FormationPerson => p.type === 'person')
}

export function founders(a: FormationAnswers): FormationParty[] {
  return a.parties.filter((p) => p.shares > 0)
}

export function hasRole(p: FormationParty, role: RoleKey): boolean {
  return p.type === 'person' && p.roles.includes(role)
}

export function boardMembers(a: FormationAnswers): FormationPerson[] {
  return persons(a).filter((p) => p.roles.includes('ledamot'))
}

export function deputies(a: FormationAnswers): FormationPerson[] {
  return persons(a).filter((p) => p.roles.includes('suppleant'))
}

/** The proposed name, or a neutral placeholder before one is given. */
export function primaryName(a: FormationAnswers): string {
  return a.names.find((n) => n.trim().length > 0)?.trim() ?? 'Aktiebolaget'
}

/** Quota value per share in kronor (aktiekapital / antal aktier), öre precision. */
export function quotaValue(a: FormationAnswers): number {
  if (a.capital.shares <= 0) return 0
  return roundOre(a.capital.amount / a.capital.shares)
}
