/**
 * Årsredovisning (annual report) workflow operations: the narrative texts,
 * the compliance profile answers, freezing a version for signing, the signer
 * roster and recorded signatures, and the iXBRL pre-flight. Rules live in
 * lib/bokslut/arsredovisning/workflow-service.ts and file-service.ts; the
 * dashboard routes under /api/bookkeeping/fiscal-periods/[id]/arsredovisning
 * call the same services.
 *
 * The PDF and the iXBRL (XHTML) document are v1-only file routes
 * (lib/api/v1/report-file-route.ts): an MCP read never answers file bytes.
 *
 * Existing hand-written MCP reads stay as they are and are not duplicated
 * here: gnubok_preview_arsredovisning (the content), gnubok_validate_arsredovisning
 * (the compliance checks per stage), gnubok_list_arsredovisning_versions and
 * gnubok_get_arsredovisning_filing_status. gnubok_validate_arsredovisning_ixbrl
 * below is a different check: the Bolagsverket kontrollera rules on the
 * generated iXBRL document.
 *
 * No MCP binding, on purpose:
 *   - arsredovisning.record-signature: it records that a named board member
 *     signed the legal document (evidence of a paper original or an
 *     e-signature); a person, not an agent, attests that;
 *   - arsredovisning.remove-signatory and arsredovisning.list-signatories:
 *     roster housekeeping, reachable over v1; the roster names are also in
 *     gnubok_preview_arsredovisning.
 *
 * Deliberately NOT here: filing with Bolagsverket. The fastställelseintyg is
 * signed with BankID by a board member at Bolagsverket; that stays a
 * dashboard-only flow (the bolagsverket extension).
 */
import { z } from 'zod'
import type { SignatureRequest } from '@/lib/bokslut/arsredovisning/signature-service'
import type { NarrativeRow } from '@/lib/bokslut/arsredovisning/narrative-service'
import type { AnnualReportVersionSummary } from '@/lib/bokslut/arsredovisning/compliance-types'
import type { ComplianceResponse } from '@/lib/bokslut/arsredovisning/workflow-service'
import {
  SignatureSignedSchema,
  complianceShape,
  narrativeRule,
  narrativeShape,
  signatoryShape,
  versionShape,
} from '@/lib/bokslut/arsredovisning/workflow-schemas'
import { defineOperation, type OperationOutcome } from './types'

/*
 * The services load on first use: this module sits in the operation
 * registry, which the MCP server and the commit path import, and the report
 * builder behind these writes (and react-pdf behind the files) is a large
 * graph nobody else on those paths needs.
 */
const workflow = () => import('@/lib/bokslut/arsredovisning/workflow-service')
const files = () => import('@/lib/bokslut/arsredovisning/file-service')

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const BASE = '/api/v1/companies/:companyId/fiscal-periods/:id/arsredovisning'

const FISCAL_PERIOD_ID = z
  .string()
  .uuid()
  .describe('The fiscal period (räkenskapsår) id, from GET /fiscal-periods.')

const SIGNATURE_ID = z
  .string()
  .uuid()
  .describe('The signer slot id (signature_id from GET .../arsredovisning/signatures).')

/** Keys other than the path ids: an update must change something. */
const hasField = (ids: string[]) => (body: Record<string, unknown>) =>
  Object.keys(body).some((key) => !ids.includes(key))

// ─────────────────────────────────────────────────────────────────
// Public shapes (qualified ids, no user ids)
// ─────────────────────────────────────────────────────────────────

const NarrativeOut = z
  .object({
    narrative_id: z.string().uuid(),
    fiscal_period_id: z.string().uuid(),
    description: z.string().nullable(),
    important_events: z.string().nullable(),
    resultatdisposition: z.string().nullable(),
    proposed_dividend: z.number().nullable(),
    agm_date: z.string().nullable(),
    long_term_debt_over_five_years: z.number().nullable(),
    securities_pledged: z.string().nullable(),
    contingent_liabilities: z.string().nullable(),
    parent_company_name: z.string().nullable(),
    parent_company_org_number: z.string().nullable(),
    parent_company_city: z.string().nullable(),
    medelantal_anstallda_override: z.number().int().nullable(),
    agm_disposition_outcome: z.enum(['proposal_approved', 'alternative_decision']).nullable(),
    agm_disposition_decision: z.string().nullable(),
    note_overrides: z.record(z.string(), z.string()),
    omit_kassaflodesanalys: z.boolean(),
    updated_at: z.string(),
  })
  .loose()

