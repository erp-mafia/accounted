/**
 * Packages through the machine doors (Profiles and Suggestions, winding
 * down and Anpassa): read every package with its status and what keeps a
 * switched-off one winding down, and stage switching one on or off.
 *
 * A switch is always staged and approved, never written by the caller: an
 * agent proposes, a person decides ("An agent can propose a change only as a
 * staged operation"). The staged types are enable_package and
 * disable_package, the same ones the suggestion detectors stage; their
 * approval runs commitPackageSwitch (lib/pending-operations/commit.ts),
 * where set_company_package_choice re-checks that the approver is an owner
 * or admin and writes the dated line behandlingshistorik shows. A direct v1
 * call without ?stage=true answers PACKAGE_SWITCH_STAGE_ONLY.
 *
 * Refusals only for plan, country and legal form (the operator's rule):
 * switching on refuses a package the plan, the country or the legal form
 * does not offer; switching off is never refused for what is still open in
 * the package, which winds down instead, and the dry run says what will
 * keep it visible.
 */
import { z } from 'zod'
import { loadCompanyCapabilities, type CompanyCapabilities, type PackageCapability } from '@/lib/modules/capabilities'
import {
  OBLIGATION_CODES,
  OBLIGATION_LABELS,
  isObligationCode,
  obligationsPhraseSv,
  probePackageObligations,
} from '@/lib/modules/obligations'
import type { SwitchablePackageId } from '@/lib/modules/profiles'
import { getModule } from '@/lib/modules/resolve'
import { SWITCHABLE_PACKAGE_IDS } from '@/lib/suggestions/package-switch'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const V1_PATH = '/api/v1/companies/:companyId/packages'

const AVAILABILITY = ['on', 'off', 'winding_down', 'not_in_plan', 'not_in_country'] as const

const PackageIdInput = z
  .string()
  .refine((id) => SWITCHABLE_PACKAGE_IDS.includes(id), { message: 'not a switchable package' })
  .describe(`The package to switch: ${SWITCHABLE_PACKAGE_IDS.join(', ')}. Bokföring (bookkeeping) is always on.`)

const ObligationOut = z.object({
  code: z.enum(OBLIGATION_CODES),
  label_sv: z.string(),
  label_en: z.string(),
})

const PackageOut = z.object({
  package_id: z.string(),
  name: z.string(),
  name_sv: z.string(),
  switchable: z.boolean().describe('False for Bokföring: always on.'),
  availability: z
    .enum(AVAILABILITY)
    .describe('on; off (switched off, nothing open, hidden); winding_down (switched off with obligations still open: visible, no new work starts); not_in_plan; not_in_country.'),
  reasons: z.array(z.string()).describe('Why it is not on, in precedence order; empty when on.'),
  open_obligations: z
    .array(ObligationOut)
    .describe('What keeps a switched-off package winding down; empty unless winding_down.'),
  modules: z.array(z.object({ module_id: z.string(), name_sv: z.string() })),
})

const ListOut = z.object({
  profile: z.object({ profile_id: z.string(), name_sv: z.string(), source: z.enum(['stored', 'implicit']) }),
  packages: z.array(PackageOut),
})

const SwitchOut = z.object({
  package_id: z.string(),
  package_name: z.string(),
  enabled: z.boolean(),
  changed: z.boolean().describe('False when the company already had this choice.'),
  winding_down: z.boolean().describe('Switched off with obligations still open: visible until they are settled.'),
  open_obligations: z.array(z.string()),
})

function obligationsOut(codes: readonly string[]) {
  return codes.filter(isObligationCode).map((code) => ({ code, label_sv: OBLIGATION_LABELS[code].sv, label_en: OBLIGATION_LABELS[code].en }))
}

function packageOut(pkg: PackageCapability) {
  return {
    package_id: pkg.id,
    name: pkg.name,
    name_sv: pkg.name_sv,
    switchable: pkg.switchable,
    availability: pkg.availability,
    reasons: [...pkg.reasons],
    open_obligations: obligationsOut(pkg.open_obligations),
    modules: pkg.modules.map((id) => ({ module_id: id, name_sv: getModule(id).nameSv })),
  }
}

async function capabilitiesOf(ctx: OperationContext): Promise<CompanyCapabilities | null> {
  return loadCompanyCapabilities(ctx.supabase, ctx.companyId)
}

/**
 * Why switching a package on is refused, or null: the plan, the country or
 * the legal form does not offer it. Read from the resolved capabilities, the
 * same reasons the menu and tools/list decide with.
 */
