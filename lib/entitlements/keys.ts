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
] as const

/**
 * Paid MCP tools → required capability. The MCP/agent path is a paid chokepoint
 * just like the HTTP routes, so the dispatcher gates these the same way it gates
 * API-key scope (see mcp-server `tools/call`). External-service WRITE tools
 * appear here: send_invoice (email) and the two Skatteverket submissions. The
 * read/local SKV tools (generate_agi, vat_declaration_validate/status, agi_status)
 * stay free: the §4 carve-out forbids blocking a statutory filing obligation.
 *
 * gnubok_upload_document invokes AI (Bedrock document OCR via
 * extractInvoiceFields), so it is gated on CAPABILITY.ai: the same paywall the
 * HTTP inbox upload/attach/retry paths enforce. Without this entry a free-tier
 * API key (incl. the claude.ai connector's minted gnubok_sk_ key) could trigger
 * paid AI extraction. bank_sync has no MCP tool (bank sync is cron/HTTP only).
 */
export const MCP_TOOL_CAPABILITY_MAP: Readonly<Partial<Record<string, CapabilityKey>>> = {
  gnubok_send_invoice: CAPABILITY.email_send,
  gnubok_vat_declaration_submit: CAPABILITY.skatteverket,
  gnubok_agi_submit: CAPABILITY.skatteverket,
  // AI document OCR (Bedrock): the inbox's paid extraction, reachable via MCP.
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
