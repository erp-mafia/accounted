import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { isGroupHoldingAccount } from '@/lib/bokslut/group-holding-account'
import { AGREEMENT_KINDS, AGREEMENT_PERIODS, GROUP_RELATIONS, SECURITY_KINDS } from './types'

/**
 * The request contracts of commitments and holdings, shared by every door
 * (the dashboard's session routes, v1 and MCP through lib/operations/
 * commitments.ts). Strict: an unknown field is refused, never dropped.
 */
const date = saneIsoDateSchema
const money = z.number().nonnegative().max(10_000_000_000)
const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).nullish()
const percent = z.number().min(0).max(100)

const AgreementFields = {
  title: text(200).describe('What the agreement is, as the company calls it (e.g. Hyresavtal kontor Vasagatan).'),
  counterparty_name: optionalText(200).describe('The other party as named in the agreement.'),
  counterparty_party_id: z.string().uuid().nullish().describe('The counterparty in the company\'s parties (party_id), when known.'),
  starts_on: date.nullish().describe('yyyy-MM-dd the agreement starts.'),
  ends_on: date.nullish().describe('yyyy-MM-dd it ends or expires (bindningstid, maturity, expiry of a permit or domain).'),
  notice_months: z.number().int().min(0).max(120).nullish().describe('Uppsägningstid in months before ends_on; gives a notice date in Viktiga datum.'),
  renewal_terms: optionalText(500).describe('How it renews when not terminated, e.g. Förlängs 12 månader i taget.'),
  amount: money.nullish().describe('The recurring payment (or the one payment), SEK unless currency says otherwise.'),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional().describe('ISO 4217, default SEK.'),
  period: z.enum(AGREEMENT_PERIODS).nullish().describe('How often amount falls due.'),
  first_due_on: date.nullish().describe('yyyy-MM-dd of the first payment when it is not starts_on; later ones follow by period.'),
  principal: money.nullish().describe('A loan: the amount borrowed.'),
  interest_rate: z.number().min(0).max(100).nullish().describe('A loan: the annual interest rate in percent.'),
  document_id: z.string().uuid().nullish().describe('The archived document the agreement is in (document_id). Linked, never read into fields.'),
  notes: optionalText(4000),
}

function checkAgreementDates(
  v: { starts_on?: string | null; ends_on?: string | null; amount?: number | null; period?: string | null; first_due_on?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.starts_on && v.ends_on && v.ends_on < v.starts_on) {
    ctx.addIssue({ code: 'custom', path: ['ends_on'], message: 'Slutdatumet ligger före startdatumet.' })
  }
  if (v.amount != null && v.amount > 0 && v.period == null) {
    ctx.addIssue({ code: 'custom', path: ['period'], message: 'Ange hur ofta beloppet ska betalas.' })
  }
  if (v.first_due_on && v.ends_on && v.first_due_on > v.ends_on) {
    ctx.addIssue({ code: 'custom', path: ['first_due_on'], message: 'Första betalningen ligger efter slutdatumet.' })
  }
}

export const CreateAgreementSchema = z
  .object({
    kind: z.enum(AGREEMENT_KINDS).describe('rental, lease, loan, subscription, insurance, employment, shareholder, investment, customer, permit, ip_right, domain, guarantee or other.'),
    ...AgreementFields,
  })
  .strict()
  .superRefine(checkAgreementDates)
export type CreateAgreementInput = z.infer<typeof CreateAgreementSchema>

export const UpdateAgreementSchema = z
  .object({
    kind: z.enum(AGREEMENT_KINDS).optional(),
    ...Object.fromEntries(Object.entries(AgreementFields).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof AgreementFields]: z.ZodOptional<(typeof AgreementFields)[K]>
    },
  })
  .strict()
  .superRefine(checkAgreementDates)
export type UpdateAgreementInput = z.infer<typeof UpdateAgreementSchema>

export const EndAgreementSchema = z
  .object({
    ended_on: date.optional().describe('yyyy-MM-dd the agreement ended; default today. An earlier ends_on stays.'),
  })
  .strict()
export type EndAgreementInput = z.infer<typeof EndAgreementSchema>

