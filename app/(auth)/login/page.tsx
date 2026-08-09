import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { AuthPageSkeleton } from '@/components/auth/AuthPageSkeleton'
import { LOGIN_METHOD_COOKIE, isLoginMethod } from '@/lib/auth/login-method'
import { LoginClient } from './login-client'

// Server component: reads the method-hint cookie so the panel opens in the
// state the user last logged in with, rendered correctly on the first paint.
// The Suspense wrapper is still required because the client component uses
// useSearchParams(), which forces dynamic rendering in Next.js 16.
export default async function LoginPage() {
  const cookieStore = await cookies()
  const stored = cookieStore.get(LOGIN_METHOD_COOKIE)?.value

  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <LoginClient initialMethod={isLoginMethod(stored) ? stored : null} />
    </Suspense>
  )
}
