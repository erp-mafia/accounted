import { PaymentOrdersPage } from '@/components/payments/PaymentOrdersPage'

/**
 * Betalningar: bank payments by where they stand (approve, sign with BankID,
 * follow, cancel, resolve) and the way to the payment files. Took over the
 * Betalfiler menu entry in milestone 1 of the connections plan; the payment
 * files page keeps its URL.
 */
export default function PaymentsPage() {
  return <PaymentOrdersPage />
}
