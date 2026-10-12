import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * The Agenter demo renders dashboard components (nav, assistant, skills
 * catalog) whose namespaces the root layout does not hand to client code
 * (src/i18n/root-client-namespaces.ts), so this subtree gets the full set.
 */
export default function AgenterSandboxLayout({ children }: { children: React.ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
