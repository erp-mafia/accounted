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
import { DISCLOSURE_REQUIREMENTS } from './disclosures'
import { USER_CLASSIFIABLE_KINDS } from './equity-kinds'
import {
  FIXED_ASSET_STATED_ROWS,
  K2_FIXED_ASSET_NOTE_POSTS,
  statedRowIssue,
  type FixedAssetStatedRow,
} from './k2-fixed-asset-note'

/** Every requirement id of the disclosure matrix (disclosures/index.ts). */
const DISCLOSURE_IDS = DISCLOSURE_REQUIREMENTS.map((requirement) => requirement.id) as [string, ...string[]]
const EQUITY_KINDS = [...USER_CLASSIFIABLE_KINDS] as [string, ...string[]]

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
  // ÅRL 6 kap. 3 §: förvaltningsberättelse disclosures of an ekonomisk
  // förening. Stored for every form; rendered and required only for the
  // ekonomisk förening (completeness AR-EF-MEMBER-INFO).
  member_count_change: sanitizedText(2000)
    .nullable()
    .optional()
    .describe('ÅRL 6 kap. 3 § (ekonomisk förening): change in the number of members during the year.'),
  insatser_repayable_next_year: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional()
    .transform((value) =>
      value === null || value === undefined ? value : Math.round(value * 100) / 100,
    )
    .describe('ÅRL 6 kap. 3 § (ekonomisk förening): insatser to repay next fiscal year, SEK; 0 when none.'),
  forlagsinsatser_dividend_right: sanitizedText(2000)
    .nullable()
    .optional()
    .describe('ÅRL 6 kap. 3 § (ekonomisk förening): the distribution right förlagsinsatser carry.'),
  forlagsinsatser_redeemable_two_years: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional()
    .transform((value) =>
      value === null || value === undefined ? value : Math.round(value * 100) / 100,
    )
    .describe('ÅRL 6 kap. 3 § (ekonomisk förening): förlagsinsatser redeemable within two years, SEK; 0 when none.'),
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
  // K3 disclosure matrix answers, keyed by requirement id. Merged into the
  // stored answers: only the ids sent change, null removes an answer.
  disclosure_answers: z
    .partialRecord(
      z.enum(DISCLOSURE_IDS),
      z
        .object({
          applies: z.boolean().nullable().optional(),
          text: sanitizedText(8000).nullable().optional(),
          choice: z.string().max(64).nullable().optional(),
          confirmed: z.boolean().optional(),
        })
        .strict()
        .nullable(),
    )
    .optional()
    .describe('K3 disclosure answers by requirement id ({applies, text, choice, confirmed}); merged, null removes one.'),
  // The kind of an equity verifikat the ledger cannot classify, keyed by
  // journal entry id. Merged like the answers; null removes one.
  equity_movement_overrides: z
    .record(z.string().uuid(), z.enum(EQUITY_KINDS).nullable())
    .optional()
    .describe('Kind of each unclassified equity verifikat by journal_entry_id (rattelse_av_fel, andrad_redovisningsprincip, ...); merged.'),
  equity_statement_separate: z
    .boolean()
    .optional()
    .describe('K3: print the specification of changes in equity as its own statement instead of in the förvaltningsberättelse.'),
  // K2: the rows of the anläggningstillgångar note that neither the register
  // nor the ledger can tell apart (k2-fixed-asset-note.ts), per balance sheet
  // post. Merged per row: only the rows sent change, a null row removes it, a
  // null post removes the post's rows, null removes everything.
  fixed_asset_note_rows: z
    .partialRecord(
      z.enum(K2_FIXED_ASSET_NOTE_POSTS),
      z
        .partialRecord(
          z.enum(FIXED_ASSET_STATED_ROWS),
          z.number().min(-1_000_000_000_000).max(1_000_000_000_000).nullable(),
        )
        .nullable(),
    )
    .nullable()
    .optional()
    .describe(
      'K2 anläggningstillgångar note: the rows neither the anläggningsregister nor the ledger can tell apart, per balance sheet post (for example MaskinerAndraTekniskaAnlaggningar) and row, whole SEK, positive as the taxonomy names the row: cost.omrakningsdifferenser (raises anskaffningsvärden), depreciation.omrakningsdifferenser (lowers accumulated avskrivningar), and for nedskrivningar booked on the post\'s write-down accounts outside the register: impairment.fusion (taken over, never negative), impairment.forsaljningar (left with an asset sold or scrapped, never negative), impairment.omklassificeringar and impairment.omrakningsdifferenser (lower accumulated nedskrivningar). Everything else in the note comes from the register, where each asset says how it was acquired (acquisition_type). Merged per row: a row sent replaces that row, null removes a row, a post or everything.',
    ),
}

type NarrativeRuleInput = {
  agm_disposition_outcome?: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision?: string | null
  fixed_asset_note_rows?: Partial<Record<string, Partial<Record<string, number | null>> | null>> | null
}

export function narrativeRule(value: NarrativeRuleInput, ctx: z.RefinementCtx): void {
  if (value.agm_disposition_outcome === 'alternative_decision' && !value.agm_disposition_decision?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['agm_disposition_decision'],
      message: 'Årsstämmans alternativa beslut måste beskrivas.',
    })
  }
  // An amount its row cannot carry is refused, never dropped: the note is
  // stated in whole kronor, and a row whose standard label names one
  // direction takes no negative amount.
  for (const [post, rows] of Object.entries(value.fixed_asset_note_rows ?? {})) {
    for (const [row, amount] of Object.entries(rows ?? {})) {
      // Null clears a row: nothing is stated, so there is nothing to refuse.
      const issue = typeof amount === 'number' ? statedRowIssue(row as FixedAssetStatedRow, amount) : null
      if (issue) ctx.addIssue({ code: 'custom', path: ['fixed_asset_note_rows', post, row], message: issue })
    }
  }
}

