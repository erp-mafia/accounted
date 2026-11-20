'use client'

import { forwardRef } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthFormError } from '@/components/auth/AuthFormError'

/**
 * The six-digit code from an authenticator app, on the two-factor pages
 * (verify at sign-in, verify at enrolment): digits only, one-time-code
 * autofill, and a wrong code's error under the field while the typed code
 * stays in it.
 */
export const TotpCodeField = forwardRef<
  HTMLInputElement,
  {
    label: string
    value: string
    onChange: (code: string) => void
    error: string | null
    disabled?: boolean
  }
>(function TotpCodeField({ label, value, onChange, error, disabled }, ref) {
  return (
    <div className="space-y-2">
      <Label htmlFor="code">{label}</Label>
      <Input
        ref={ref}
        id="code"
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        placeholder="000000"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        required
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'code-error' : undefined}
        className="h-11 font-mono text-[15px] tracking-[0.3em]"
      />
      {error && (
        <div id="code-error">
          <AuthFormError message={error} />
        </div>
      )}
    </div>
  )
})