export function switchOnRefusal(
  capabilities: CompanyCapabilities,
  packageId: string,
): { code: string; messageSv: string } | null {
  const pkg = capabilities.packages.find((p) => p.id === packageId)
  if (!pkg) return { code: 'PACKAGE_NOT_SWITCHABLE', messageSv: 'Paketet finns inte.' }
  if (pkg.reasons.includes('unsupported_country')) {
    return { code: 'PACKAGE_NOT_IN_COUNTRY', messageSv: `${pkg.name_sv} finns inte för företag i det här landet.` }
  }
  const notForForm = capabilities.modules.find((m) => m.package === pkg.id && m.reasons.includes('unsupported_legal_form'))
  if (notForForm) {
    return {
      code: 'PACKAGE_NOT_FOR_LEGAL_FORM',
      messageSv:
        pkg.id === 'payroll'
          ? 'Lön är inte påslaget för den här bolagsformen. Ange under Inställningar → Bokföring → Löner att företaget betalar ut lön, och slå sedan på Lön.'
          : `${pkg.name_sv} är inte tillgängligt för företagets bolagsform.`,
    }
  }
  if (pkg.reasons.includes('needs_plan')) {
    return { code: 'PACKAGE_NOT_IN_PLAN', messageSv: `${pkg.name_sv} ingår inte i företagets abonnemang.` }
  }
  return null
}

const stageOnly: OperationOutcome<never> = { ok: false, code: 'PACKAGE_SWITCH_STAGE_ONLY' }