export const NarrativeUpdateSchema = z.object(narrativeShape).strict().superRefine(narrativeRule)
export type NarrativeUpdateInput = z.infer<typeof NarrativeUpdateSchema>

/**
 * What the revisor's påteckning says about the revisionsberättelse, as the
 * profile stores it (annual_report_profiles.auditor_opinion). 'unmodified'
 * and 'modified' follow the taxonomy's split between a revisionsberättelse
 * without and with modifierade uttalanden; the others add the påteckningsmening
 * the revisor writes when the revisionsberättelse avstyrker, or neither
 * tillstyrker nor avstyrker, that the statements are adopted (the vallista
 * RevisorspateckningRevisionsberattelseAvstyrktResultatrakningenBalansrakningenList).
 * The mapping to taxonomy members lives in lib/bokslut/ixbrl/revisorspateckning.ts.
 */
export const AUDITOR_OPINIONS = [
  'unmodified',
  'modified',
  'avstyrkt_rr_br',
  'avstyrkt_rr',
  'avstyrkt_br',
  'avstyrkt_rr_varken_br',
  'avstyrkt_br_varken_rr',
  'varken_rr_br',
  'varken_rr',
  'varken_br',
] as const
export type AuditorOpinion = (typeof AUDITOR_OPINIONS)[number]

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
  previous_year_framework: z
    .enum(['k2', 'k3', 'none'])
    .nullable()
    .optional()
    .describe('K3: the framework of the previous årsredovisning (none: this is the first one).'),
  has_other_temporary_differences: NullableBoolean.optional().describe(
    'K3: temporary differences other than obeskattade reserver (buildings, underskottsavdrag, ...).',
  ),
  reporting_currency: z.enum(['SEK', 'EUR']).optional(),
  auditor_report_required: NullableBoolean.optional(),
  auditor_report_included: z.boolean().optional(),
  auditor_firm_name: sanitizedText(200)
    .nullable()
    .optional()
    .transform((value) => (typeof value === 'string' ? value.trim() || null : value))
    .describe('The registered revisionsbolag elected as revisor (ValtRevisionsbolagsnamn); null when a natural person is the revisor.'),
  auditor_opinion: z
    .enum(AUDITOR_OPINIONS)
    .nullable()
    .optional()
    .describe('What the revisionsberättelse says, for the revisorspåteckning: unmodified, modified, or the avstyrkt/varken sentence.'),
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

/** The underskrifter roles ÅRL 2 kap. 7 § allows: the board and the VD. */
export const BOARD_SIGNER_ROLES = ['Styrelseledamot', 'Styrelseordförande', 'VD', 'Verkställande direktör'] as const

/**
 * The revisor's roles in the roster. The revisor does not sign the
 * årsredovisning: ABL 9 kap. 28 § andra stycket has the revisor make a
 * hänvisning to the revisionsberättelse on it (the revisorspåteckning), and
 * 28 a § has every revisor do so when there are several. The role is the
 * title printed under the name and tagged as UnderskriftHandlingTitel;
 * "Huvudansvarig revisor" is the revisor a registered revisionsbolag
 * designates (ABL 9 kap. 19 §), tagged UnderskriftRevisorspateckningRevisorHuvudansvarig.
 */
export const AUDITOR_SIGNER_ROLES = ['Auktoriserad revisor', 'Godkänd revisor', 'Huvudansvarig revisor'] as const

/** Every roster role: the UI dropdown's set. */
export const SIGNER_ROLES = [...BOARD_SIGNER_ROLES, ...AUDITOR_SIGNER_ROLES] as const

/** Whether a roster role is one of the revisor's (case and spacing insensitive). */
export function isAuditorRole(role: string | null | undefined): boolean {
  if (!role) return false
  const key = role.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv')
  return AUDITOR_SIGNER_ROLES.some((auditorRole) => auditorRole.toLocaleLowerCase('sv') === key)
}

/**
 * Who may sign the fastställelseintyg: a board member or the verkställande
 * direktör (product decision 2026-10-15, following
 * .claude/skills/swedish-financial-reporting references/bolagsverket-filing.md
 * § 5: "Styrelseledamot or VD" signs it; the intyg is filed with the
 * årsredovisning under ÅRL 8 kap. 3 §). Every board role qualifies; the
 * revisor never does.
 */
export const CERTIFICATE_SIGNER_ROLES = BOARD_SIGNER_ROLES


export const versionShape = {
  action: z
    .enum(['snapshot', 'finalize'])
    .describe('snapshot saves a draft version; finalize freezes the version for signing (ready_for_signature).'),
  certificate_signer: z
    .object({
      first_name: z.string().min(1).max(100),
      last_name: z.string().min(1).max(100),
      role: z.enum(CERTIFICATE_SIGNER_ROLES),
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
  role: z
    .enum(SIGNER_ROLES)
    .describe(
      'Styrelseledamot, Styrelseordförande, VD or Verkställande direktör for the board; Auktoriserad revisor, Godkänd revisor or Huvudansvarig revisor for the revisor, whose slot holds the revisorspåteckning.',
    ),
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
