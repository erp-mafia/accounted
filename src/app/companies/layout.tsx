import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'

/**
 * /companies/new and /companies/new-client run the onboarding journey, which
 * reads most of the message catalog. The root layout hands client components
 * only the public and auth namespaces (src/i18n/root-client-namespaces.ts),
 * so this subtree gets the full set, like the (onboarding) layout.
 */
export default function CompaniesLayout({ children }: { children: React.ReactNode }) {
  return <AllMessagesProvider>{children}</AllMessagesProvider>
}
