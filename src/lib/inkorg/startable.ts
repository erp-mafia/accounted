/**
 * What the Inkorg's answers may start for one company (InkorgStartable,
 * ./decision.ts), from its resolved capabilities and two company facts,
 * plus the account a cost paid with the owner's own money is booked
 * against.
 *
 * A package counts as startable only while its availability is on: off and
 * winding_down are the package switched off, which the start gate
 * (lib/modules/package-gate.ts) refuses with PACKAGE_OFF; not_in_plan and
 * not_in_country count as not startable too (neither applies to these two
 * packages today: no module in them needs a plan capability, and the
 * country is Sweden). Without capabilities (the read failed) every package
 * counts as on, as the start gate lets a start through when its own read
 * fails. A company without a stored profile or a package switch resolves to
 * every package on, so it sees the Inkorg it always had.
 *
 * Pure: the page loads, this decides.
 */
import type { CompanyCapabilities } from '@/lib/modules/capabilities'
import type { PackageId } from '@/lib/modules/packages'
import { isEntityType, ownerSettlementAccount, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import type { InkorgStartable } from './decision'

export interface InkorgCompanyFacts {
  /** The stored legal form (company_settings.entity_type, else companies.entity_type); anything else is unknown. */
  entityType: unknown
  /** company_settings.accounting_method; null when unknown. */
  accountingMethod: string | null | undefined
}

export interface InkorgCompany {
  startable: InkorgStartable
  /**
   * The account a cost paid with the owner's own money is booked against
   * (an enskild firma: 2018 Egna insättningar), from the legal form's
   * profile. Null when the form has no such account (startable.soleTrader
   * is false then).
   */
  ownerAccount: string | null
}

function packageStartable(capabilities: Pick<CompanyCapabilities, 'packages'> | null, id: PackageId): boolean {
  if (!capabilities) return true
  const pkg = capabilities.packages.find((p) => p.id === id)
  return !pkg || pkg.availability === 'on'
}

export function inkorgCompany(
  capabilities: Pick<CompanyCapabilities, 'packages'> | null,
  facts: InkorgCompanyFacts,
): InkorgCompany {
  const form = isEntityType(facts.entityType) ? facts.entityType : null
  // A fysisk person (enskild firma): the owner's money and the firm's are one
  // person's, so a cost paid privately is an egen insättning, never a debt
  // to someone. Unknown form: never guessed.
  const soleTrader = form !== null && usesPersonnummerAsOrgNumber(form)
  return {
    startable: {
      supplierInvoices: packageStartable(capabilities, 'supplier-invoices-and-payments'),
      expenses: packageStartable(capabilities, 'expenses'),
      soleTrader,
      cashMethod: facts.accountingMethod === 'cash',
    },
    ownerAccount: form !== null && soleTrader ? ownerSettlementAccount(form, 'contribution') : null,
  }
}
