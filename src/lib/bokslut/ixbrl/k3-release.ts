/**
 * The release flag for the K3 iXBRL document: NEXT_PUBLIC_K3_IXBRL_ENABLED,
 * default off. Off, no K3 iXBRL input is built and no K3 document is
 * offered (resolveEntryPoint refuses K3, capabilities.ts keeps K3's
 * ixbrl_preview and connected_filing off). It is switched on only after
 * the independent review of the K3 document and Bolagsverket's test of K3
 * files, and it sits on top of the connected-filing release gate
 * (NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED), never instead of it.
 *
 * It also requires the K3 årsredovisning itself to be released
 * (NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED, arsredovisning/k3-release.ts):
 * the iXBRL document is the same årsredovisning in another format, so it
 * never exists while the K3 report is still a watermarked granskningsutkast.
 * Every K3 iXBRL gate reads this one function, so flipping only the iXBRL
 * flag opens nothing.
 *
 * Read at call time, as a value (lib/env/public-flags), so tests and the
 * Docker image's runtime substitution both see the configured value.
 */
import { flagEnabled } from '@/lib/env/public-flags'
import { k3ArsredovisningEnabled } from '@/lib/bokslut/arsredovisning/k3-release'

export function k3IxbrlEnabled(): boolean {
  return k3ArsredovisningEnabled() && flagEnabled(process.env.NEXT_PUBLIC_K3_IXBRL_ENABLED)
}
