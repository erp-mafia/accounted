/**
 * The attest gate: which supplier invoices a payment must leave out because
 * the company's attest policy requires attest for them and it has not been
 * given (attest_required, batch-eligibility.ts), and whether the company
 * attests supplier invoices at all (the unattested warning). The payment file
 * (batch-service.ts) and the bank payment preparation (orders/prepare.ts)
 * both ask it before they pay.
 *
 * The policy is supplier invoices' own rule
 * (lib/supplier-invoices/attest-policy-read.ts) and payments sits below that
 * block, so this file is payments' side of the contract and imports nothing
 * at runtime: the gate itself is wired in
 * lib/composition/payment-attest-gate.ts, which both paths import statically.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'

export interface PaymentAttestGate {
  /** Stable, kebab-case. */
  readonly id: string
  /** The module that owns the rule the gate reads (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /**
   * The invoices among `invoiceIds` that payment must leave out; empty when
   * the policy asks for nothing. Throws when it cannot tell: payment must not
   * read "no attest needed" from a failed read.
   */
  blockedInvoiceIds(supabase: SupabaseClient, companyId: string, invoiceIds: readonly string[]): Promise<Set<string>>
  /**
   * True when the company has an attest step for supplier invoices at all.
   * False under kontantmetoden: no invoice there is ever attested, so payment
   * does not warn that one is not (unattested, batch-eligibility.ts). A
   * failed read answers true: the warning never blocks.
   */
  attestsSupplierInvoices(supabase: SupabaseClient, companyId: string): Promise<boolean>
}
