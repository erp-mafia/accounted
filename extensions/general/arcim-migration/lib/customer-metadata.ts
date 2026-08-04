export interface ExistingCustomerMetadata {
  contact_person: string | null
  invoice_email_cc_addresses: string[] | null
  invoice_email_bcc_addresses: string[] | null
}

/**
 * Keys restricted to the three metadata columns so callers can spell the
 * update payload as an object literal (absent keys stay undefined and are
 * dropped at serialization, leaving those columns untouched).
 */
export interface CustomerMetadataEnrichment {
  contact_person?: string
  invoice_email_cc_addresses?: string[]
  invoice_email_bcc_addresses?: string[]
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
): CustomerMetadataEnrichment | null {
  const changes: CustomerMetadataEnrichment = {}
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
    && cc.every((x): x is string => typeof x === 'string')
  ) {
    changes.invoice_email_cc_addresses = cc
  }
  if (
    existing.invoice_email_bcc_addresses === null
    && Array.isArray(bcc)
    && bcc.length > 0
    && bcc.every((x): x is string => typeof x === 'string')
  ) {
    changes.invoice_email_bcc_addresses = bcc
  }

  return Object.keys(changes).length > 0 ? changes : null
}
