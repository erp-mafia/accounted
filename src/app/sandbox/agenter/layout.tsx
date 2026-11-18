import { notFound } from 'next/navigation'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'
import { demoPagesEnabled } from '@/lib/sandbox/demo-pages'

/**
 * The Agenter demo renders dashboard components (nav, assistant, skills
 * catalog) whose namespaces the root layout does not hand to client code
 * (src/i18n/root-client-namespaces.ts), so this subtree gets the full set.
 * A demo page: see demoPagesEnabled.
 */
export default function AgenterSandboxLayout({ children }: { children: React.ReactNode }) {
  if (!demoPagesEnabled()) notFound()
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
