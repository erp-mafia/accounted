import { Suspense } from 'react'
import { AuthPageSkeleton } from '@/components/auth/AuthPageSkeleton'
import { fetchAuthSettings, type GoTrueAuthSettings } from '@/lib/auth/gotrue-providers'
import { RegisterClient } from './register-client'

export default async function RegisterPage() {
  const authSettings: GoTrueAuthSettings = await fetchAuthSettings()

  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <RegisterClient authSettings={authSettings} />
    </Suspense>
  )
}
