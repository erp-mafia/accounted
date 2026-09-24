import type { CompanySettings, Invoice } from '@/types'

/**
 * Issuing an invoice requires a momsdeklaration box (moms_ruta), except when
 * the seller is not VAT-registered and the invoice is exempt.
 *
 * A seller exempt under ML (2023:200) 18 kap. (liten årsomsättning) is not
 * registered for VAT and files no momsdeklaration, so its sales have no ruta
 * at all. The create paths deliberately persist moms_ruta = null for them;
 * inventing ruta 42 would put a box on a declaration that is never filed.
 *
 * Every other null stays a defect: a VAT-registered seller always gets a ruta
 * from getVatRules() (05 / 39 / 40 ...), so a missing one means the row was
 * created outside the normal paths (legacy import, manual SQL) and its VAT
 * treatment is unverified. `vat_registered` must be explicitly false, matching
 * the `notVatRegistered` check on the create paths.
 */
export function hasRequiredMomsRuta(
  company: Pick<CompanySettings, 'vat_registered'>,
  invoice: Pick<Invoice, 'moms_ruta' | 'vat_treatment'>,
): boolean {
  if (invoice.moms_ruta) return true
  return company.vat_registered === false && invoice.vat_treatment === 'exempt'
}
