import { notFound, redirect } from 'next/navigation'
import { BookingScreen } from '@/components/bookkeeping/BookingScreen'
import { isBookingScreenEnabled } from '@/lib/env/booking-screen-switch'
import { parseBookingScreenSubject } from '@/lib/bookkeeping/booking-screen'
import type { Transaction } from '@/types'
import { getDashboardAuthContext, getDashboardCompanyId, redirectInvoicerOffPage } from '../request-context'

/**
 * /bokfor: the booking screen, per company behind BOOKING_SCREEN_COMPANY_IDS.
 *
 * `?transaktion=<id>` books that bank row (`&konto=` prefills the counter
 * account), no query opens an empty verifikation. Outside the rollout the
 * address sends the person to the door it stands in for: the bank rows for a
 * row, the verifikat list's empty verifikat otherwise. The row is read with
 * the session's client and the active company, so a row of another company
 * is not found.
 */
export default async function BookingScreenRoute({
  searchParams,
}: {
  searchParams: Promise<{ transaktion?: string | string[]; konto?: string | string[] }>
}) {
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
    redirectInvoicerOffPage(),
  ])
  if (!user) redirect('/login')
  const subject = parseBookingScreenSubject(await searchParams)
  if (!companyId || !isBookingScreenEnabled(companyId)) {
    redirect(subject.kind === 'transaction' ? '/transactions' : '/bookkeeping?new')
  }
  if (subject.kind === 'voucher') return <BookingScreen transaction={null} account={null} />

  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', subject.transactionId)
    .maybeSingle()
  if (!data) notFound()
  return <BookingScreen transaction={data as Transaction} account={subject.account} />
}
