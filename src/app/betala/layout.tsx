import type { ReactNode } from 'react'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * The payment signing pages (/betala/[token]) render the BankID signing
 * flow's client components, which read the bank_payments and
 * payment_signing_page namespaces: the root provider ships only the
 * public-page namespaces, so this layout hands them the full catalog, as the
 * signatory pages under /koppla do.
 */
export default function BetalaLayout({ children }: { children: ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
