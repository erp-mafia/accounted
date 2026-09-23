import { Suspense } from 'react'
import { BankingSettingsContent } from '@/components/settings/sections/BankingSettingsContent'

// BankingSettingsContent (and the extension panel it hosts) reads
// useSearchParams for the OAuth-callback ?select_accounts param; without a
// Suspense boundary that de-opts the whole route to client rendering.
export default function BankingSettingsPage() {
  return (
    <Suspense>
      <BankingSettingsContent />
    </Suspense>
  )
}
