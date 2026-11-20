import type { ReactNode } from 'react'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * The document signing pages (/signera/[token]) render SigningPage, which
 * reads the signing_page namespace: the root provider ships only the
 * public-page namespaces, so this layout hands it the full catalog, as the
 * payment signing pages under /betala do.
 */
export default function SigneraLayout({ children }: { children: ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
