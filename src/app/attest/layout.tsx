import type { ReactNode } from 'react'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * The attest link pages (/attest/[token]) render a client component that
 * reads the attest_link_page namespace: the root provider ships only the
 * public-page namespaces, so this layout hands them the full catalog, as the
 * signing pages under /betala do.
 */
export default function AttestLayout({ children }: { children: ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
