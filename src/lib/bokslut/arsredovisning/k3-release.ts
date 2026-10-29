import { flagEnabled } from '@/lib/env/public-flags'

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