const SecurityFields = {
  description: text(300).describe('What is pledged or promised, e.g. Företagsinteckning i Handelsbanken för checkkredit.'),
  amount: money.describe('SEK: the mortgage amount (pantbrev, företagsinteckning), the book value of the pledged asset or the amount of the guarantee.'),
  in_favour_of_name: optionalText(200).describe('Who the security or guarantee is given to.'),
  in_favour_of_party_id: z.string().uuid().nullish().describe('That party in the company\'s parties (party_id), when known.'),
  for_group_company: z.boolean().optional().describe('Given for or to a group company (ÅRL 5 kap. 16 §): stated apart in the note.'),
  agreement_id: z.string().uuid().nullish().describe('The loan agreement the security is for (agreement_id).'),
  valid_from: date.nullish().describe('yyyy-MM-dd it was given.'),
  valid_to: date.nullish().describe('yyyy-MM-dd it was released; open while it holds.'),
  document_id: z.string().uuid().nullish().describe('The archived document (pantförskrivning, borgensförbindelse).'),
  notes: optionalText(4000),
}

function checkValidity(v: { valid_from?: string | null; valid_to?: string | null }, ctx: z.RefinementCtx): void {
  if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) {
    ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'Slutdatumet ligger före startdatumet.' })
  }
}

export const CreateSecuritySchema = z
  .object({
    kind: z.enum(SECURITY_KINDS).describe('Ställd säkerhet: foretagsinteckning, fastighetsinteckning, aganderattsforbehall, belanad_fordran, other_security. Eventualförpliktelse: borgen, other_contingency.'),
    ...SecurityFields,
  })
  .strict()
  .superRefine(checkValidity)
export type CreateSecurityInput = z.infer<typeof CreateSecuritySchema>

export const UpdateSecuritySchema = z
  .object({
    kind: z.enum(SECURITY_KINDS).optional(),
    ...Object.fromEntries(Object.entries(SecurityFields).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof SecurityFields]: z.ZodOptional<(typeof SecurityFields)[K]>
    },
  })
  .strict()
  .superRefine(checkValidity)
export type UpdateSecurityInput = z.infer<typeof UpdateSecuritySchema>

const GroupLinkFields = {
  counterparty_name: text(200).describe('The other company\'s name.'),
  counterparty_org_number: optionalText(40).describe('Its organisation number (a foreign one as registered there).'),
  counterparty_registered_office: optionalText(120).describe('Its säte, for the koncernförhållanden note.'),
  party_id: z.string().uuid().nullish().describe('The company in the parties register (party_id), when known.'),
  ownership_percent: percent.nullish().describe('Share of the capital held, percent.'),
  voting_percent: percent.nullish().describe('Share of the votes held, percent.'),
  valid_from: date.nullish().describe('yyyy-MM-dd the relation began.'),
  valid_to: date.nullish().describe('yyyy-MM-dd it ended; open while it holds.'),
  bas_account: z
    .string()
    .trim()
    .refine(isGroupHoldingAccount, 'Ett konto i 13xx')
    .nullish()
    .describe('The 13xx account (finansiella anläggningstillgångar) the holding or claim is booked on, as a string.'),
  linked_company_id: z.string().uuid().nullish().describe('The same company in Accounted, when it is in the caller\'s team.'),
  notes: optionalText(4000),
}

export const CreateGroupLinkSchema = z
  .object({
    relation: z.enum(GROUP_RELATIONS).describe('parent (holds this company), subsidiary (dotterföretag) or associate (intresseföretag).'),
    ...GroupLinkFields,
  })
  .strict()
  .superRefine(checkValidity)
export type CreateGroupLinkInput = z.infer<typeof CreateGroupLinkSchema>

export const UpdateGroupLinkSchema = z
  .object({
    relation: z.enum(GROUP_RELATIONS).optional(),
    ...Object.fromEntries(Object.entries(GroupLinkFields).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof GroupLinkFields]: z.ZodOptional<(typeof GroupLinkFields)[K]>
    },
  })
  .strict()
  .superRefine(checkValidity)
export type UpdateGroupLinkInput = z.infer<typeof UpdateGroupLinkSchema>
