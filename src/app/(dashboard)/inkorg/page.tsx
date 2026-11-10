import { notFound, redirect } from 'next/navigation'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import { isInkorgV2Enabled, LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { inkorgCompany } from '@/lib/inkorg/startable'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { InkorgPage } from '@/components/inkorg/InkorgPage'
import { getDashboardAuthContext, getDashboardCompanyId, getDashboardSettings, redirectInvoicerOffPage } from '../request-context'

/**
 * /inkorg: the new Inkorg, per company behind INKORG_V2_COMPANY_IDS.
 *
 * Outside the rollout the inbox is still the Underlag workspace, so the
 * route sends the company there. The page needs the invoice-inbox extension
 * (it reads and acts through the extension's HTTP API): without it there is
 * no inbox to show. The workspace page owns the paywall and the sandbox lock
 * states, so a company that would see one of those is sent there too.
 *
 * What the company can start (lib/inkorg/startable.ts) is read once per page
 * load, never per item: the resolved capabilities in one parallel wave (no
 * obligation probe: off and winding down start nothing alike) and the
 * settings row the layout already read this request. A failed read counts
 * every package on, as the start gate does.
 */
export default async function InkorgRoute() {
  // An invoicer goes to the invoices before the capability reads below.
  const [{ supabase, user }, companyId] = await Promise.all([getDashboardAuthContext(), getDashboardCompanyId(), redirectInvoicerOffPage()])
  if (!user) redirect('/login')
  if (!companyId || !isInkorgV2Enabled(companyId)) redirect(LEGACY_INBOX_HREF)
  if (!getExtensionDefinition('general', 'invoice-inbox')) notFound()

  const [settings, capabilities] = await Promise.all([
    getDashboardSettings(),
    loadCompanyCapabilities(supabase, companyId, { obligations: false }).catch(() => null),
  ])
  const requiredCapability = requiredCapabilityForExtension('general', 'invoice-inbox')
  if (requiredCapability) {
    if (settings.data?.is_sandbox === true) redirect(LEGACY_INBOX_HREF)
    if (!(await hasCapability(supabase, companyId, requiredCapability))) redirect(LEGACY_INBOX_HREF)
  }

  // Never a guessed form: the settings row's, else the canonical companies row's.
  const entityType = await resolveCompanyEntityType(supabase, companyId, settings.data?.entity_type).catch(() => null)
  const { startable, ownerAccount } = inkorgCompany(capabilities, {
    entityType,
    accountingMethod: settings.data?.accounting_method ?? null,
  })

  return <InkorgPage startable={startable} ownerAccount={ownerAccount} />
}