function narrativeOut(row: NarrativeRow) {
  const { id, company_id: _companyId, ...rest } = row
  return { narrative_id: id, ...rest }
}

const Loose = z.record(z.string(), z.unknown())

const ComplianceOut = z.object({
  profile: Loose.describe('The compliance profile answers and confirmation timestamps (annual_report_profile_id, not id).'),
  disclosures: Loose,
  eligibility: Loose.describe('K2 eligibility, size classification and digital filing eligibility.'),
  validation: Loose.describe('Draft-stage validation: ok, error_count, warning_count, issues.'),
  capabilities: Loose,
  report_summary: z.object({
    proposed_dividend: z.number().nullable(),
    distributable_equity: z.number().nullable(),
  }),
})

function complianceOut(data: ComplianceResponse): z.infer<typeof ComplianceOut> {
  const { id, company_id: _companyId, ...profile } = data.profile
  // The builder returns interfaces; TypeScript does not treat an interface
  // as assignable to Record<string, unknown>, so they are re-typed, unchanged.
  const loose = (value: object) => value as Record<string, unknown>
  return {
    profile: { annual_report_profile_id: id, ...profile },
    disclosures: loose(data.disclosures),
    eligibility: loose(data.eligibility),
    validation: loose(data.validation),
    capabilities: loose(data.capabilities),
    report_summary: data.report_summary,
  }
}

const VersionOut = z.object({
  annual_report_version_id: z.string().uuid(),
  version_number: z.number().int(),
  status: z.enum(['draft', 'ready_for_signature', 'signed', 'filed', 'registered', 'superseded']),
  framework: z.string(),
  content_hash: z.string().describe('SHA-256 of the frozen content (signature dates excluded).'),
  taxonomy_version: z.string().nullable(),
  entry_point: z.string().nullable(),
  finalized_at: z.string().nullable(),
  created_at: z.string(),
})

function versionOut(row: AnnualReportVersionSummary) {
  return {
    annual_report_version_id: row.id,
    version_number: row.version_number,
    status: row.status,
    framework: row.framework,
    content_hash: row.content_hash,
    taxonomy_version: row.taxonomy_version ?? null,
    entry_point: row.entry_point ?? null,
    finalized_at: row.finalized_at ?? null,
    created_at: row.created_at,
  }
}

const SignatureOut = z.object({
  signature_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  annual_report_version_id: z.string().uuid().nullable().describe('Null while the slot is on the unbound roster.'),
  role: z.string(),
  signer_name: z.string(),
  status: z.enum(['pending', 'signed', 'declined']),
  signed_at: z.string().nullable(),
  signing_method: z.enum(['paper_original', 'advanced_e_signature', 'bankid', 'bolagsverket']).nullable(),
  evidence_reference: z.string().nullable(),
  evidence_recorded_at: z.string().nullable(),
  created_at: z.string(),
})

function signatureOut(row: SignatureRequest) {
  return {
    signature_id: row.id,
    fiscal_period_id: row.fiscal_period_id,
    annual_report_version_id: row.annual_report_version_id ?? null,
    role: row.role,
    signer_name: row.signer_name,
    status: row.status,
    signed_at: row.signed_at ?? null,
    signing_method: row.signing_method ?? null,
    evidence_reference: row.evidence_reference ?? null,
    evidence_recorded_at: row.evidence_recorded_at ?? null,
    created_at: row.created_at,
  }
}

/** Map a successful outcome's data; failures and previews pass through. */
function mapped<A, B>(outcome: OperationOutcome<A>, map: (data: A) => B): OperationOutcome<B> {
  if (!outcome.ok || outcome.dryRun) return outcome
  return { ...outcome, data: map(outcome.data) }
}

