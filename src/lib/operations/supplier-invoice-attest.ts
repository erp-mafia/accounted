/**
 * The attest policy for supplier invoices through the machine doors: read and
 * save the company's policy, and read where the attest of one invoice stands.
 * The rules live in lib/supplier-invoices/attest-policy.ts and the reads and
 * writes in lib/supplier-invoices/attest-service.ts; the dashboard's
 * /api/supplier-invoices/attest-policy and /api/supplier-invoices/:id/attestations
 * call the same functions.
 *
 * Attesting itself stays POST .../supplier-invoices/:id/approve and
 * gnubok_approve_supplier_invoice, which now go through the policy.
 * Saving the policy is an owner's or admin's decision about who controls
 * payments, so it has no MCP tool: v1 only, and requireCompanyAdmin in the
 * service door. The same holds for substitutes (#192): they decide who may
 * release a payment, so v1 adds and removes them and MCP reads them with the
 * policy.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  ATTEST_COMMENT_MAX,
  ATTEST_MAX_ATTESTERS,
  ATTEST_MAX_PROJECTS,
  ATTEST_SUBSTITUTE_MAX_DAYS,
  attestLimitOf,
  byteOrder,
} from '@/lib/supplier-invoices/attest-policy'
import { loadProjectNames } from '@/lib/supplier-invoices/attest-policy-read'
import {
  addAttestSubstitute,
  getSupplierInvoiceAttestState,
  loadAttestLimits,
  loadAttestPeople,
  loadAttestPolicy,
  loadAttestSubstitutes,
  rejectSupplierInvoice,
  removeAttestSubstitute,
  saveAttestPolicy,
} from '@/lib/supplier-invoices/attest-service'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { getCompanyRole } from '@/lib/auth/require-write'
import { COMPANY_ADMIN_ROLES, requireCompanyAdmin } from './access'
import { defineOperation, type OperationContext } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const Person = z.object({
  user_id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
})

const LIMIT_SEK_MAX = 999_999_999_999

const PolicyOut = z.object({
  enabled: z.boolean(),
  threshold_amount: z.number().nullable().describe('Attest is required at or above this total in SEK; null = every invoice.'),
  mode: z.enum(['any', 'all']).describe('any: one attester is enough; all: every attester who may attest the invoice.'),
  attesters: z.array(
    Person.extend({
      limit_sek: z.number().nullable().describe('The highest invoice total in SEK this attester\'s approval covers; null = no limit.'),
    }),
  ),
  preparer_may_attest: z.boolean().describe('False: the person who registered an invoice cannot attest it.'),
  two_step_from_sek: z
    .number()
    .nullable()
    .describe('From this total in SEK two different attesters must approve, at least one with a covering limit; null = one is enough.'),
  pre_attesters: z
    .array(Person)
    .describe('Förattest: one of them approves first an invoice (or a line) without a project of its own in project_attesters; empty = none.'),
  project_attesters: z
    .array(z.object({ project: z.string(), project_name: z.string().nullable(), attesters: z.array(Person) }))
    .describe('Förattest per project (dimension 6 code): every project on an invoice\'s lines needs one approval by one of its attesters before the attesters may attest.'),
  substitutes: z
    .array(
      z.object({
        substitute_id: z.string().uuid(),
        user: Person.describe('The attester who is away.'),
        substitute: Person.describe('Who attests in their place, as them, while the period runs.'),
        starts_on: z.string(),
        ends_on: z.string(),
        active: z.boolean().describe('The period runs today (Stockholm dates, both days included).'),
      }),
    )
    .describe('Substitutes that run now or later.'),
  updated_at: z.string().nullable(),
})

/** The policy with its attesters named and their limits. The machine doors run as the service role, which reads the profiles. */
async function policyOut(ctx: { supabase: SupabaseClient; companyId: string }) {
  const [policy, limits, substitutes] = await Promise.all([
    loadAttestPolicy(ctx.supabase, ctx.companyId),
    loadAttestLimits(ctx.supabase, ctx.companyId),
    loadAttestSubstitutes(ctx.supabase, ctx.companyId),
  ])
  const projects = Object.entries(policy.project_attesters ?? {})
  const [people, projectNames] = await Promise.all([
    loadAttestPeople(ctx.supabase, [
      ...policy.attesters,
      ...(policy.pre_attesters ?? []),
      ...projects.flatMap(([, ids]) => ids),
      ...substitutes.flatMap((s) => [s.user_id, s.substitute_user_id]),
    ]),
    loadProjectNames(ctx.supabase, ctx.companyId, projects.map(([code]) => code)),
  ])
  const person = (id: string) => people.get(id) ?? { user_id: id, name: null, email: null }
  const today = todayIsoStockholm()
  return {
    enabled: policy.enabled,
    threshold_amount: policy.threshold_amount,
    mode: policy.mode,
    attesters: policy.attesters.map((id) => ({ ...person(id), limit_sek: attestLimitOf(limits, id) })),
    preparer_may_attest: policy.preparer_may_attest,
    two_step_from_sek: policy.two_step_from_sek,
    pre_attesters: (policy.pre_attesters ?? []).map(person),
    project_attesters: projects
      .sort(([a], [b]) => byteOrder(a, b))
      .map(([project, ids]) => ({ project, project_name: projectNames.get(project) ?? null, attesters: ids.map(person) })),
    substitutes: substitutes.map((s) => ({
      substitute_id: s.id,
      user: person(s.user_id),
      substitute: person(s.substitute_user_id),
      starts_on: s.starts_on,
      ends_on: s.ends_on,
      active: s.starts_on <= today && s.ends_on >= today,
    })),
    updated_at: policy.updated_at,
  }
}

