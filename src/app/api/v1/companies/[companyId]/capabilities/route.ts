/**
 * GET /api/v1/companies/{companyId}/capabilities
 *
 * Which building blocks (lib/modules/manifest.ts) exist for the company,
 * what state each is in and why: one place for agents, partners and the
 * MCP briefing to ask before calling an endpoint or tool of a module that
 * is not available. Read-only; the report and its rules live in
 * lib/modules/capabilities.ts.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dataEnvelope, registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  CAPABILITY_REASONS,
  CAPABILITY_STATUSES,
  loadCompanyCapabilities,
  publishedCapabilities,
} from '@/lib/modules/capabilities'
import { PROFILE_IDS } from '@/lib/modules/profiles'

const ModuleCapability = z.object({
  id: z.string().describe('Module id: the OpenAPI tag and x-module of the endpoints it owns.'),
  kind: z.enum(['kernel', 'block']).describe('kernel: always present and always active. block: optional by design.'),
  name: z.string(),
  name_sv: z.string(),
  summary: z.string(),
  depends_on: z.array(z.string()).describe('Module ids this module needs present; the kernel is implicit.'),
  status: z.enum(CAPABILITY_STATUSES),
  reasons: z
    .array(z.enum(CAPABILITY_REASONS))
    .describe('Every reason that applies, the deciding one first; empty when active.'),
  resolution: z.string().nullable().describe('One sentence a client can show; null when active.'),
})

const Profile = z
  .object({
    id: z.enum(PROFILE_IDS).describe('Profile id, country-neutral. standard: every package on.'),
    version: z.number().int().describe('The version of the profile whose defaults apply.'),
    name: z.string(),
    name_sv: z.string(),
    source: z
      .enum(['stored', 'implicit'])
      .describe('stored: the company has this profile. implicit: none is stored, so Standard (allt på) applies.'),
  })
  .describe(
    'The company profile: the starting point that decides which packages its menus and tool list show. Read-only here.',
  )

const CapabilitiesResponse = z.object({
  jurisdiction: z.string().describe('ISO 3166-1 alpha-2 country whose law the books follow. Only SE today.'),
  ledger_currency: z.string().describe('ISO 4217 currency of the ledger. Only SEK today.'),
  profile: Profile,
  modules: z.array(ModuleCapability).describe('Every module, kernels first, in the order of the OpenAPI tags.'),
})

registerEndpoint({
  operation: 'capabilities.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/capabilities',
  summary: 'Which building blocks this company can use, and why not.',
  description:
    'Lists every module (the OpenAPI tags) for the company with a status, the reasons behind it and a resolution sentence, like Stripe account capabilities. ' +
    'Statuses: active (usable now); needs_plan (the paid plan does not include it: upgrade, or on a self-hosted instance add a connector key); ' +
    'off (turned off for this company); unsupported (not offered for this company: its country, or its legal form, such as payroll for an enskild firma that has not said it pays salaries). ' +
    'Reasons, the deciding one first: unsupported_country, unsupported_legal_form, needs_plan, disabled_by_company, dependency_unavailable (a module it needs is unsupported or off; it then takes that status). ' +
    'Kernels (platform, ledger) are always active. ' +
    'profile names the company profile (sole-trader, limited-company-no-employees, limited-company-with-employees, retail, association, or standard, every package on): the starting point for which packages the app menu and the MCP tool list show. ' +
    'A module in a package the profile leaves off is hidden there but keeps its status and still answers when called. A company without a stored profile has standard (source implicit). This is a read-only report: nothing here changes a profile or a module.',
  useWhen:
    'At the start of an integration or agent session, before calling endpoints of an optional module (bank feed, payroll, Skatteverket filing, collections, the AI agent), or to explain to a user why something is unavailable.',
  doNotUseFor:
    'Turning a module on or off, or changing the profile: nothing here writes. API key scopes are a separate axis (GET /api/v1/api-key); a module can be active while the key lacks the scope for its endpoints.',
  pitfalls: [
    'A status is a snapshot: a plan change or a settings change moves it. Re-read it rather than caching it for a session.',
    'needs_plan only covers the paid parts of a module; the module\'s free endpoints keep answering. The resolution says what unlocks it.',
    'Modules, statuses and reasons may gain values as the product grows (module ids are experimental, like the OpenAPI tags): treat an unknown status as not active.',
  ],
  example: {
    response: {
      data: {
        jurisdiction: 'SE',
        ledger_currency: 'SEK',
        profile: {
          id: 'standard',
          version: 1,
          name: 'Standard (everything on)',
          name_sv: 'Standard (allt på)',
          source: 'implicit',
        },
        modules: [
          {
            id: 'ledger',
            kind: 'kernel',
            name: 'Ledger',
            name_sv: 'Bokföring',
            summary: 'Double-entry bookkeeping under Bokföringslagen: journal entries and corrections, ...',
            depends_on: ['platform'],
            status: 'active',
            reasons: [],
            resolution: null,
          },
          {
            id: 'bank-feed',
            kind: 'block',
            name: 'Bank feed',
            name_sv: 'Bankkoppling',
            summary: 'Reading the company bank through PSD2 aggregators and Open Payments, ...',
            depends_on: ['transactions'],
            status: 'needs_plan',
            reasons: ['needs_plan'],
            resolution: 'Upgrade the plan to use Bank feed.',
          },
          {
            id: 'payroll',
            kind: 'block',
            name: 'Payroll',
            name_sv: 'Lön',
            summary: 'Swedish payroll: the employee register, salary runs from calculation to booking, ...',
            depends_on: [],
            status: 'unsupported',
            reasons: ['unsupported_legal_form'],
            resolution:
              'Payroll is on for every legal person; an enskild firma turns it on by setting pays_salaries in the company tax profile.',
          },
        ],
      },
      meta: { request_id: 'req_...', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(CapabilitiesResponse), errorCodes: ['NOT_FOUND'] },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('capabilities.get', async (_request, ctx) => {
  try {
    const capabilities = await loadCompanyCapabilities(ctx.supabase, ctx.companyId!)
    if (!capabilities) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    // The module report v1 has always served, and the company's profile.
    return ok(publishedCapabilities(capabilities), { requestId: ctx.requestId })
  } catch (err) {
    ctx.log.error('capabilities.get failed', err as Error)
    return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