const SIGNATURE_EXAMPLE = {
  signature_id: '5b1c…',
  fiscal_period_id: '7c2b…',
  annual_report_version_id: null,
  role: 'Styrelseledamot',
  signer_name: 'Anna Andersson',
  status: 'pending',
  signed_at: null,
  signing_method: null,
  evidence_reference: null,
  evidence_recorded_at: null,
  created_at: '2027-03-02T09:00:00Z',
}

// ─────────────────────────────────────────────────────────────────
// Narrative
// ─────────────────────────────────────────────────────────────────

export const arsredovisningUpdateNarrative = defineOperation({
  id: 'arsredovisning.update-narrative',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Edit the årsredovisning texts: förvaltningsberättelse, resultatdisposition, disclosure notes and K3 note texts.',
    description:
      'Saves the narrative overrides for a räkenskapsår\'s årsredovisning, as the dashboard\'s text step does. Only the fields sent change; null clears a field back to the generated text. Covers the förvaltningsberättelse (description, important_events), the resultatdisposition text and proposed_dividend, the årsstämma date and decision, the ÅRL 5 kap. disclosures (long-term debt, ställda säkerheter, eventualförpliktelser), koncernförhållanden, a manual medelantal anställda, K3 note texts (note_overrides replaces the whole object) and the K3 kassaflödesanalys omission. A save clears the narrative confirmation in the compliance profile. Allowed after the period is closed; refused once a Bolagsverket submission is registrerad. Idempotent. Dry-runnable.',
    useWhen: 'Writing or correcting the texts of the årsredovisning before a version is frozen for signing.',
    doNotUseFor:
      'The compliance profile answers (PATCH .../arsredovisning/compliance), the figures (they come from the books), or freezing the document (POST .../arsredovisning/versions).',
    pitfalls: [
      'A version already frozen keeps its text: freeze a new version after editing.',
      'agm_disposition_outcome alternative_decision needs agm_disposition_decision text (400 VALIDATION_ERROR).',
      'parent_company_org_number is an organisationsnummer or a foreign registration id; a personnummer is refused.',
      'Registered at Bolagsverket: 409 ARSREDOVISNING_REGISTERED.',
      'Saving clears narrative_confirmed: confirm again with PATCH .../compliance {"narrative_confirmed": true}.',
    ],
    example: {
      request: { description: 'Bolaget bedriver konsultverksamhet inom IT.', agm_date: '2027-05-20' },
      response: {
        data: {
          narrative_id: '1f0e…',
          fiscal_period_id: '7c2b…',
          description: 'Bolaget bedriver konsultverksamhet inom IT.',
          agm_date: '2027-05-20',
          updated_at: '2027-03-02T09:00:00Z',
        },
        meta: META,
      },
    },
  },
  input: z
    .object({ fiscal_period_id: FISCAL_PERIOD_ID, ...narrativeShape })
    .strict()
    .superRefine((value, ctx) => {
      narrativeRule(value, ctx)
      if (!hasField(['fiscal_period_id'])(value)) {
        ctx.addIssue({ code: 'custom', path: [], message: 'Send at least one field to update.' })
      }
    }),
  output: NarrativeOut,
  errorCodes: ['PERIOD_NOT_FOUND', 'ARSREDOVISNING_REGISTERED'],
  http: { method: 'POST', path: `${BASE}/narrative`, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_update_arsredovisning_narrative',
    title: 'Update Annual Report Narrative',
    description:
      'Stage an edit of the årsredovisning texts: förvaltningsberättelse, resultatdisposition and proposed dividend, AGM date and decision, ÅRL 5 kap. disclosures, K3 note texts. Only sent fields change; null resets to the generated text.',
    keywords: ['förvaltningsberättelse', 'årsredovisning text', 'resultatdisposition', 'noter', 'årsstämma', 'ställda säkerheter', 'eventualförpliktelser'],
    stage: { pendingType: 'update_arsredovisning_narrative', title: () => 'Ändra årsredovisningens texter' },
  },
  run: async (ctx, { fiscal_period_id, ...input }, { dryRun }) =>
    mapped(
      await (await workflow()).updateArsredovisningNarrative(ctx, fiscal_period_id, input, { dryRun }),
      narrativeOut,
    ),
})

