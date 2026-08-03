export interface ExistingCustomerMetadata {
  contact_person: string | null
  invoice_email_cc_addresses: string[] | null
  invoice_email_bcc_addresses: string[] | null
}

/**
 * Build a provider-migration enrichment without overwriting user choices.
 *
 * NULL is the only "never configured" value. Empty strings/arrays are explicit
 * clears, so a later migration rerun leaves them alone. The mapped row must
 * also contain real metadata: converting NULL to an empty value is not useful.
 */
export function buildCustomerMetadataEnrichment(
  existing: ExistingCustomerMetadata,
  mapped: Record<string, unknown>,
): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {}
  const contactPerson = mapped.contact_person
  const cc = mapped.invoice_email_cc_addresses
  const bcc = mapped.invoice_email_bcc_addresses

  if (
    existing.contact_person === null
    && typeof contactPerson === 'string'
    && contactPerson.trim().length > 0
  ) {
    changes.contact_person = contactPerson
  }
  if (
    existing.invoice_email_cc_addresses === null
    && Array.isArray(cc)
    && cc.length > 0
  ) {
    changes.invoice_email_cc_addresses = cc
  }
  if (
    existing.invoice_email_bcc_addresses === null
    && Array.isArray(bcc)
    && bcc.length > 0
  ) {
    changes.invoice_email_bcc_addresses = bcc
  }

  return Object.keys(changes).length > 0 ? changes : null
}
