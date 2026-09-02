/**
 * Capability keys: the single namespace behind the SaaS paywall AND the
 * per-tenant modularity / marketplace vision. Each key names one gateable
 * feature; a company "has" it when an unexpired capability_grant exists
 * (entitlement) and it isn't explicitly disabled (enablement).
 *
 * These keys are a STABLE CONTRACT: grant rows, the future marketplace catalog,
 * and per-tenant module toggles all reference them. Add keys; never rename one.
 */
export const CAPABILITY = {
  /** AI assistant chat, onboarding composer, and document field extraction (Anthropic/Bedrock). */
  ai: 'ai',
  /** Bank sync / PSD2 (Enable Banking). Freeze-and-retain: tokens are NOT revoked on downgrade. */
  bank_sync: 'bank_sync',
  /** Skatteverket filing/sync (VAT, AGI, skattekonto) via BankID. */
  skatteverket: 'skatteverket',
  /** Outbound transactional email: invoices, reminders, payslips (Resend). Auth/account email is never gated. */
  email_send: 'email_send',
  /** Org-number lookup / enrichment (TIC). NOT gated: identity/lookup is always free. */
  org_lookup: 'org_lookup',
  /** EU VAT-number validation (VIES). NOT gated: identity/lookup is always free. */
  vat_validation: 'vat_validation',
  /** Riksbanken FX auto-fetch. NOT gated at launch (kept free); manual rate entry is always allowed. */
  currency_rates: 'currency_rates',
  /** Cloud backup to Google Drive. NOT gated at launch (kept free: never hold a customer's data hostage). */
  cloud_backup: 'cloud_backup',
  /** Migration import from other systems (Fortnox/Visma/Bokio/BL/Briox). Kept open so new payers can migrate IN. */
  migration: 'migration',
  /** Bolagsverket iXBRL årsredovisning filing. Reserved (extension not yet enabled). */
  bolagsverket: 'bolagsverket',
  /** Stripe Connect: auto payment links on invoices + payment/payout sync. */
  stripe_payments: 'stripe_payments',
  /** WooCommerce store sync: orders/refunds imported as a transaction feed. */
  woocommerce_sync: 'woocommerce_sync',
  /** Shopify store sync: orders/refunds imported as a transaction feed. */
  shopify_sync: 'shopify_sync',
  /**
   * Multiple people working in one company. Without it only the OWNER can
   * enter the company: every other membership goes dormant (never deleted)
   * after a 20-day post-lapse grace window, and new invites are blocked.
   * See lib/entitlements/multi-user.ts for the derived entitled/grace/frozen
   * state; company_capability_config does NOT apply to this key (it gates
   * member access, not a feature surface).
   */
  multi_user: 'multi_user',
  /**
   * Invoice email from the company's own verified sending domain (Resend
   * domain per company). Opt-in: granted manually per company, NOT part of
   * PAID_CAPABILITIES, so it is never trial-seeded or written by the Stripe
   * subscription sync. Without the grant the settings section is hidden and
   * mail keeps leaving from the platform sender.
   */
  custom_sender_domain: 'custom_sender_domain',
} as const

export type CapabilityKey = (typeof CAPABILITY)[keyof typeof CAPABILITY]

/**
 * The set actually withheld from non-payers (manual tier) at the 2026-07-07
 * cutover. Founder decision (2026-06-28): gate the high-value recurring external
 * services only.
 *
 * KEPT FREE on purpose:
 *   - identity & lookup: TIC org_lookup, VIES vat_validation, BankID login:
 *     they aid onboarding/data quality; gating them is friction in the wrong place.
 *   - currency_rates (FX auto-fetch) and cloud_backup.
 * Internal bookkeeping is always fully usable on the manual tier.
 *
 * NOTE: bank_sync and skatteverket stay PAID even though their flows use BankID
 * as an auth step: what's charged for is the bank data sync and the VAT/AGI
 * filing service, not the identity check.
 */
export const PAID_CAPABILITIES: readonly CapabilityKey[] = [
  CAPABILITY.ai,
  CAPABILITY.bank_sync,
  CAPABILITY.skatteverket,
  CAPABILITY.email_send,
  CAPABILITY.stripe_payments,
  CAPABILITY.woocommerce_sync,
  CAPABILITY.shopify_sync,
  // Founder decision (2026-09-01): multiple users per company is paid.
  // Trial-seeded and Stripe-synced like the rest; enforcement is the
  // owner-only dormancy rule in lib/entitlements/multi-user.ts.
  CAPABILITY.multi_user,
] as const

