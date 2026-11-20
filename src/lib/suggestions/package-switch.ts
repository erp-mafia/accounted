/**
 * The commit side of a package switch: what enable_package and
 * disable_package run once a person approved them
 * (lib/pending-operations/commit.ts).
 *
 * set_company_package_choice (migration 20261016230000, restating
 * 20261016200400) is the authority: it re-checks that the approver is an
 * owner or admin, writes the company's choice with who decided, and writes
 * the audit_log row behandlingshistorik shows as a dated line. It runs
 * through the service role on every path, an approval in the app included
 * (a session client may not call it). Switching off is never refused for
 * what is still open: the package winds down (lib/modules/obligations.ts)
 * and the answer names what keeps it visible.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { probePackageObligations, type ObligationCode } from '@/lib/modules/obligations'
import { getPackage, PACKAGES } from '@/lib/modules/packages'
import type { SwitchablePackageId } from '@/lib/modules/profiles'

/** The packages a company can switch: every package but Bokföring. */
export const SWITCHABLE_PACKAGE_IDS: readonly string[] = Object.freeze(PACKAGES.filter((p) => p.switchable).map((p) => p.id))

export const PackageSwitchParamsSchema = z.object({
  package_id: z.string().refine((id) => SWITCHABLE_PACKAGE_IDS.includes(id), { message: 'not a switchable package' }),
  /** suggestion: a detector proposed it. company: the company asked for it. */
  source: z.enum(['suggestion', 'company']).optional(),
  /** Set by stage_company_suggestion on every suggestion. */
  suggestion_key: z.string().optional(),
})

export type PackageSwitchParams = z.infer<typeof PackageSwitchParamsSchema>

/** Swedish phrase per package_open_obligations code, for the refusal. */
const OBLIGATION_PHRASES_SV: Record<string, string> = {
  active_bank_connection: 'en aktiv bankkoppling',
  unpaid_customer_invoices: 'obetalda kundfakturor',
  active_recurring_invoices: 'aktiva återkommande fakturor',
  open_collection_cases: 'öppna inkassoärenden',
  open_rot_rut_payout_requests: 'ROT/RUT-begäranden där utbetalningen från Skatteverket inte är bokförd',
  unpaid_supplier_invoices: 'obetalda leverantörsfakturor',
  payments_in_flight: 'betalningar som är på väg',
  unhandled_documents: 'underlag som inte är hanterade',
  unpaid_expense_claims: 'utlägg som inte är utbetalda',
  unbooked_mileage: 'resor i körjournalen som inte är bokförda',
  active_employees: 'aktiva anställda',
  open_salary_runs: 'lönekörningar som inte är bokförda',
  unfiled_agi: 'arbetsgivardeklarationer som inte är inlämnade',
  active_assets: 'inventarier som fortfarande skrivs av',
  active_pos_connection: 'ett kopplat kassasystem',
  unbooked_pos_days: 'kassadagar som inte är bokförda',
  active_webshop_connection: 'en kopplad webbshop',
  unbooked_webshop_orders: 'webbshopsordrar som inte är bokförda',
}

function joinSv(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}`
}

/** "Lön kan inte stängas av medan det finns aktiva anställda och lönekörningar som inte är bokförda." */
export function openObligationsMessageSv(packageId: string, obligations: readonly string[]): string {
  const name = getPackage(packageId)?.nameSv ?? packageId
  const phrases = obligations.map((code) => OBLIGATION_PHRASES_SV[code]).filter((p): p is string => !!p)
  if (phrases.length === 0) return `${name} kan inte stängas av medan något är öppet där.`
  return `${name} kan inte stängas av medan det finns ${joinSv(phrases)}.`
}

export interface PackageSwitchInput {
  companyId: string
  /** The approver each commit path verified (a key's owner for a key). */
  userId: string
  pendingOperationId: string
  enabled: boolean
  params: PackageSwitchParams
  /** The credential that relayed the approval. */
  actor: { type: string; label?: string | null }
}

export type PackageSwitchResult =
  | {
      ok: true
      data: {
        package_id: string
        package_name: string
        enabled: boolean
        /** False when the company already had this choice: nothing was written. */
        changed: boolean
        capability_config_id: string | null
        decided_at: string | null
        /**
         * Switched off with obligations still open: the package stays
         * visible, its start doors closed, until they are settled. False
         * when switched on, and when nothing was open.
         */
        winding_down: boolean
        /** What keeps it winding down (lib/modules/obligations.ts); empty unless winding_down. */
        open_obligations: ObligationCode[]
      }
    }
  | { ok: false; code: string; message_sv: string; status: number; obligations?: string[] }

interface ChoiceRpcResult {
  ok: boolean
  code?: string
  unchanged?: boolean
  obligations?: string[]
  capability_config_id?: string
  decided_at?: string
}

function refusal(code: string, fallbackStatus: number): PackageSwitchResult {
  const entry = getErrorEntry(code)
  return { ok: false, code, message_sv: entry?.message_sv ?? code, status: entry?.httpStatus ?? fallbackStatus }
}

export async function switchCompanyPackage(
  serviceClient: SupabaseClient,
  input: PackageSwitchInput,
): Promise<PackageSwitchResult> {
  const { params } = input
  const source = params.source ?? (params.suggestion_key ? 'suggestion' : 'company')
  const { data, error } = await serviceClient.rpc('set_company_package_choice', {
    p_company_id: input.companyId,
    p_package_id: params.package_id,
    p_enabled: input.enabled,
    p_source: source,
    p_decided_by: input.userId,
    p_actor_type: input.actor.type,
    p_actor_label: input.actor.label ?? null,
    p_pending_operation_id: input.pendingOperationId,
  })
  if (error) throw new Error(`Failed to switch the package: ${error.message}`)
  const result = (data ?? {}) as ChoiceRpcResult
  if (!result.ok) {
    // Only a database still on 20261016200400 answers this (a deploy that
    // reaches it before the migration): the switch is refused as before.
    if (result.code === 'PACKAGE_HAS_OPEN_OBLIGATIONS') {
      const obligations = Array.isArray(result.obligations) ? result.obligations : []
      return {
        ok: false,
        code: 'PACKAGE_HAS_OPEN_OBLIGATIONS',
        message_sv: openObligationsMessageSv(params.package_id, obligations),
        status: getErrorEntry('PACKAGE_HAS_OPEN_OBLIGATIONS')?.httpStatus ?? 409,
        obligations,
      }
    }
    return refusal(result.code ?? 'PACKAGE_SWITCH_FAILED', 400)
  }
  // Switched off: what is still open keeps the package winding down. Read
  // after the write, through the same client, so the answer and the menu
  // agree; a failed probe counts as open (obligations.ts).
  const openObligations = input.enabled
    ? []
    : await probePackageObligations(serviceClient, input.companyId, params.package_id as SwitchablePackageId)
  return {
    ok: true,
    data: {
      package_id: params.package_id,
      package_name: getPackage(params.package_id)?.nameSv ?? params.package_id,
      enabled: input.enabled,
      changed: result.unchanged !== true,
      capability_config_id: result.capability_config_id ?? null,
      decided_at: result.decided_at ?? null,
      winding_down: openObligations.length > 0,
      open_obligations: openObligations,
    },
  }
}
