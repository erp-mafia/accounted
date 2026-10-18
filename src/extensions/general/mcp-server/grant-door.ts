/**
 * The grant door: after a staging tool staged an operation for a key, a
 * company grant that matches it exactly books it at once
 * (src/lib/grants/enforce.ts), and the tool's answer says so.
 *
 * Applied by the tools/call dispatcher around the tool, never inside it: a
 * staging tool still only stages (__tests__/staging-behaviour.test.ts), and
 * whether the staged row may go through without a person is the company's
 * rule, decided at the door for every staging tool a grant can cover. Today
 * that is gnubok_categorize_transaction (a bank line) and
 * gnubok_create_supplier_invoice_from_inbox (a known supplier's invoice),
 * directly or carried by gnubok_stage_tool. Never fails the call: the
 * staging already happened, and
 * any failure here answers the staged result unchanged, waiting for a person.
 * With GRANT_SUGGESTIONS off (the master switch) it does nothing at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCompanyGrant, type GrantCredential, type GrantOutcome } from '@/lib/grants/enforce'
import { grantsEnabled } from '@/lib/grants/flag'
import { SILENT_GRANT_REFUSALS } from '@/lib/grants/types'
import type { Logger } from '@/lib/logger'
import { toCanonicalToolName } from './tool-namespace'

/** The actor fields the door reads (server.ts ActorContext). */
export interface GrantDoorActor {
  type: string
  id?: string
  label?: string
  unattendedCommitLimit?: number | null
  oauthKey?: boolean
  serviceAccountId?: string | null
}

/** Staging tools whose operation a grant can cover. */
export const GRANTABLE_STAGING_TOOLS: ReadonlySet<string> = new Set([
  'gnubok_categorize_transaction',
  'gnubok_create_supplier_invoice_from_inbox',
])

/** Whether this call stages an operation a grant can cover. */
export function isGrantableCall(toolName: string, toolArgs: Record<string, unknown> | undefined): boolean {
  return grantableOperationType(toolName, toolArgs) !== undefined
}

/** The staged operation type a grantable call stages, or undefined for any other call. */
export function grantableOperationType(toolName: string, toolArgs: Record<string, unknown> | undefined): string | undefined {
  const inner = toolName === 'gnubok_stage_tool' && typeof toolArgs?.tool === 'string' ? toCanonicalToolName(toolArgs.tool) : toolName
  if (!GRANTABLE_STAGING_TOOLS.has(inner)) return undefined
  return inner === 'gnubok_create_supplier_invoice_from_inbox' ? 'create_supplier_invoice_from_inbox' : 'categorize_transaction'
}

/** What the agent is told when a rule for the counterparty exists but did not apply. */
const REFUSAL_NOTES: Record<string, string> = {
  batch_staged: 'staged inside a cross-company batch',
  credential_mismatch: 'this key did not stage it',
  paused: 'the company has paused all its rules',
  credential_revoked: 'the key or its service account is no longer active',
  credential_not_live: 'a test-mode key',
  credential_not_member: "the key's owner no longer writes in this company",
  allow_duplicate: 'allow_duplicate overrides the duplicate guard',
  vat_amount_override: 'a VAT amount that differs from the rate',
  dimensions: 'dimension tags the rule does not name',
  transaction_not_found: 'the bank line was not found',
  transaction_already_booked: 'the bank line is already booked or ignored',
  transaction_already_claimed: 'another booking of this bank line is in progress',
  pattern_unreadable: 'the preview could not be read exactly',
  period_locked: 'the period is closed or locked, or has no open fiscal year',
  pattern_mismatch: 'the accounts, VAT treatment or category differ from the rule',
  credential_not_allowed: 'the rule names another key or service account',
  above_limit: "the amount is above the rule's limit",
  above_unattended_limit: "the amount is above this key's own unattended ceiling",
  above_monthly_limit: "this month's postings under the rule would exceed its monthly limit",
  claim_failed: 'the rule could not be checked',
  // A supplier invoice from the inbox.
  register_booked: 'it registers an invoice whose verifikat already exists',
  unsupported_params: 'it carries a field the rule does not cover',
  foreign_currency: 'the invoice is not in SEK',
  special_payroll_tax: 'a line is flagged for särskild löneskatt',
  credit_note: 'the item is a credit note',
  negative_line: 'a line is below zero (a discount or a deduction such as ROT/RUT)',
  payment_details: 'the invoice states bank details the supplier card lacks or does not have',
  preview_warning: 'the staging warned about the amounts',
  underlag_missing: "the invoice's document is missing from the archive",
  inbox_item_not_found: 'the inbox item was not found',
  inbox_item_already_booked: 'the inbox item is already a supplier invoice',
  inbox_item_already_claimed: 'another booking of this inbox item is in progress',
  duplicate_invoice_number: "the supplier's invoice number is already registered",
  registration_not_booked: 'the company does not book supplier invoices when they are registered',
}

