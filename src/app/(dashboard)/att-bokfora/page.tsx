import { redirect } from 'next/navigation'
import { ToBookList } from '@/components/bookkeeping/ToBookList'
import { isBookingScreenEnabled } from '@/lib/env/booking-screen-switch'
import { isInkorgV2Enabled } from '@/lib/inkorg/flag'
import { getDashboardAuthContext, getDashboardCompanyId, redirectInvoicerOffPage } from '../request-context'

/**
 * /att-bokfora: one list of what waits to be booked (bank rows and the
 * documents Inkommande asks about), per company behind
 * BOOKING_SCREEN_COMPANY_IDS like the booking screen it opens. Outside the
 * rollout the address goes to Hem, where the queues it gathers are.
 */
export default async function ToBookRoute() {
  const [{ user }, companyId] = await Promise.all([getDashboardAuthContext(), getDashboardCompanyId(), redirectInvoicerOffPage()])
  if (!user) redirect('/login')
  if (!companyId || !isBookingScreenEnabled(companyId)) redirect('/')
  return <ToBookList inkorgV2Enabled={isInkorgV2Enabled(companyId)} />
}
