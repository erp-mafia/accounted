/**
 * Request contracts for the årsredovisning workflow writes: narrative texts,
 * the compliance profile answers, freezing a version, and the signer roster.
 * Shared by the dashboard routes under
 * /api/bookkeeping/fiscal-periods/[id]/arsredovisning/** and the operations
 * in lib/operations/arsredovisning.ts, so every door accepts exactly the
 * same body.
 *
 * Each contract is split into a plain object shape and its cross-field rule:
 * Zod refuses .extend() on an object that carries refinements, and the
 * operation inputs extend the shape with the path ids (fiscal_period_id,
 * signature_id) before applying the rule.
 */
import { z } from 'zod'
import { roundOre } from '@/lib/money'
import {
  EDITABLE_NOTE_KEYS,
  NOTE_OVERRIDE_MAX_LENGTH,
  normalizeNoteOverrides,
} from './note-overrides'
import {
  isValidParentCompanyIdentifier,
  PARENT_COMPANY_IDENTIFIER_ERROR,
} from './parent-company-identifier'

// Strip non-printable control characters that would corrupt PDF output or
// mislead a human reader of the årsredovisning. Whitelist printable ASCII
// + every byte >= 0x20 (covers Latin-1 + UTF-8 multi-byte sequences) while
// allowing tab/LF/CR for legitimate line breaks.
const stripControlChars = (s: string): string =>
  s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

const sanitizedText = (max: number) => z.string().max(max).transform(stripControlChars)

/**
 * Narrative overrides (förvaltningsberättelse, resultatdisposition, the ÅRL
 * 5 kap. disclosure notes, K3 note texts). Only the fields sent change; null
 * clears a field back to the generated text.
 */
export const narrativeShape = {
  // Match the DB CHECK lengths exactly so a payload that would fail at the
  // storage layer instead returns a clean 400 here. Free-text fields are
  // rendered verbatim into the årsredovisning PDF, so ASCII control bytes
  // (NUL, ESC, etc.) are stripped at the schema layer.
  description: sanitizedText(4000).nullable().optional().describe('Förvaltningsberättelse: allmänt om verksamheten.'),
  important_events: sanitizedText(4000)
    .nullable()
    .optional()
    .describe('Förvaltningsberättelse: väsentliga händelser under räkenskapsåret.'),
  resultatdisposition: sanitizedText(2000).nullable().optional().describe('Styrelsens förslag till resultatdisposition, as text.'),
  proposed_dividend: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional()
    .transform((value) => (value === null || value === undefined ? value : roundOre(value)))
    .describe('Föreslagen utdelning in SEK (rounded to öre); null clears it.'),
  // ISO YYYY-MM-DD per the DATE column; null clears it. Validated as a real
  // calendar date (not just regex) so '2024-13-99' is a 400, not a 500.
  agm_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (s) => {
        const d = new Date(`${s}T00:00:00Z`)
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
      },
      { message: 'Invalid calendar date' },
    )
    .nullable()
    .optional()
    .describe('Årsstämmans datum, YYYY-MM-DD (fills the fastställelseintyg).'),
  // Disclosure fields per ÅRL 5:13-15 § + BFNAR koncernförhållanden. Null
  // clears the override and the builder falls back to boilerplate ("Inga.").
  // Capped at 1 trillion SEK against overflow in PDF formatting.
  long_term_debt_over_five_years: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional()
    .describe('ÅRL 5:13 §: long-term debt falling due after more than five years, SEK.'),
  securities_pledged: sanitizedText(4000).nullable().optional().describe('ÅRL 5:14 §: ställda säkerheter.'),
  contingent_liabilities: sanitizedText(4000).nullable().optional().describe('ÅRL 5:15 §: eventualförpliktelser.'),
  parent_company_name: sanitizedText(200).nullable().optional().describe('Moderföretagets namn (koncernförhållanden).'),
  // Swedish organisationsnummer or a foreign parent's registration
  // identifier; personnummer-shaped values stay rejected. Empty string
  // clears the override.
  parent_company_org_number: z
    .union([
      z.literal(''),
      z.string().max(40).refine(isValidParentCompanyIdentifier, {
        message: PARENT_COMPANY_IDENTIFIER_ERROR,
      }),
    ])
    .nullable()
    .optional()
    .describe('Moderföretagets organisationsnummer or foreign registration id; never a personnummer.'),
  parent_company_city: sanitizedText(100).nullable().optional().describe('Moderföretagets säte.'),
  // ÅRL 5:20 §: manual medelantal anställda. Null clears the override and the
  // note falls back to the FTE average over the employees table.
  medelantal_anstallda_override: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .nullable()
    .optional()
    .describe('ÅRL 5:20 §: medelantal anställda as a whole number; null uses the computed average.'),
  long_term_debt_over_five_years_confirmed: z.boolean().optional(),
  securities_pledged_confirmed: z.boolean().optional(),
  contingent_liabilities_confirmed: z.boolean().optional(),
  parent_company_confirmed: z.boolean().optional(),
  agm_disposition_outcome: z
    .enum(['proposal_approved', 'alternative_decision'])
    .nullable()
    .optional()
    .describe('What the årsstämma decided about the resultatdisposition.'),
  agm_disposition_decision: sanitizedText(2000)
    .nullable()
    .optional()
    .describe('The årsstämma\'s alternative decision, required with alternative_decision.'),
  // K3 note texts replacing the generated ones, keyed by the stable note key
  // (note-overrides.ts). The whole object is replaced on save; a null or
  // blank value resets that note to the generated text. Unknown keys are a
  // 400: only text notes are editable, never notes computed from the books.
  note_overrides: z
    .partialRecord(z.enum(EDITABLE_NOTE_KEYS), sanitizedText(NOTE_OVERRIDE_MAX_LENGTH).nullable())
    .optional()
    .transform((value) => (value === undefined ? undefined : normalizeNoteOverrides(value)))
    .describe('K3 note texts by note key; the whole object is replaced, blank or null resets a note.'),
  // K3: leave the kassaflödesanalys out. Honoured only when the company is
  // not a större företag (ÅRL 2 kap. 1 §, 1 kap. 3 §), see cash-flow-omission.ts.
  omit_kassaflodesanalys: z.boolean().optional(),
  kassaflodesanalys_omission_confirmed: z.boolean().optional(),
}

