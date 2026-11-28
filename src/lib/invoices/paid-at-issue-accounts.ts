import type { SupabaseClient } from '@supabase/supabase-js'
import { isPaidAtIssueAccount } from '@/lib/invoices/paid-at-issue'
import { resolvePaymentAccount } from '@/lib/webshop-orders/booking-lines'
import type { WebshopOrder, WebshopPaymentMethodPolicy, WebshopStoreSettings } from '@/types'

/**
 * The company's side of the kontantfaktura account rule (crm#2324,
 * isPaidAtIssueAccount in paid-at-issue.ts): which payment-provider accounts
 * its webshop stores book to, and which account an invoice made from a
 * webshop order is paid to by default (crm#2323).
 */

type PaymentMethodAccountMap = Record<string, WebshopPaymentMethodPolicy> | null

/**
 * Every account one of the company's webshop stores books a payment method to
 * (webshop_store_settings.payment_method_account_map, mode 'book'): the
 * accounts a kontantfaktura may be paid to besides 19xx and 1686. Sorted,
 * once each. Throws when the read fails, so a door refuses instead of
 * guessing.
 */
export async function loadPaidAtIssueProviderAccounts(supabase: SupabaseClient, companyId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('webshop_store_settings')
    .select('payment_method_account_map')
    .eq('company_id', companyId)
  if (error) throw new Error(`webshop_store_settings read failed: ${error.message}`)
  const accounts = new Set<string>()
  for (const row of (data ?? []) as Array<{ payment_method_account_map: PaymentMethodAccountMap }>) {
    for (const policy of Object.values(row.payment_method_account_map ?? {})) {
      if (policy?.mode === 'book' && typeof policy.account === 'string') accounts.add(policy.account)
    }
  }
  return Array.from(accounts).sort()
}

/**
 * Null when a kontantfaktura may be paid to this account, else the refusal's
 * details (INVOICE_PAID_AT_ISSUE_ACCOUNT_NOT_ALLOWED). The stores are read
 * only for an account outside 19xx and 1686.
 */
export async function paidAtIssueAccountRefusal(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
): Promise<{ account_number: string; provider_accounts: string[] } | null> {
  if (isPaidAtIssueAccount(accountNumber)) return null
  const providerAccounts = await loadPaidAtIssueProviderAccounts(supabase, companyId)
  if (isPaidAtIssueAccount(accountNumber, providerAccounts)) return null
  return { account_number: accountNumber, provider_accounts: providerAccounts }
}

/**
 * The account a kontantfaktura for this invoice is paid to by default, when
 * the invoice was made from a paid webshop order (webshop_orders.invoice_id):
 * the account the order's store books its payment method to, the one Bokför
 * would debit for the same order (resolvePaymentAccount; 1686 when the
 * method has no mapping). Null when the invoice is not from an order, the
 * order is unpaid, or the store marks the method Faktureras (the customer
 * pays the invoice later, so it is no cash sale).
 */
export async function paidAtIssueOrderAccount(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<string | null> {
  const { data: order, error } = await supabase
    .from('webshop_orders')
    .select('platform, store_scope, payment_method, is_paid')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .eq('row_type', 'order')
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`webshop_orders read failed: ${error.message}`)
  const row = order as Pick<WebshopOrder, 'platform' | 'store_scope' | 'payment_method' | 'is_paid'> | null
  if (!row || !row.is_paid) return null

  const { data: settings, error: settingsError } = await supabase
    .from('webshop_store_settings')
    .select('payment_method_account_map')
    .eq('company_id', companyId)
    .eq('platform', row.platform)
    .eq('store_scope', row.store_scope)
    .maybeSingle()
  if (settingsError) throw new Error(`webshop_store_settings read failed: ${settingsError.message}`)

  const resolved = resolvePaymentAccount(row, settings as Pick<WebshopStoreSettings, 'payment_method_account_map'> | null)
  return resolved.invoiceMode ? null : resolved.account
}