/**
 * Capabilities that a SELF-HOSTED instance cannot provide on its own because
 * they run on services Accounted operates (the PSD2/AISP bank connection,
 * the Skatteverket API client, the TIC lookup contract, the migration
 * gateway). On hosted these follow the normal paywall (bank_sync and
 * skatteverket are in PAID_CAPABILITIES; org_lookup and migration are free).
 * On a self-host every other capability is always on, and exactly these fall
 * through to the grant lookup: the hourly connector sync writes
 * `source = 'connector'` grants for them from the instance's connector key
 * (lib/connect/instance, arriving with the connector-keys stack PR #1748).
 * A self-host serving an upstream from its OWN credentials holds that
 * capability outright (see own-credentials.ts): only keyless-and-credential-
 * less connector capabilities are withheld. Deliberately NOT part of
 * PAID_CAPABILITIES and NOT seeded by the trial trigger: hosted companies
 * never receive connector grants.
 */
export const CONNECTOR_CAPABILITIES: readonly CapabilityKey[] = [
  CAPABILITY.bank_sync,
  CAPABILITY.skatteverket,
  CAPABILITY.org_lookup,
  CAPABILITY.migration,
] as const

export function isConnectorCapability(key: CapabilityKey): boolean {
  return (CONNECTOR_CAPABILITIES as readonly string[]).includes(key)
}

/**
 * Paid MCP tools → required capability. The MCP/agent path is a paid chokepoint
 * just like the HTTP routes, so the dispatcher gates these the same way it gates
 * API-key scope (see mcp-server `tools/call`). External-service WRITE tools
 * appear here: send_invoice (email) and the two Skatteverket submissions. The
 * read/local SKV tools (generate_agi, vat_declaration_validate/status, agi_status)
 * stay free: the §4 carve-out forbids blocking a statutory filing obligation.
 *
 * The document upload tools invoke AI (Bedrock document OCR via
 * extractInvoiceFields), so they are gated on CAPABILITY.ai: the same paywall
 * the HTTP inbox upload/attach/retry paths enforce. Without these entries a
 * free-tier API key could trigger paid AI extraction. bank_sync gates
 * gnubok_connect_bank (the onboarding connect link) and gnubok_sync_bank
 * (the agent-triggered PSD2 sync, a paid Enable Banking call per account).
 */
export const MCP_TOOL_CAPABILITY_MAP: Readonly<Partial<Record<string, CapabilityKey>>> = {
  gnubok_send_invoice: CAPABILITY.email_send,
  gnubok_vat_declaration_submit: CAPABILITY.skatteverket,
  gnubok_agi_submit: CAPABILITY.skatteverket,
  // Onboarding connect-link tools (issue #1814): gated like the links' targets.
  gnubok_connect_bank: CAPABILITY.bank_sync,
  // Agent-triggered PSD2 sync: a paid Enable Banking call per account.
  gnubok_sync_bank: CAPABILITY.bank_sync,
  gnubok_connect_skatteverket: CAPABILITY.skatteverket,
  // AI document OCR (Bedrock): the inbox's paid extraction, reachable via MCP.
  gnubok_create_document_upload: CAPABILITY.ai,
  gnubok_complete_document_upload: CAPABILITY.ai,
  gnubok_upload_document: CAPABILITY.ai,
} as const

/**
 * Paid pending-operation types → required capability. Keyed by
 * `pending_operations.operation_type`. This is the commit-time twin of
 * MCP_TOOL_CAPABILITY_MAP: it gates the actual external-service call inside
 * commitPendingOperation, so an operation staged during the trial cannot be
 * committed once the grant has expired, regardless of caller (MCP approve tool
 * or the UI approval path). Keep the values in sync with MCP_TOOL_CAPABILITY_MAP.
 */
export const PAID_OPERATION_CAPABILITY_MAP: Readonly<Partial<Record<string, CapabilityKey>>> = {
  send_invoice: CAPABILITY.email_send,
  submit_vat_declaration: CAPABILITY.skatteverket,
  submit_agi: CAPABILITY.skatteverket,
} as const

/**
 * Extension workspace → required capability, keyed by `sector/slug`. This is the
 * page/nav twin of the API-route gates: an extension whose entire value is a
 * paid service should not just 403 its writes but be hidden from the sidebar and
 * blocked at the page so a non-payer never lands on a dead workspace.
 *
 * invoice-inbox is fully gated on `ai`: its reason to exist is the AI field
 * extraction (extractInvoiceFields / gnubok_upload_document), already the paid
 * chokepoint on every other surface (HTTP upload/attach/retry, the MCP tool).
 * Both the sidebar item and the /e/[sector]/[slug] page read this map so the two
 * surfaces can never drift apart.
 */
export const EXTENSION_REQUIRED_CAPABILITY: Readonly<Partial<Record<string, CapabilityKey>>> = {
  'general/invoice-inbox': CAPABILITY.ai,
} as const

/** Which paid capability (if any) an extension workspace requires to be usable. */
export function requiredCapabilityForExtension(
  sector: string,
  slug: string,
): CapabilityKey | undefined {
  return EXTENSION_REQUIRED_CAPABILITY[`${sector}/${slug}`]
}
