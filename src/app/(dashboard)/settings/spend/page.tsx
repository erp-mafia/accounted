import { Suspense } from 'react'
import { SpendSettingsContent } from '@/components/settings/sections/SpendSettingsContent'

// Reads useSearchParams for the connect return's ?spend_connected / ?spend_error
// params; the Suspense boundary keeps the rest of the route server-rendered.
export default function SpendSettingsPage() {
  return (
    <Suspense>
      <SpendSettingsContent />
    </Suspense>
  )
}
