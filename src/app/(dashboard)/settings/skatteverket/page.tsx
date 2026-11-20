import { Suspense } from 'react'
import { SkatteverketSettingsContent } from '@/components/settings/sections/SkatteverketSettingsContent'

// Reads useSearchParams for the OAuth-callback ?skv_connected / ?skv_error
// params; the Suspense boundary keeps the rest of the route server-rendered.
export default function SkatteverketSettingsPage() {
  return (
    <Suspense>
      <SkatteverketSettingsContent />
    </Suspense>
  )
}
