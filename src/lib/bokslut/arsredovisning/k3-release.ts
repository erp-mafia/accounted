import { flagEnabled } from '@/lib/env/public-flags'
import { hasK3ArsredovisningDocument, isEntityType } from '@/lib/company/entity-type'

/**
 * Whether a K3 årsredovisning for a mindre aktiebolag may be locked, signed
 * and filed on paper. Off by default: until an accountant has reviewed the
 * document (docs/review/k3-arsredovisning-mindre-ab.md) every K3 report is a
 * granskningsutkast (AR-K3-DRAFT-ONLY), watermarked, and the paper package
 * is not offered.
 *
 * On (NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED=true): the K3 document is checked
 * against the disclosure matrix and the K3 scope checks instead, and a report
 * that passes them can be locked, BankID-signed and filed on paper. Digital
 * filing of K3 is a separate gate (capabilities.ts).
 */
export function k3ArsredovisningEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED)
}

/**
 * Whether the K3 document is built for the form (the profile's
 * `filings.k3Document`): the aktiebolag today. Its equity specification,
 * förvaltningsberättelse and disclosure matrix follow ABL and the mindre
 * aktiebolag. An ekonomisk förening needs its own equity posts (ÅRL 3 kap.
 * 10 b §) and a bostadsrättsförening kapitel 38 (its key ratios, the kapitel
 * 38 disclosures and a kassaflödesanalys every year), none of which the
 * document carries yet. For any other form the K3 document stays a
 * granskningsutkast whatever the release flag says: it is never locked and
 * never offered on paper. An unknown form is never covered.
 */
export function k3DocumentCoversForm(entityType: string): boolean {
  return isEntityType(entityType) && hasK3ArsredovisningDocument(entityType)
}

/** The K3 document is released for this form: the release flag is on and the document covers the form. */
export function k3ArsredovisningReleasedFor(entityType: string): boolean {
  return k3ArsredovisningEnabled() && k3DocumentCoversForm(entityType)
}