export const supplierInvoicesAttestPolicyGet = defineOperation({
  id: 'supplier-invoices.attest-policy.get',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the company\'s attest policy for supplier invoices.',
    description:
      'Whether the policy is on, the amount in SEK from which attest is required (null = every invoice), the attesters with ' +
      'their limits in SEK (limit_sek, null = no limit), mode any (one attester is enough) or all (every attester who may ' +
      'attest the invoice), whether the person who registered an invoice may attest it, and two_step_from_sek: from that ' +
      'amount two different attesters must approve. Below it one approval by an attester whose limit covers the invoice is ' +
      'enough; at or above it two, at least one with a covering limit, in any order. Ordered steps: with förattest ' +
      '(pre_attesters, project_attesters per project code of dimension 6) every project on an invoice\'s lines first needs ' +
      'one approval by its attesters (lines without a project of their own by pre_attesters), and only then do the ' +
      'attesters attest; one person\'s approval counts once per invoice, so a förattestant does not also attest it. ' +
      'substitutes: while a period runs, the substitute attests wherever the attester may, as them. With the policy on, an ' +
      'invoice that needs attest is left out of bank payments and payment files until the policy is satisfied. ' +
      'Kontantmetoden has no attest step and the policy does not apply there.',
    useWhen: 'Before attesting or preparing payments: who may attest, and why an invoice waits.',
    doNotUseFor: 'Where one invoice\'s attest stands (GET /supplier-invoices/{id}/attestations).',
    pitfalls: [
      'A company that never saved a policy answers enabled false with no attesters.',
      'With levels on (a limit or two_step_from_sek), an attest through an API key is capped by the lower of the key user\'s limit and the key\'s unattended ceiling.',
      'A company without förattest and substitutes answers pre_attesters [], project_attesters [] and substitutes [].',
    ],
    example: {
      response: {
        data: {
          enabled: true,
          threshold_amount: 5000,
          mode: 'any',
          attesters: [
            { user_id: '3f0c…', name: 'Anna Ek', email: 'anna@example.se', limit_sek: 50000 },
            { user_id: '8b2d…', name: 'Bo Lind', email: 'bo@example.se', limit_sek: null },
          ],
          preparer_may_attest: false,
          two_step_from_sek: 100000,
          pre_attesters: [],
          project_attesters: [{ project: 'P100', project_name: 'Kv. Eken', attesters: [{ user_id: '5a7e…', name: 'Cecilia Berg', email: 'cecilia@example.se' }] }],
          substitutes: [
            {
              substitute_id: '1c4f…',
              user: { user_id: '8b2d…', name: 'Bo Lind', email: 'bo@example.se' },
              substitute: { user_id: '3f0c…', name: 'Anna Ek', email: 'anna@example.se' },
              starts_on: '2026-12-21',
              ends_on: '2027-01-06',
              active: false,
            },
          ],
          updated_at: '2026-10-14T09:00:00.000Z',
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: PolicyOut,
  http: { method: 'GET', path: '/api/v1/companies/:companyId/supplier-invoices/attest-policy' },
  mcp: {
    name: 'gnubok_get_attest_policy',
    title: 'Get Attest Policy',
    description:
      'Read the attest policy for supplier invoices: on or off, the SEK threshold, the attesters, any or all, whether the registrant may attest, the förattest per project that comes first, and the substitutes. With it on, unattested invoices are left out of payments.',
    visibility: 'search',
    keywords: ['attest', 'attestera', 'attestregler', 'attestflöde', 'attestant', 'godkänn faktura', 'fyra ögon', 'förattest', 'projektattest', 'ersättare'],
  },
  run: async (ctx) => ({ ok: true, data: await policyOut(ctx) }),
})

export const AttestPolicyInput = z.object({
  enabled: z.boolean(),
  threshold_amount: z.number().nonnegative().max(1e12).nullable().describe('Attest from this total in SEK; null = every invoice.'),
  mode: z.enum(['any', 'all']),
  attesters: z
    .array(z.string().uuid())
    .max(ATTEST_MAX_ATTESTERS)
    .describe('User ids of company members whose attest can count: owner, admin, member, or viewer (who attests and changes nothing else). At least one when enabled.'),
  preparer_may_attest: z.boolean().default(false),
  two_step_from_sek: z
    .number()
    .nonnegative()
    .max(LIMIT_SEK_MAX)
    .nullable()
    .optional()
    .describe('Two different attesters from this total in SEK, at least one with a covering limit; null = one is enough. Left out: unchanged.'),
  limits: z
    .array(
      z.object({
        user_id: z.string().uuid(),
        max_amount_sek: z
          .number()
          .min(0.01)
          .max(LIMIT_SEK_MAX)
          .nullable()
          .describe('The highest invoice total in SEK this attester\'s approval covers; null = no limit.'),
      }),
    )
    .max(ATTEST_MAX_ATTESTERS)
    .optional()
    .describe('Attest limits per attester; replaces every limit (an attester left out has none). Left out: unchanged.'),
  pre_attesters: z
    .array(z.string().uuid())
    .max(ATTEST_MAX_ATTESTERS)
    .optional()
    .describe('Förattest for invoices (and lines) without a project of their own in project_attesters: one of them approves first. Empty = none. Left out: unchanged.'),
  project_attesters: z
    .array(
      z.object({
        project: z.string().trim().min(1).max(40).regex(/^[^"{}]+$/).describe('The project\'s code in dimension 6.'),
        attesters: z.array(z.string().uuid()).min(1).max(ATTEST_MAX_ATTESTERS),
      }),
    )
    .max(ATTEST_MAX_PROJECTS)
    .optional()
    .describe('Förattest per project: replaces every project\'s (a project left out has none). Left out: unchanged.'),
})

export const supplierInvoicesAttestPolicyUpdate = defineOperation({
  id: 'supplier-invoices.attest-policy.update',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Save the company\'s attest policy for supplier invoices.',
    description:
      'Replaces the policy: enabled, threshold_amount (SEK, null = every invoice), mode any or all, the attesters (company members ' +
      'who may write, or viewers), preparer_may_attest, and optionally two_step_from_sek and limits (the attest limit per attester in SEK; ' +
      'both left as they are when left out), and optionally pre_attesters and project_attesters, the förattest that comes first (left ' +
      'as they are when left out). With it on, POST /supplier-invoices/{id}/approve only accepts the attesters (not the ' +
      'registrant unless preparer_may_attest) whose approval can count under their limit, approved_at is set when the policy is ' +
      'satisfied, and payments leave an invoice out until then (attest_required). The policy and the limits are saved together. ' +
      'Owners and admins only. Idempotent. Dry-runnable.',
    useWhen: 'Setting up or changing who attests supplier invoices.',
    doNotUseFor: 'Attesting an invoice (POST /supplier-invoices/{id}/approve).',
    pitfalls: [
      'ATTEST_POLICY_NO_ATTESTERS: a policy that is on needs at least one attester.',
      'ATTEST_POLICY_ATTESTER_NOT_MEMBER: every attester must be a member who may write or a viewer; details.user_ids names the others.',
      'ATTEST_POLICY_TWO_STEP_NEEDS_TWO: two_step_from_sek with the policy on needs at least two attesters.',
      'ATTEST_LIMIT_NOT_ATTESTER: a limit is for an attester; details.user_ids names the others.',
      'ATTEST_PROJECT_NOT_FOUND: a project in project_attesters is not a code of dimension 6; details.projects names them.',
      'One person approves an invoice once: someone who is both förattestant and attester for an invoice gives one of the two, and the other step needs someone else.',
      'Keep at least one attester without a limit (null): an invoice above every limit has nobody whose approval covers it.',
      'FORBIDDEN: only an owner or admin saves the policy.',
    ],
    example: {
      request: {
        enabled: true,
        threshold_amount: 5000,
        mode: 'any',
        attesters: ['3f0c…', '8b2d…'],
        preparer_may_attest: false,
        two_step_from_sek: 100000,
        limits: [
          { user_id: '3f0c…', max_amount_sek: 50000 },
          { user_id: '8b2d…', max_amount_sek: null },
        ],
      },
      response: {
        data: {
          enabled: true,
          threshold_amount: 5000,
          mode: 'any',
          attesters: [
            { user_id: '3f0c…', name: 'Anna Ek', email: 'anna@example.se', limit_sek: 50000 },
            { user_id: '8b2d…', name: 'Bo Lind', email: 'bo@example.se', limit_sek: null },
          ],
          preparer_may_attest: false,
          two_step_from_sek: 100000,
          updated_at: '2026-10-14T09:00:00.000Z',
        },
        meta: META,
      },
    },
  },
  input: AttestPolicyInput,
  output: PolicyOut,
  errorCodes: [
    'ATTEST_POLICY_NO_ATTESTERS',
    'ATTEST_POLICY_ATTESTER_NOT_MEMBER',
    'ATTEST_POLICY_TWO_STEP_NEEDS_TWO',
    'ATTEST_LIMIT_NOT_ATTESTER',
    'ATTEST_PROJECT_NOT_FOUND',
    'FORBIDDEN',
  ],
  http: { method: 'PUT', path: '/api/v1/companies/:companyId/supplier-invoices/attest-policy' },
  run: async (ctx, input, { dryRun }) => {
    // The v1 door runs as the service role: RLS cannot say who is an admin there.
    const refused = await requireCompanyAdmin(ctx, 'Bara företagets ägare eller en administratör kan ändra attestreglerna.')
    if (refused) return refused
    const saved = await saveAttestPolicy(ctx, input, { dryRun, writer: ctx.supabase })
    if (!saved.ok || saved.dryRun) return saved
    return { ok: true, data: await policyOut(ctx) }
  },
})

const AttestStateOut = z.object({
  supplier_invoice_id: z.string().uuid(),
  required: z.boolean().describe('The policy requires attest for this invoice.'),
  satisfied: z.boolean().describe('Attested: approved_at is set, or the policy is satisfied.'),
  blocked: z.boolean().describe('Nobody may attest the invoice under the policy (for example the only attester registered it).'),
  approved_at: z.string().nullable(),
  approved_by: Person.nullable(),
  approved: z.array(Person).describe('Attesters who approved in the current round.'),
  remaining: z
    .array(
      Person.extend({
        limit_sek: z.number().nullable().describe('Their attest limit in SEK (a substitute: the one of whom they stand in for); null = no limit.'),
        stands_in_for: Person.nullable().describe('A substitute: the attester they stand in for today. Null in their own name.'),
      }),
    )
    .describe('Who may give an approval that moves the invoice on at the step it is at (only those with a covering limit when that is what is missing), and the substitutes standing in for them.'),
  amount_sek: z.number().nullable().describe('The invoice total in SEK the limits are judged against; null for a foreign invoice without a rate.'),
  steps: z.union([z.literal(1), z.literal(2)]).describe('How many different attesters the invoice needs: 2 from the policy\'s two_step_from_sek.'),
  approvals_needed: z.number().int().describe('How many more approvals the invoice needs; 0 once attested.'),
  needs_covering: z.boolean().describe('One of the missing approvals must come from an attester whose limit covers amount_sek.'),
  stage: z
    .enum(['pre', 'final'])
    .nullable()
    .describe('With förattest: pre while a förattest is missing, final once the attest is what is left. Null without förattest or once attested.'),
  pre_attest: z
    .array(
      z.object({
        project: z.string().nullable().describe('The project code; null for lines without a project of their own.'),
        project_name: z.string().nullable(),
        done: z.boolean(),
        approved_by: Person.nullable(),
        attesters: z.array(Person).describe('Who may give it, while it is missing.'),
      }),
    )
    .describe('The förattests the invoice needs, in order; empty without förattest.'),
  acts_for: Person.nullable().describe('The attester the key\'s user would approve for, as their substitute; null in their own name.'),
  latest_rejection: z.object({ user: Person, comment: z.string().nullable(), decided_at: z.string() }).nullable(),
  attestations: z.array(
    z.object({
      attestation_id: z.string().uuid(),
      user: Person,
      decision: z.enum(['approved', 'rejected']),
      comment: z.string().nullable(),
      source: z.enum(['app', 'email_link', 'api', 'mcp']),
      decided_at: z.string(),
      step: z.number().int().nullable().describe('The approval\'s place in its round under the policy (1, 2); null otherwise.'),
      stage: z.enum(['pre', 'final']).nullable().describe('The step it was given in; null for a rejection and older rows.'),
      on_behalf_of: Person.nullable().describe('The attester a substitute decided for; null in their own name.'),
    }),
  ),
  viewer: z.object({
    may_approve: z.boolean(),
    may_reject: z.boolean(),
    reason: z
      .string()
      .nullable()
      .describe('Why not: not_attester, registrant, not_member, other_step (the invoice is at a step that is not theirs), already_given, limit, key_limit, already_approved, not_pending.'),
    acts_for: z.string().uuid().optional().describe('The attester the key\'s user would approve for, as their substitute.'),
  }),
})

export const supplierInvoicesAttestationsList = defineOperation({
  id: 'supplier-invoices.attestations.list',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Where the attest of one supplier invoice stands: who attested, who is left, every decision.',
    description:
      'Answers whether the attest policy requires attest for the invoice, whether it is satisfied, the attesters who approved in ' +
      'the current round and those whose approval would move it on (with their limits), how many approvals it still needs and ' +
      'whether one must come from an attester whose limit covers the amount, the latest rejection with its comment, every decision (approved or rejected, ' +
      'who, when, source app / email_link / api / mcp) and whether the API key\'s user may approve or reject it now. A rejection ' +
      'starts a new round: approvals before it no longer count. With förattest, stage and pre_attest say which step the invoice is at.',
    useWhen: 'An invoice is left out of payment with attest_required, or before attesting.',
    doNotUseFor: 'The policy itself (GET /supplier-invoices/attest-policy).',
    pitfalls: ['An invoice of another company answers 404 SI_NOT_FOUND.'],
    example: {
      response: {
        data: {
          supplier_invoice_id: '0e9c…',
          required: true,
          satisfied: false,
          blocked: false,
          approved_at: null,
          approved_by: null,
          approved: [],
          remaining: [{ user_id: '3f0c…', name: 'Anna Ek', email: 'anna@example.se', limit_sek: null, stands_in_for: null }],
          amount_sek: 12500,
          steps: 1,
          approvals_needed: 1,
          needs_covering: true,
          stage: null,
          pre_attest: [],
          acts_for: null,
          latest_rejection: null,
          attestations: [],
          viewer: { may_approve: false, may_reject: false, reason: 'registrant' },
        },
        meta: META,
      },
    },
  },
  input: z.object({ supplier_invoice_id: z.string().uuid() }),
  output: AttestStateOut,
  errorCodes: ['SI_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id/attestations',
    pathParams: { id: 'supplier_invoice_id' },
  },
  run: async (ctx, input) => getSupplierInvoiceAttestState(ctx, input.supplier_invoice_id, { writer: ctx.supabase }),
})

export const supplierInvoicesReject = defineOperation({
  id: 'supplier-invoices.reject',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Reject (neka) the attest of a supplier invoice that waits for it, with an optional comment.',
    description:
      'Records the rejection and its comment in the attest trail as the API key\'s user. The attest round starts over: approvals ' +
      'given so far no longer count, and the attest mail\'s links for the invoice stop working. The invoice stays registered (or ' +
      'overdue past its due date); nothing is booked or paid. Whoever may approve at some step may reject: with the attest policy on ' +
      'its attesters and förattestants and their substitutes, not the registrant unless the policy allows it. Idempotency-Key is ' +
      'mandatory: a replay answers the first call. Dry-runnable.',
    useWhen: 'An attester does not accept the invoice (wrong amount, not ordered, wrong supplier) and the registrant should look again.',
    doNotUseFor: 'Withdrawing a booked invoice (POST /supplier-invoices/{id}/credit) or deleting an unbooked one.',
    pitfalls: [
      'ATTEST_NOT_PENDING: the invoice is already attested or settled.',
      'ATTEST_NOT_ALLOWED: the attest policy does not let this user decide on the invoice.',
      'FORBIDDEN: no attest policy governs the invoice and this user does not keep the books (details.reason read_only or not_member).',
    ],
    example: {
      request: { comment: 'Fel belopp, kontakta leverantören.' },
      response: { data: { supplier_invoice_id: '0e9c…', attestation_id: '9a1b…', status: 'registered' }, meta: META },
    },
  },
  input: z.object({
    supplier_invoice_id: z.string().uuid(),
    comment: z.string().max(ATTEST_COMMENT_MAX).nullish().describe('Why: shown to the registrant on the invoice.'),
  }),
  output: z.object({
    supplier_invoice_id: z.string().uuid(),
    attestation_id: z.string().uuid(),
    status: z.string(),
  }),
  errorCodes: ['SI_NOT_FOUND', 'ATTEST_NOT_PENDING', 'ATTEST_NOT_ALLOWED', 'FORBIDDEN'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id/reject',
    pathParams: { id: 'supplier_invoice_id' },
  },
  run: async (ctx, input, { dryRun }) =>
    rejectSupplierInvoice(ctx, {
      invoiceId: input.supplier_invoice_id,
      comment: input.comment ?? null,
      source: 'api',
      writer: ctx.supabase,
      dryRun,
    }),
})

const IsoDate = saneIsoDateSchema

export const AttestSubstituteInput = z
  .object({
    user_id: z.string().uuid().describe('The attester who is away.'),
    substitute_user_id: z.string().uuid().describe('Who attests in their place: a member whose attest can count.'),
    starts_on: IsoDate.describe('The first day, a Stockholm date.'),
    ends_on: IsoDate.describe('The last day, a Stockholm date, included.'),
  })
  .refine((v) => v.user_id !== v.substitute_user_id, { message: 'Ersättaren måste vara någon annan.', path: ['substitute_user_id'] })
  .refine((v) => v.ends_on >= v.starts_on, { message: 'Sista dagen kan inte ligga före den första.', path: ['ends_on'] })
  .refine((v) => daysBetweenIso(v.starts_on, v.ends_on) <= ATTEST_SUBSTITUTE_MAX_DAYS, {
    message: 'En ersättare gäller som längst ett år.',
    path: ['ends_on'],
  })

const SubstituteOut = z.object({
  substitute_id: z.string().uuid(),
  user_id: z.string().uuid(),
  substitute_user_id: z.string().uuid(),
  starts_on: z.string(),
  ends_on: z.string(),
})

/** Owners and admins act for anyone; the v1 door runs as the service role, so the role is read here. */
async function isCompanyAdminActor(ctx: OperationContext): Promise<boolean> {
  const result = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  return result.ok && (COMPANY_ADMIN_ROLES as readonly string[]).includes(result.role)
}

export const supplierInvoicesAttestSubstituteAdd = defineOperation({
  id: 'supplier-invoices.attest-substitutes.create',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Name a substitute for a supplier invoice attester for a period.',
    description:
      'While the period runs (Stockholm dates, both days included, at most a year), substitute_user_id attests supplier invoices ' +
      'wherever user_id may, as them: in their place in the order (förattest or attest), with their limit. The decision is ' +
      'recorded as the substitute\'s, for the attester (on_behalf_of), and the attest mail and Att göra reach the substitute. ' +
      'An owner or admin names a substitute for anyone; anyone else only for themselves. Dry-runnable.',
    useWhen: 'An attester will be away (vacation, leave) and invoices must still be attested.',
    doNotUseFor: 'Making someone an attester for good (PUT /supplier-invoices/attest-policy).',
    pitfalls: [
      'ATTEST_SUBSTITUTE_NOT_MEMBER: both must be members whose attest can count; details.user_ids names the others.',
      'FORBIDDEN: only an owner or admin names a substitute for someone else.',
      'ATTEST_SUBSTITUTE_NO_POLICY: the company has never saved an attest policy.',
      'One person approves an invoice once: a substitute who already approved it in their own name cannot approve it again for the attester.',
    ],
    example: {
      request: { user_id: '8b2d…', substitute_user_id: '3f0c…', starts_on: '2026-12-21', ends_on: '2027-01-06' },
      response: {
        data: { substitute_id: '1c4f…', user_id: '8b2d…', substitute_user_id: '3f0c…', starts_on: '2026-12-21', ends_on: '2027-01-06' },
        meta: META,
      },
    },
  },
  input: AttestSubstituteInput,
  output: SubstituteOut,
  errorCodes: ['ATTEST_SUBSTITUTE_NOT_MEMBER', 'ATTEST_SUBSTITUTE_NO_POLICY', 'FORBIDDEN', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/supplier-invoices/attest-substitutes' },
  run: async (ctx, input, { dryRun }) => {
    const added = await addAttestSubstitute(ctx, input, { isAdmin: await isCompanyAdminActor(ctx), dryRun, writer: ctx.supabase })
    if (!added.ok || added.dryRun) return added
    const { id, user_id, substitute_user_id, starts_on, ends_on } = added.data
    return { ok: true, data: { substitute_id: id, user_id, substitute_user_id, starts_on, ends_on } }
  },
})

export const supplierInvoicesAttestSubstituteRemove = defineOperation({
  id: 'supplier-invoices.attest-substitutes.delete',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Remove a substitute for a supplier invoice attester.',
    description:
      'Ends the substitution at once: the substitute no longer attests in the attester\'s place. What they attested stays. ' +
      'An owner or admin removes any; the attester who is away removes their own. Dry-runnable.',
    useWhen: 'The attester is back early, or the substitute was named by mistake.',
    doNotUseFor: 'Changing who attests for good (PUT /supplier-invoices/attest-policy).',
    pitfalls: ['ATTEST_SUBSTITUTE_NOT_FOUND: no such substitute in this company (or already removed).'],
    example: { response: { data: { substitute_id: '1c4f…', removed: true }, meta: META } },
  },
  input: z.object({ substitute_id: z.string().uuid() }),
  output: z.object({ substitute_id: z.string().uuid(), removed: z.literal(true) }),
  errorCodes: ['ATTEST_SUBSTITUTE_NOT_FOUND', 'FORBIDDEN'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/supplier-invoices/attest-substitutes/:id',
    pathParams: { id: 'substitute_id' },
  },
  run: async (ctx, input, { dryRun }) => {
    const removed = await removeAttestSubstitute(ctx, input.substitute_id, { isAdmin: await isCompanyAdminActor(ctx), dryRun, writer: ctx.supabase })
    if (!removed.ok || removed.dryRun) return removed
    return { ok: true, data: { substitute_id: removed.data.id, removed: true as const } }
  },
})

export const SUPPLIER_INVOICE_ATTEST_OPERATIONS = [
  supplierInvoicesAttestPolicyGet,
  supplierInvoicesAttestPolicyUpdate,
  supplierInvoicesAttestationsList,
  supplierInvoicesReject,
  supplierInvoicesAttestSubstituteAdd,
  supplierInvoicesAttestSubstituteRemove,
] as const
