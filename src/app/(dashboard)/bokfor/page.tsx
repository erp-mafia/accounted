import { notFound, redirect } from 'next/navigation'
import { BookingScreen } from '@/components/bookkeeping/BookingScreen'
import { isBookingScreenEnabled } from '@/lib/env/booking-screen-switch'
import { parseBookingScreenBack, parseBookingScreenSubject } from '@/lib/bookkeeping/booking-screen'
import { readAvailableInboxDocs, type AvailableInboxDoc } from '@/lib/documents/inbox-available'
import type { Transaction } from '@/types'
import { getDashboardAuthContext, getDashboardCompanyId, redirectInvoicerOffPage } from '../request-context'

/**
 * /bokfor: the booking screen, per company behind BOOKING_SCREEN_COMPANY_IDS.
 *
 * `?transaktion=<id>` books that bank row (`&konto=` prefills the counter
 * account, `&underlag=` holds the inbox document found for it as its
 * underlag while that document is still free and the row has none of its
 * own), no query opens an empty verifikation; `&tillbaka=` names the
 * list to return to, with its filters (safeReturnPath). Outside the rollout the
 * address sends the person to the door it stands in for: the bank rows for a
 * row, the verifikat list's empty verifikat otherwise. The row is read with
 * the session's client and the active company, so a row of another company
 * is not found.
 */
export default async function BookingScreenRoute({
  searchParams,
}: {
  searchParams: Promise<{
    transaktion?: string | string[]
    konto?: string | string[]
    underlag?: string | string[]
    tillbaka?: string | string[]
  }>
}) {
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
    redirectInvoicerOffPage(),
  ])
  if (!user) redirect('/login')
  const query = await searchParams
  const subject = parseBookingScreenSubject(query)
  const back = parseBookingScreenBack(query)
  if (!companyId || !isBookingScreenEnabled(companyId)) {
    redirect(subject.kind === 'transaction' ? (back ?? '/transactions') : '/bookkeeping?new')
  }
  // One screen per row: stepping to the next row (same route, new query) must
  // start fresh, never keep the last row's filled-in lines or state.
  if (subject.kind === 'voucher') return <BookingScreen key="voucher" transaction={null} account={null} found={null} back={back} />

  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', subject.transactionId)
    .maybeSingle()
  if (!data) notFound()
  const transaction = data as Transaction
  // The found document is held, never pinned: only while it is still free
  // (no verifikat, no other bank row) and the row is open without underlag.
  // A read that fails is said on the screen, so the row is not booked
  // without the receipt by mistake; one taken meanwhile is simply not held.
  let found: AvailableInboxDoc | null = null
  let foundFailed = false
  if (subject.foundItemId && !transaction.journal_entry_id && !transaction.document_id) {
    const read = await readAvailableInboxDocs(supabase, companyId, { inboxItemId: subject.foundItemId })
    found = read.data?.[0] ?? null
    foundFailed = read.error !== null
  }
  return (
    <BookingScreen
      key={`${subject.transactionId}:${subject.account ?? ''}:${found?.inbox_item_id ?? ''}`}
      transaction={transaction}
      account={subject.account}
      found={found}
      foundFailed={foundFailed}
      back={back}
    />
  )
}