// ─────────────────────────────────────────────────────────────────
// Compliance profile
// ─────────────────────────────────────────────────────────────────

export const arsredovisningUpdateCompliance = defineOperation({
  id: 'arsredovisning.update-compliance',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Answer the årsredovisning compliance questions and record the confirmations.',
    description:
      'Sparse update of the compliance profile the ÅRL, K2 and K3 checks read: publikt bolag, likvidation, listed securities, moderföretag and group size, foreign branch, crypto, share-based payments, convertibles, building revenue share, deferred tax, reporting currency, revisionsberättelse, dividend prudence. narrative_confirmed, k2_assessment_confirmed and signer_roster_confirmed record (true) or withdraw (false) the user\'s confirmations with a timestamp. Answers the recomputed eligibility, validation and capabilities. Idempotent. Dry-runnable.',
    useWhen: 'The validation (gnubok_validate_arsredovisning) reports an unanswered compliance question or a missing confirmation.',
    doNotUseFor: 'The document texts (POST .../arsredovisning/narrative) or the signer roster itself (POST .../arsredovisning/signatures).',
    pitfalls: [
      'An unanswered question is null, never false: false is a legal assertion that the condition does not apply.',
      'signer_roster_confirmed asserts the roster matches the board and VD registered at Bolagsverket; any later roster change clears it.',
      'is_parent_company false also clears parent_group_size and prepares_consolidated_accounts.',
      'Send at least one field (400 VALIDATION_ERROR otherwise).',
    ],
    example: {
      request: { is_public_limited_company: false, k2_assessment_confirmed: true },
      response: {
        data: {
          profile: { annual_report_profile_id: '9d3a…', is_public_limited_company: false },
          validation: { stage: 'draft', ok: true, error_count: 0, warning_count: 1, issues: [] },
          report_summary: { proposed_dividend: 0, distributable_equity: 412000 },
        },
        meta: META,
      },
    },
  },
  input: z
    .object({ fiscal_period_id: FISCAL_PERIOD_ID, ...complianceShape })
    .strict()
    .refine(hasField(['fiscal_period_id']), { message: 'Send at least one field to update.' }),
  output: ComplianceOut,
  errorCodes: ['PERIOD_NOT_FOUND'],
  http: { method: 'PATCH', path: `${BASE}/compliance`, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_update_arsredovisning_compliance',
    title: 'Update Annual Report Compliance Answers',
    description:
      'Stage answers to the årsredovisning compliance questions (publikt bolag, moderföretag, revisionsberättelse, ...) or the narrative, K2-assessment and signer-roster confirmations. Unanswered stays null; false asserts the condition does not apply.',
    keywords: ['årsredovisning', 'k2', 'k3', 'bekräfta', 'undertecknare', 'revisionsberättelse', 'moderföretag'],
    stage: { pendingType: 'update_arsredovisning_compliance', title: () => 'Ändra årsredovisningens kontrollfrågor' },
  },
  run: async (ctx, { fiscal_period_id, ...input }, { dryRun }) =>
    mapped(
      await (await workflow()).updateArsredovisningCompliance(ctx, fiscal_period_id, input, { dryRun }),
      complianceOut,
    ),
})

// ─────────────────────────────────────────────────────────────────
// Versions
// ─────────────────────────────────────────────────────────────────

