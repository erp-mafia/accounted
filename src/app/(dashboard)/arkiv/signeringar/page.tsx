import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getDashboardCompanyId } from '../../request-context'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { SigningRequestsList } from '@/components/signing/SigningRequestsList'

/**
 * /arkiv/signeringar: the company's BankID signing requests, newest first.
 * Reading them never depends on whether signing is open here (they are the
 * company's records once a signature exists); the actions that start or
 * chase a signing follow GET /api/signing/availability.
 */
export default async function SigningRequestsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivSectionEnabled(companyId)) notFound()
  const t = await getTranslations('signing')
  return (
    <div className="space-y-6">
      <PageHeader title={t('list_title')} help={<HelpPopover>{t('list_help')}</HelpPopover>} />
      <SigningRequestsList />
    </div>
  )
}
