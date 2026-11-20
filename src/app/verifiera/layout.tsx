import type { ReactNode } from 'react'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * The public check of a signed file (/verifiera) renders VerifyPage, which
 * reads the verify_page namespace: the root provider ships only the
 * public-page namespaces, so this layout hands it the full catalog, as the
 * signing pages under /signera do.
 */
export default function VerifieraLayout({ children }: { children: ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