export const arsredovisningCreateVersion = defineOperation({
  id: 'arsredovisning.create-version',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Freeze an immutable årsredovisning version: a draft snapshot, or the version that gets signed.',
    description:
      'Builds the årsredovisning from a complete read of the books (refused while an SIE import is unfinished) and stores it as an immutable version with its content hash. action snapshot stores a draft; action finalize requires every signing-stage check to pass, marks the version ready_for_signature, supersedes an earlier ready or signed version and binds the signer roster to it. certificate_signer names who signs the fastställelseintyg. expected_content_hash (from a dry run) makes the call refuse when the content has changed since. Answers 201 with the version. Idempotent. Dry-runnable: the dry run answers the content hash and the validation counts.',
    useWhen: 'The texts, compliance answers and signer roster are done and the document is to be signed (finalize), or a checkpoint of the draft is wanted (snapshot).',
    doNotUseFor:
      'Filing with Bolagsverket (dashboard only, BankID), recording signatures (PATCH .../signatures/{signatureId}) or reading the document (GET .../arsredovisning/pdf).',
    pitfalls: [
      'Statements that do not tie, or (finalize) any signing-stage error, answer 409 ARSREDOVISNING_INCOMPLETE with the validation in details: run gnubok_validate_arsredovisning with stage signing first.',
      'finalize needs a confirmed signer roster (PATCH .../compliance {"signer_roster_confirmed": true}) and at least one signer.',
      'Content changed since the hash you pass: 409 ARSREDOVISNING_CONTENT_CHANGED; dry-run again and review.',
      'A new finalize supersedes the previous ready_for_signature version; signatures recorded on it do not carry over.',
      'Refused while an SIE import is unfinished: complete or undo it first.',
    ],
    example: {
      request: { action: 'finalize', certificate_signer: { first_name: 'Anna', last_name: 'Andersson', role: 'Styrelseledamot' } },
      response: {
        data: {
          annual_report_version_id: '4e7d…',
          version_number: 2,
          status: 'ready_for_signature',
          framework: 'k2',
          content_hash: '9f86d081…',
          taxonomy_version: '2024-09-12',
          entry_point: 'k2-ab-risbs-2024-09-12',
          finalized_at: '2027-03-02T09:00:00Z',
          created_at: '2027-03-02T09:00:00Z',
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      fiscal_period_id: FISCAL_PERIOD_ID,
      ...versionShape,
      expected_content_hash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe('The content_hash a dry run answered; the version is refused when the content no longer matches.'),
    })
    .strict(),
  output: VersionOut,
  errorCodes: ['PERIOD_NOT_FOUND', 'ARSREDOVISNING_INCOMPLETE', 'ARSREDOVISNING_CONTENT_CHANGED', 'CONFLICT'],
  http: { method: 'POST', path: `${BASE}/versions`, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_create_arsredovisning_version',
    title: 'Create Annual Report Version',
    description:
      'Stage freezing an immutable årsredovisning version: snapshot (draft) or finalize (ready for signing; needs every signing check green and a confirmed signer roster). Approval freezes exactly the content hash the preview shows.',
    keywords: ['årsredovisning', 'lås version', 'färdigställ', 'för underskrift', 'fastställelseintyg', 'version'],
    stage: {
      pendingType: 'create_arsredovisning_version',
      title: (input) =>
        input.action === 'finalize' ? 'Lås årsredovisningen för underskrift' : 'Spara en version av årsredovisningen',
      // The approver approves the content the preview hashed: a commit after
      // the books or texts changed is refused instead of freezing unseen content.
      pinParams: (input, preview) => ({
        ...input,
        expected_content_hash: input.expected_content_hash ?? preview.content_hash,
      }),
    },
  },
  run: async (ctx, { fiscal_period_id, expected_content_hash, ...input }, { dryRun }) =>
    mapped(
      await (await workflow()).createArsredovisningVersion(ctx, fiscal_period_id, input, {
        dryRun,
        expectedContentHash: expected_content_hash,
      }),
      versionOut,
    ),
})

// ─────────────────────────────────────────────────────────────────
// Signer roster and signatures
// ─────────────────────────────────────────────────────────────────

export const arsredovisningListSignatories = defineOperation({
  id: 'arsredovisning.list-signatories',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The årsredovisning signer roster and its signatures.',
    description:
      'The current signer slots for the räkenskapsår: the unbound pending roster while one exists, otherwise the slots bound to the latest version with their status, signing date, method and evidence reference. The signature_id values are what PATCH and DELETE .../signatures/{signatureId} take; finalizing a version may create new slots bound to it. Read-only.',
    useWhen: 'Before adding a signer (avoid duplicates) or to find the slot to record a signature on after a version is finalized.',
    doNotUseFor: 'The report content (gnubok_preview_arsredovisning) or the version list (gnubok_list_arsredovisning_versions).',
    pitfalls: ['Declined slots are listed too; they do not appear in the document.'],
    example: { response: { data: { signatures: [SIGNATURE_EXAMPLE] }, meta: META } },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID }),
  output: z.object({ signatures: z.array(SignatureOut) }),
  errorCodes: ['PERIOD_NOT_FOUND'],
  http: { method: 'GET', path: `${BASE}/signatures`, pathParams: { id: 'fiscal_period_id' } },
  run: async (ctx, { fiscal_period_id }) =>
    mapped(await (await workflow()).listArsredovisningSignatories(ctx, fiscal_period_id), (rows) => ({
      signatures: rows.map(signatureOut),
    })),
})

