import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { SigningRequestsHome } from '@/components/signing/SigningRequestsHome'

/**
 * /arkiv/signeringar: the company's BankID signing requests, newest first,
 * under a top bar that uploads a PDF for signing where signing is open.
 * Reading them never depends on whether signing is open here (they are the
 * company's records once a signature exists); the actions that start or
 * chase a signing follow GET /api/signing/availability.
 */
export default async function SigningRequestsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivSectionEnabled(companyId)) notFound()
  return <SigningRequestsHome />
}
