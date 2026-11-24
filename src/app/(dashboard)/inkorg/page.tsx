import { notFound, redirect } from 'next/navigation'
import { LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { companyInboxReads, whyNotNewInbox } from '@/lib/inkorg/inbox-page'
import { inkorgCompany } from '@/lib/inkorg/startable'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { InkorgPage } from '@/components/inkorg/InkorgPage'
import { getDashboardAuthContext, getDashboardCompanyId, getDashboardSettings, redirectInvoicerOffPage } from '../request-context'

/**
 * /inkorg: the new Inkorg, per company behind INKORG_V2_COMPANY_IDS.
 *
 * The page renders for a company whose inbox is the new page
 * (lib/inkorg/inbox-page.ts), the one rule the workspace's route asks too.
 * For every other company the inbox is still the Underlag workspace, so the
 * route sends the company there: outside the rollout, and where the
 * workspace page would show the paywall or the sandbox lock, which it owns.
 * The page needs the invoice-inbox extension (it reads and acts through the
 * extension's HTTP API): without it there is no inbox to show.
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

  const reads = companyInboxReads(supabase, companyId, async () => (await getDashboardSettings()).data?.is_sandbox === true)
  // The capabilities are read beside the answer, and only where the answer
  // can still be the new page: outside the rollout the route reads nothing.
  const [why, capabilities] = await Promise.all([
    whyNotNewInbox(reads),
    companyId && reads.inRollout && reads.extensionExists
      ? loadCompanyCapabilities(supabase, companyId, { obligations: false }).catch(() => null)
      : null,
  ])
  if (why === 'no_extension') notFound()
  if (why !== null || !companyId) redirect(LEGACY_INBOX_HREF)

  const settings = await getDashboardSettings()
  // Never a guessed form: the settings row's, else the canonical companies row's.
  const entityType = await resolveCompanyEntityType(supabase, companyId, settings.data?.entity_type).catch(() => null)
  const { startable, ownerAccount } = inkorgCompany(capabilities, {
    entityType,
    accountingMethod: settings.data?.accounting_method ?? null,
  })

  return <InkorgPage startable={startable} ownerAccount={ownerAccount} />
}
