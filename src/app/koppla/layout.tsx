import type { ReactNode } from 'react'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * The signatory pages (/koppla/[token]) render the Koppla banken flow's
 * client components, which read the bank_connect and koppla namespaces: the
 * root provider ships only the public-page namespaces, so this layout hands
 * them the full catalog, as the dashboard layout does.
 */
export default function KopplaLayout({ children }: { children: ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
