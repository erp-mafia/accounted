import { Suspense } from 'react'
import { PaymentOrdersPage } from '@/components/payments/PaymentOrdersPage'

/**
 * Betalningar: bank payments by where they stand (approve, sign with BankID,
 * follow, cancel, resolve) and the way to the payment files. Took over the
 * Betalfiler menu entry in milestone 1 of the connections plan; the payment
 * files page keeps its URL. The page reads the query string (a return from a
 * bank that signs on its own page); the Suspense boundary keeps the rest of
 * the route server-rendered.
 */
export default function PaymentsPage() {
  return (
    <Suspense>
      <PaymentOrdersPage />
    </Suspense>
  )
}