export const arsredovisningAddSignatory = defineOperation({
  id: 'arsredovisning.add-signatory',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Add a board member or the VD to the årsredovisning signer roster.',
    description:
      'Adds a pending signer slot (role and name) to the roster for the räkenskapsår. ÅRL 2 kap. 7 § requires every ordinarie styrelseledamot and the VD, if any, to sign. This records who is to sign; it signs nothing and involves no BankID. Any roster change clears the signer roster confirmation. Answers 201 with the slot. Idempotent. Dry-runnable.',
    useWhen: 'Setting up who signs, before finalizing a version (POST .../arsredovisning/versions action finalize).',
    doNotUseFor: 'Recording that someone signed (PATCH .../signatures/{signatureId}) or filing with Bolagsverket.',
    pitfalls: [
      'The same role and name twice on the unbound roster answers 409 ARSREDOVISNING_SIGNER_ALREADY_EXISTS.',
      'signer_name is the name as registered at Bolagsverket; a personnummer is refused (400).',
      'Confirm the roster afterwards: PATCH .../compliance {"signer_roster_confirmed": true}.',
    ],
    example: {
      request: { role: 'Styrelseledamot', signer_name: 'Anna Andersson' },
      response: { data: SIGNATURE_EXAMPLE, meta: META },
    },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID, ...signatoryShape }),
  output: SignatureOut,
  errorCodes: ['PERIOD_NOT_FOUND', 'ARSREDOVISNING_SIGNER_ALREADY_EXISTS'],
  http: { method: 'POST', path: `${BASE}/signatures`, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_add_arsredovisning_signature',
    title: 'Add Annual Report Signer',
    description:
      'Stage adding a styrelseledamot, styrelseordförande or VD to the årsredovisning signer roster (who is to sign). Signs nothing, no BankID. Names only, never a personnummer. Clears the roster confirmation.',
    keywords: ['underskrift', 'undertecknare', 'styrelseledamot', 'vd', 'årsredovisning', 'skriva under'],
    stage: {
      pendingType: 'add_arsredovisning_signature',
      title: (input) => `Lägg till undertecknare: ${String(input.signer_name)} (${String(input.role)})`,
    },
  },
  run: async (ctx, { fiscal_period_id, ...input }, { dryRun }) =>
    mapped(await (await workflow()).addArsredovisningSignatory(ctx, fiscal_period_id, input, { dryRun }), signatureOut),
})

const SIGNED_FIELDS = ['annual_report_version_id', 'signing_method', 'evidence_reference', 'signed_at'] as const