export const packagesList = defineOperation({
  id: 'packages.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company packages with their status and what keeps a switched-off one winding down.',
    description:
      'Every package (Bokföring, Bank, Kundfakturor, Leverantörsfakturor och betalningar, Kvitton och underlag, Utlägg, Lön, ' +
      'Inventarier, Kassa och webbshop) with its availability: on, off, winding_down, not_in_plan or not_in_country. A package ' +
      'switched off while something is still open in it (an unbooked salary run, an unfiled AGI, an unpaid invoice) is ' +
      'winding_down: its pages and tools stay, no new work starts in it (start doors answer PACKAGE_OFF), and open_obligations ' +
      'names what keeps it there. Also the profile the company started from.',
    useWhen: 'A call answered PACKAGE_OFF, or before proposing to switch a package on or off.',
    doNotUseFor: 'The module report and resolutions (GET /capabilities).',
    pitfalls: [
      'A package outside the plan stays visible; its paid features answer at the call.',
      'open_obligations is read only for packages that are switched off.',
    ],
    example: {
      response: {
        data: {
          profile: { profile_id: 'standard', name_sv: 'Standard (allt på)', source: 'implicit' },
          packages: [
            {
              package_id: 'payroll',
              name: 'Payroll',
              name_sv: 'Lön',
              switchable: true,
              availability: 'winding_down',
              reasons: ['turned_off_by_company', 'open_obligations'],
              open_obligations: [
                { code: 'unfiled_agi', label_sv: 'arbetsgivardeklarationer som inte är inlämnade', label_en: 'employer declarations (AGI) not yet filed' },
              ],
              modules: [{ module_id: 'payroll', name_sv: 'Lön' }],
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: ListOut,
  errorCodes: ['NOT_FOUND'],
  http: { method: 'GET', path: V1_PATH },
  mcp: {
    name: 'gnubok_list_packages',
    title: 'List Packages',
    description:
      'Packages (Lön, Kundfakturor, Kassa och webbshop, ...) with status on, off, winding_down, not_in_plan or not_in_country, and what keeps a switched-off one winding down. Use after a PACKAGE_OFF answer.',
    visibility: 'search',
    keywords: ['paket', 'anpassa', 'slå på', 'stäng av', 'avvecklas', 'package_off', 'moduler'],
  },
  run: async (ctx) => {
    const capabilities = await capabilitiesOf(ctx)
    if (!capabilities) return { ok: false, code: 'NOT_FOUND' }
    return {
      ok: true,
      data: {
        profile: {
          profile_id: capabilities.profile.id,
          name_sv: capabilities.profile.name_sv,
          source: capabilities.profile.source,
        },
        packages: capabilities.packages.map(packageOut),
      },
    }
  },
})

export const packagesEnable = defineOperation({
  id: 'packages.enable',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Stage switching a package on, for an owner or admin to approve.',
    description:
      'Proposes switching a package on (enable_package). Nothing changes until an owner or admin approves it, in Accounted or ' +
      'through the approve endpoint; the approval writes the choice with who decided and a dated line in behandlingshistorik. ' +
      'Refused when the plan, the country or the legal form does not offer the package. Send it with ?stage=true.',
    useWhen: 'A call answered PACKAGE_OFF and the user wants to start that work, or the user asks to switch a package on.',
    doNotUseFor: 'Switching a package off (POST /packages/{packageId}/disable).',
    pitfalls: [
      'Only ?stage=true: a direct call answers PACKAGE_SWITCH_STAGE_ONLY.',
      'A service account\'s key cannot approve it: a person approves.',
      'PACKAGE_NOT_FOR_LEGAL_FORM for Lön in an enskild firma that has not said it pays salaries.',
    ],
    example: {
      request: { package_id: 'payroll' },
      response: { data: { package_id: 'payroll', package_name: 'Lön', enabled: true, changed: true, winding_down: false, open_obligations: [] }, meta: META },
    },
  },
  input: z.object({ package_id: PackageIdInput }),
  output: SwitchOut,
  errorCodes: ['PACKAGE_NOT_IN_PLAN', 'PACKAGE_NOT_IN_COUNTRY', 'PACKAGE_NOT_FOR_LEGAL_FORM', 'PACKAGE_SWITCH_STAGE_ONLY', 'NOT_FOUND'],
  http: { method: 'POST', path: `${V1_PATH}/:packageId/enable`, pathParams: { packageId: 'package_id' } },
  mcp: {
    name: 'gnubok_enable_package',
    title: 'Switch Package On',
    description:
      'Stage switching a package on (Lön, Kundfakturor, ...) for an owner or admin to approve. Use when a call answered PACKAGE_OFF and the user wants to start that work. Refused only for plan, country or legal form.',
    visibility: 'search',
    keywords: ['slå på', 'aktivera', 'paket', 'anpassa', 'package_off'],
    stage: {
      pendingType: 'enable_package',
      title: (_input, preview) => `Slå på ${typeof preview?.package === 'string' ? preview.package : 'paketet'}`,
      preview: (_input, preview) => ({ package: preview.package, change: preview.change }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (!dryRun) return stageOnly
    const capabilities = await capabilitiesOf(ctx)
    if (!capabilities) return { ok: false, code: 'NOT_FOUND' }
    const refusal = switchOnRefusal(capabilities, input.package_id)
    if (refusal) return { ok: false, code: refusal.code, messageSv: refusal.messageSv, details: { package_id: input.package_id } }
    const pkg = capabilities.packages.find((p) => p.id === input.package_id)!
    return {
      ok: true,
      dryRun: true,
      preview: {
        package_id: pkg.id,
        package: pkg.name_sv,
        change: 'Slå på',
        availability: pkg.availability,
      },
    }
  },
})

export const packagesDisable = defineOperation({
  id: 'packages.disable',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Stage switching a package off, for an owner or admin to approve.',
    description:
      'Proposes switching a package off (disable_package): its start doors close (no new invoice, salary run, asset, ...), while ' +
      'everything still open in it keeps working. With obligations open the package winds down: it stays visible until they ' +
      'are settled, then disappears. The preview names those obligations. Never refused for what is open. Send it with ?stage=true.',
    useWhen: 'The user no longer uses a package (another payroll provider, no more till) and wants it out of the menu.',
    doNotUseFor: 'Pausing one recurring invoice or disconnecting one connection: use their own endpoints.',
    pitfalls: [
      'Only ?stage=true: a direct call answers PACKAGE_SWITCH_STAGE_ONLY.',
      'Nothing is deleted; switching the package on again brings everything back.',
    ],
    example: {
      request: { package_id: 'payroll' },
      response: {
        data: {
          package_id: 'payroll',
          package_name: 'Lön',
          enabled: false,
          changed: true,
          winding_down: true,
          open_obligations: ['unfiled_agi'],
        },
        meta: META,
      },
    },
  },
  input: z.object({ package_id: PackageIdInput }),
  output: SwitchOut,
  errorCodes: ['PACKAGE_SWITCH_STAGE_ONLY', 'NOT_FOUND'],
  http: { method: 'POST', path: `${V1_PATH}/:packageId/disable`, pathParams: { packageId: 'package_id' } },
  mcp: {
    name: 'gnubok_disable_package',
    title: 'Switch Package Off',
    description:
      'Stage switching a package off for an owner or admin to approve: no new work starts in it, open work keeps running and keeps it visible (winding down) until settled. The preview names what is open.',
    visibility: 'search',
    keywords: ['stäng av', 'dölj', 'avveckla', 'paket', 'anpassa'],
    stage: {
      pendingType: 'disable_package',
      title: (_input, preview) => `Stäng av ${typeof preview?.package === 'string' ? preview.package : 'paketet'}`,
      preview: (_input, preview) => ({
        package: preview.package,
        change: preview.change,
        ...(typeof preview.open_obligations_sv === 'string' && preview.open_obligations_sv
          ? { open_obligations: preview.open_obligations_sv }
          : {}),
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (!dryRun) return stageOnly
    const capabilities = await capabilitiesOf(ctx)
    if (!capabilities) return { ok: false, code: 'NOT_FOUND' }
    const pkg = capabilities.packages.find((p) => p.id === input.package_id)!
    // What switching off leaves open: probed now for a package that is still
    // on, read from the resolver for one already off.
    const alreadyOff = pkg.reasons.includes('turned_off_by_company') || pkg.reasons.includes('off_in_profile')
    const open: readonly string[] = alreadyOff
      ? pkg.open_obligations
      : await probePackageObligations(ctx.supabase, ctx.companyId, pkg.id as SwitchablePackageId)
    return {
      ok: true,
      dryRun: true,
      preview: {
        package_id: pkg.id,
        package: pkg.name_sv,
        change: 'Stäng av',
        availability: pkg.availability,
        winding_down: open.length > 0,
        open_obligations: [...open],
        open_obligations_sv: obligationsPhraseSv(open),
      },
    }
  },
})

export const PACKAGE_OPERATIONS = [packagesList, packagesEnable, packagesDisable] as const