function commitActorType(actor: GrantDoorActor): GrantCredential['actorType'] {
  if (actor.serviceAccountId) return 'service_account'
  return actor.oauthKey === true ? 'mcp_oauth' : 'api_key'
}

/** Who a rule is for, as the agent is told: a bank line's counterparty, or a supplier. */
function ruleSubject(operationType: string | undefined): string {
  return operationType === 'create_supplier_invoice_from_inbox' ? 'supplier' : 'counterparty'
}

/** The staged answer, told what the grant did. */
export function withGrantOutcome(
  result: Record<string, unknown>,
  outcome: GrantOutcome,
  operationType?: string,
): Record<string, unknown> {
  if (!outcome.applied) {
    if (SILENT_GRANT_REFUSALS.has(outcome.reason) || outcome.reason === 'not_in_database') return result
    const note = REFUSAL_NOTES[outcome.reason] ?? outcome.reason
    return {
      ...result,
      grant: { applied: false, reason: outcome.reason, ...(outcome.detail ?? {}) },
      message: `${String(result.message ?? '')} A company rule for this ${ruleSubject(operationType)} did not apply (${note}), so it waits for approval as usual.`.trim(),
    }
  }
  const supplierInvoice = outcome.grant.operation_type === 'create_supplier_invoice_from_inbox'
  const grant = {
    grant_id: outcome.grant.grant_id,
    grant_version: outcome.grant.grant_version,
    amount_sek: outcome.grant.amount_sek,
  }
  if (outcome.committed) {
    const { approve: _approve, ...rest } = result
    return {
      ...rest,
      operation_status: 'committed',
      grant: {
        applied: true,
        status: 'committed',
        ...grant,
        journal_entry_id: outcome.journalEntryId,
        ...(outcome.patternVerified === false ? { pattern_verified: false } : {}),
      },
      message: supplierInvoice
        ? `Registered and booked without approval under the company's rule for this supplier (grant ${grant.grant_id}, version ${grant.grant_version}): ` +
          'nothing to approve. Tell the user it was booked under their rule; they review it afterwards in Att göra under "Bokfört enligt regel", where the invoice opens to correct or credit it.'
        : `Booked without approval under the company's rule for this counterparty (grant ${grant.grant_id}, version ${grant.grant_version}): ` +
          'nothing to approve. Tell the user it was booked under their rule; they review it afterwards in Att göra under "Bokfört enligt regel" and can undo it there.',
    }
  }
  const operationStatus = outcome.result.operation_status
  const base = operationStatus === 'pending' ? result : (({ approve: _approve, ...rest }) => rest)(result)
  return {
    ...base,
    ...(operationStatus ? { operation_status: operationStatus } : {}),
    grant: {
      applied: true,
      status: 'refused',
      ...grant,
      ...(outcome.result.code ? { error_code: outcome.result.code } : {}),
      ...(outcome.result.error ? { error: outcome.result.error } : {}),
    },
    message:
      operationStatus === 'pending'
        ? `${String(result.message ?? '')} A company rule matched, but the booking was refused (${outcome.result.code ?? 'commit failed'}), so it waits for approval.`.trim()
        : `A company rule matched, but the booking was refused (${outcome.result.code ?? 'commit failed'}: ${outcome.result.error ?? 'no detail'}); the staged operation is ${operationStatus ?? 'not committed'}.`,
  }
}

export async function applyGrantDoor(
  result: unknown,
  ctx: {
    toolName: string
    toolArgs: Record<string, unknown> | undefined
    supabase: SupabaseClient
    companyId: string
    userId: string
    actor: GrantDoorActor | undefined
    log: Logger
  },
): Promise<unknown> {
  // GRANT_SUGGESTIONS is the master switch: off, the claim is never asked
  // and grants that exist do not apply.
  if (!grantsEnabled()) return result
  if (!isGrantableCall(ctx.toolName, ctx.toolArgs)) return result
  const { actor } = ctx
  if (!actor || actor.type !== 'api_key' || !actor.id) return result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const staged = result as Record<string, unknown>
  if (staged.staged !== true || staged.dry_run === true || staged.idempotency_replay === true) return result
  if (typeof staged.operation_id !== 'string' || !staged.operation_id) return result
  try {
    const outcome = await applyCompanyGrant(ctx.supabase, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      operationId: staged.operation_id,
      credential: {
        actorType: commitActorType(actor),
        apiKeyId: actor.id,
        ...(actor.label ? { label: actor.label } : {}),
        unattendedCommitLimit: actor.unattendedCommitLimit ?? null,
      },
      log: ctx.log,
    })
    return withGrantOutcome(staged, outcome, grantableOperationType(ctx.toolName, ctx.toolArgs))
  } catch (err) {
    ctx.log.warn('grant door failed; the staged operation waits for approval', {
      operationId: staged.operation_id,
      error: err instanceof Error ? err.message : String(err),
    })
    return result
  }
}