export const arsredovisningRecordSignature = defineOperation({
  id: 'arsredovisning.record-signature',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Record that a signer signed the frozen årsredovisning version, or declined.',
    description:
      'status signed records the evidence of a signature made outside the product (a paper original or an advanced e-signature): the ready_for_signature version it is for, the method, where the original is kept (evidence_reference) and the signing time. status declined marks the slot declined. Only a pending slot of this period transitions, once. ÅRL requires each signer to date their signature; the date must fall between the version\'s finalization and today. Idempotent. Dry-runnable.',
    useWhen: 'The board has signed the printed or e-signed document and the signatures are to be registered.',
    doNotUseFor: 'Adding signers (POST .../signatures), filing with Bolagsverket, or BankID signing (not available here).',
    pitfalls: [
      'A version that is not ready_for_signature answers 409 ARSREDOVISNING_VERSION_NOT_SIGNABLE.',
      'A slot already signed or declined, bound to another version, or of another period answers 409 SIGNATURE_INVALID_TRANSITION.',
      'A signed_at before finalization or in the future answers 400 ARSREDOVISNING_SIGNATURE_DATE_INVALID.',
      'evidence_reference is archive:<ref>, document:<id> or receipt:<ref>, not free text.',
      'Recorded signatures cannot be undone: finalize a new version instead.',
    ],
    example: {
      request: {
        status: 'signed',
        annual_report_version_id: '4e7d…',
        signing_method: 'paper_original',
        evidence_reference: 'archive:AR-2026-1',
        signed_at: '2027-03-05T10:00:00Z',
      },
      response: {
        data: { ...SIGNATURE_EXAMPLE, annual_report_version_id: '4e7d…', status: 'signed', signed_at: '2027-03-05T10:00:00Z', signing_method: 'paper_original', evidence_reference: 'archive:AR-2026-1' },
        meta: META,
      },
    },
  },
  input: z
    .object({
      fiscal_period_id: FISCAL_PERIOD_ID,
      signature_id: SIGNATURE_ID,
      status: z.enum(['signed', 'declined']),
      annual_report_version_id: z.string().uuid().optional().describe('Required for signed: the ready_for_signature version.'),
      signing_method: z.enum(['paper_original', 'advanced_e_signature', 'bankid']).optional().describe('Required for signed.'),
      evidence_reference: z.string().optional().describe('Required for signed: archive:<ref>, document:<id> or receipt:<ref>.'),
      signed_at: z.string().datetime().optional().describe('signed only: ISO timestamp, defaults to now.'),
    })
    .strict()
    .superRefine((value, ctx) => {
      // One rule set for both doors: the dashboard's signed contract.
      if (value.status === 'signed') {
        const parsed = SignatureSignedSchema.safeParse({
          status: 'signed',
          ...Object.fromEntries(SIGNED_FIELDS.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
        })
        for (const issue of parsed.success ? [] : parsed.error.issues) {
          ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
        }
      } else {
        for (const key of SIGNED_FIELDS) {
          if (value[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'Only for status signed.' })
        }
      }
    }),
  output: SignatureOut,
  errorCodes: [
    'ARSREDOVISNING_VERSION_NOT_SIGNABLE',
    'SIGNATURE_INVALID_TRANSITION',
    'ARSREDOVISNING_SIGNATURE_DATE_INVALID',
  ],
  http: {
    method: 'PATCH',
    path: `${BASE}/signatures/:signatureId`,
    pathParams: { id: 'fiscal_period_id', signatureId: 'signature_id' },
  },
  run: async (ctx, { fiscal_period_id, signature_id, ...body }, { dryRun }) => {
    const transition =
      body.status === 'signed'
        ? {
            status: 'signed' as const,
            annual_report_version_id: body.annual_report_version_id!,
            signing_method: body.signing_method!,
            evidence_reference: body.evidence_reference!.trim(),
            ...(body.signed_at ? { signed_at: body.signed_at } : {}),
          }
        : { status: 'declined' as const }
    return mapped(
      await (await workflow()).recordArsredovisningSignature(ctx, fiscal_period_id, signature_id, transition, { dryRun }),
      signatureOut,
    )
  },
})

export const arsredovisningRemoveSignatory = defineOperation({
  id: 'arsredovisning.remove-signatory',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Remove a signer from the årsredovisning roster before a version binds it.',
    description:
      'Deletes a pending signer slot that no version has bound yet. Slots bound to a finalized version stay (they are part of what gets signed): finalize a new version with the corrected roster instead. Any roster change clears the signer roster confirmation. Idempotent. Dry-runnable.',
    useWhen: 'A signer was added by mistake or has left the board before the version is finalized.',
    doNotUseFor: 'Declining a bound slot (PATCH .../signatures/{signatureId} {"status": "declined"}).',
    pitfalls: ['A bound, signed or declined slot answers 409 ARSREDOVISNING_SIGNER_ROSTER_LOCKED.', 'Takes no body.'],
    example: { response: { data: { signature_id: '5b1c…', deleted: true }, meta: META } },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID, signature_id: SIGNATURE_ID }),
  output: z.object({ signature_id: z.string().uuid(), deleted: z.literal(true) }),
  errorCodes: ['ARSREDOVISNING_SIGNER_ROSTER_LOCKED'],
  http: {
    method: 'DELETE',
    path: `${BASE}/signatures/:signatureId`,
    pathParams: { id: 'fiscal_period_id', signatureId: 'signature_id' },
  },
  run: async (ctx, { fiscal_period_id, signature_id }, { dryRun }) =>
    (await workflow()).removeArsredovisningSignatory(ctx, fiscal_period_id, signature_id, { dryRun }),
})

