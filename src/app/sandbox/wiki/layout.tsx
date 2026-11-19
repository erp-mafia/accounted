import { notFound } from 'next/navigation'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'
import { demoPagesEnabled } from '@/lib/sandbox/demo-pages'

/**
 * The wiki demo renders dashboard components, so this subtree gets every
 * namespace (as /sandbox/agenter does). A demo page: see demoPagesEnabled.
 */
export default function WikiSandboxLayout({ children }: { children: React.ReactNode }) {
  if (!demoPagesEnabled()) notFound()
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
