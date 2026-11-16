import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/** The wiki demo renders dashboard components, so this subtree gets every namespace (as /sandbox/agenter does). */
export default function WikiSandboxLayout({ children }: { children: React.ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