// ─────────────────────────────────────────────────────────────────
// iXBRL pre-flight
// ─────────────────────────────────────────────────────────────────

export const arsredovisningValidateIxbrl = defineOperation({
  id: 'arsredovisning.validate-ixbrl',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Pre-flight the generated iXBRL årsredovisning against Bolagsverket\'s kontrollera rules.',
    description:
      'Generates the K2 inline XBRL document (the live draft, or a frozen version with version_id) and runs the local mirror of Bolagsverket\'s kontrollera checks on it, plus a generation dry run and the 5 MB size limit. Issues carry the Bolagsverket code where one exists (e.g. 1107 missing signers) or ACC-*. Nothing is sent to Bolagsverket. Read-only.',
    useWhen: 'Before a digital filing, or to see why the iXBRL document is not ready.',
    doNotUseFor:
      'The ÅRL/K2 completeness checks per stage (gnubok_validate_arsredovisning), or the document itself (GET .../arsredovisning/ixbrl, v1 only).',
    pitfalls: [
      'K2 aktiebolag only: the iXBRL generator does not produce K3 documents.',
      'A validation with issues still answers 200; read ok and error_count.',
      'An unknown version_id answers 404 NOT_FOUND.',
    ],
    example: {
      request: { fiscal_period_id: '7c2b…' },
      response: {
        data: {
          ok: false,
          issues: [{ code: '1107', severity: 'error', message: 'Underskrifter saknas.' }],
          error_count: 1,
          warning_count: 0,
          generated_bytes: 84211,
          entry_point: 'k2-ab-risbs-2024-09-12',
          period: { start: '2026-01-01', end: '2026-12-31' },
          annual_report_version_id: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    fiscal_period_id: FISCAL_PERIOD_ID,
    version_id: z.string().uuid().optional().describe('A frozen version (annual_report_version_id); omit for the live draft.'),
    proposed_dividend: z.coerce
      .number()
      .min(0)
      .optional()
      .describe('Live draft only: proposed dividend in whole SEK for the resultatdisposition.'),
  }),
  output: z.object({
    ok: z.boolean(),
    issues: z.array(z.object({ code: z.string(), severity: z.enum(['error', 'warn']), message: z.string() })),
    error_count: z.number().int(),
    warning_count: z.number().int(),
    generated_bytes: z.number().int(),
    entry_point: z.string(),
    period: z.object({ start: z.string(), end: z.string() }),
    annual_report_version_id: z.string().nullable(),
  }),
  errorCodes: ['PERIOD_NOT_FOUND', 'NOT_FOUND'],
  http: { method: 'GET', path: `${BASE}/ixbrl/validate`, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_validate_arsredovisning_ixbrl',
    title: 'Validate Annual Report iXBRL',
    description:
      'Pre-flight the generated iXBRL årsredovisning (live draft or a frozen version) against Bolagsverket\'s kontrollera rules, plus generation and the 5 MB limit. Different from gnubok_validate_arsredovisning (the ÅRL/K2 completeness checks). Sends nothing.',
    keywords: ['ixbrl', 'kontrollera', 'bolagsverket', 'digital inlämning', 'årsredovisning', 'validera'],
  },
  run: async (ctx, { fiscal_period_id, version_id, proposed_dividend }) =>
    (await files()).validateArsredovisningIxbrl(ctx, { fiscal_period_id, version_id, proposed_dividend }),
})