type NarrativeRuleInput = {
  agm_disposition_outcome?: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision?: string | null
}

export function narrativeRule(value: NarrativeRuleInput, ctx: z.RefinementCtx): void {
  if (value.agm_disposition_outcome === 'alternative_decision' && !value.agm_disposition_decision?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['agm_disposition_decision'],
      message: 'Årsstämmans alternativa beslut måste beskrivas.',
    })
  }
}

export const NarrativeUpdateSchema = z.object(narrativeShape).strict().superRefine(narrativeRule)
export type NarrativeUpdateInput = z.infer<typeof NarrativeUpdateSchema>

const NullableBoolean = z.boolean().nullable()

/**
 * Compliance profile answers: the facts about the company the ÅRL/K2/K3
 * rules need (publikt bolag, moderföretag, revisionsberättelse, ...) and the
 * user's confirmations (narrative, K2 assessment, signer roster).
 */
export const complianceShape = {
  is_public_limited_company: NullableBoolean.optional(),
  is_in_liquidation: NullableBoolean.optional(),
  securities_traded_on_regulated_market: NullableBoolean.optional(),
  is_parent_company: NullableBoolean.optional(),
  parent_group_size: z.enum(['none', 'small', 'large']).nullable().optional(),
  prepares_consolidated_accounts: NullableBoolean.optional(),
  has_foreign_branch: NullableBoolean.optional(),
  has_crypto_assets: NullableBoolean.optional(),
  has_share_based_payments: NullableBoolean.optional(),
  has_convertible_debt: NullableBoolean.optional(),
  building_revenue_share_pct: z.number().min(0).max(100).nullable().optional(),
  has_material_deferred_tax: NullableBoolean.optional(),
  reporting_currency: z.enum(['SEK', 'EUR']).optional(),
  auditor_report_required: NullableBoolean.optional(),
  auditor_report_included: z.boolean().optional(),
  dividend_prudence_confirmed: NullableBoolean.optional(),
  narrative_confirmed: z.boolean().optional().describe('The user has reviewed the förvaltningsberättelse texts.'),
  k2_assessment_confirmed: z.boolean().optional().describe('The user confirms the K2 eligibility assessment.'),
  signer_roster_confirmed: z
    .boolean()
    .optional()
    .describe('The user confirms the signer roster matches the board and VD registered at Bolagsverket.'),
}

export const ComplianceUpdateSchema = z
  .object(complianceShape)
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' })
export type ComplianceUpdateInput = z.infer<typeof ComplianceUpdateSchema>

/** The underskrifter roles ÅRL 2 kap. 7 § allows (the UI dropdown's set). */
export const SIGNER_ROLES = ['Styrelseledamot', 'Styrelseordförande', 'VD', 'Verkställande direktör'] as const

export const versionShape = {
  action: z
    .enum(['snapshot', 'finalize'])
    .describe('snapshot saves a draft version; finalize freezes the version for signing (ready_for_signature).'),
  certificate_signer: z
    .object({
      first_name: z.string().min(1).max(100),
      last_name: z.string().min(1).max(100),
      role: z.enum(SIGNER_ROLES),
    })
    .strict()
    .optional()
    .describe('Who signs the fastställelseintyg (a board member or the VD).'),
}

export const VersionCreateSchema = z.object(versionShape).strict()
export type VersionCreateInput = z.infer<typeof VersionCreateSchema>

// Name capped at 200 chars per GDPR data-min (Art.25.2): Swedish names are
// well under that. A name is not an identity number: digits-only or
// personnummer-shaped values are refused so a personnummer never lands in the
// roster (or in a staged operation's params).
const PERSONNUMMER_SHAPED = /\d{6}[-+]?\d{4}/

export const signatoryShape = {
  role: z.enum(SIGNER_ROLES).describe('Styrelseledamot, Styrelseordförande, VD or Verkställande direktör.'),
  signer_name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => !PERSONNUMMER_SHAPED.test(name.replace(/\s/g, '')), {
      message: 'Ange namnet, inte personnummer.',
    })
    .describe('Full name as registered at Bolagsverket. Never a personnummer.'),
}

export const SignatoryCreateSchema = z.object(signatoryShape)
export type SignatoryCreateInput = z.infer<typeof SignatoryCreateSchema>

const EvidenceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^(archive|document|receipt):[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/)

export const SignatureSignedSchema = z
  .object({
    status: z.literal('signed'),
    annual_report_version_id: z.string().uuid().describe('The ready_for_signature version the signature is for.'),
    signing_method: z.enum(['paper_original', 'advanced_e_signature', 'bankid']),
    evidence_reference: EvidenceReferenceSchema.describe(
      'Where the signed original is kept: archive:<ref>, document:<id> or receipt:<ref>.',
    ),
    signed_at: z.string().datetime().optional().describe('ISO timestamp; defaults to now. Not before finalization, not in the future.'),
  })
  .strict()

export const SignatureDeclinedSchema = z.object({ status: z.literal('declined') }).strict()

export const SignatureTransitionSchema = z.discriminatedUnion('status', [SignatureSignedSchema, SignatureDeclinedSchema])
export type SignatureTransitionInput = z.infer<typeof SignatureTransitionSchema>
