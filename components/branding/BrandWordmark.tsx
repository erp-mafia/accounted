'use client'

import Image from 'next/image'
import { cn } from '@/lib/utils'
import { useBranding } from '@/lib/branding/brand-context'

interface BrandWordmarkProps {
  /**
   * Visual size. `'hero'` is for landing/auth/onboarding hero slots (~the
   * same vertical weight as the old 240px logo image). `'inline'` matches
   * the old 30px image used in top-left nav contexts.
   */
  size?: 'hero' | 'inline'
  /**
   * Force lowercase rendering. Defaults to true to match the existing
   * font-display + `.toLowerCase()` pattern used elsewhere in the app.
   */
  lowercase?: boolean
  className?: string
}

/**
 * Wordmark used in place of the legacy logo image on auth / onboarding /
 * sandbox / invite surfaces. On a branded host with an uploaded logo it
 * renders the logo image next to the brand's app name (WL-12 slice A3);
 * otherwise it renders exactly the text-only wordmark: the active brand's
 * `appName` in Hedvig Letters Serif at weight 700 (the display font is
 * single-weight on Google Fonts so 700 ends up synthetically bolded, but
 * that matches the requested aesthetic).
 */
export function BrandWordmark({
  size = 'hero',
  lowercase = true,
  className,
}: BrandWordmarkProps) {
  const branding = useBranding()
  const name = lowercase ? branding.appName.toLowerCase() : branding.appName

  if (branding.logoUrl) {
    return (
      <span
        className={cn(
          'inline-flex items-center',
          size === 'hero' ? 'flex-col gap-3' : 'flex-row gap-2',
          className,
        )}
      >
        <Image
          src={branding.logoUrl}
          alt=""
          width={size === 'hero' ? 160 : 88}
          height={size === 'hero' ? 48 : 22}
          className={cn('w-auto', size === 'hero' ? 'h-12' : 'h-[22px]')}
          priority={size === 'hero'}
        />
        <span
          className={cn(
            'font-display tracking-tight',
            size === 'hero' ? 'text-3xl md:text-4xl' : 'text-base',
          )}
          style={{ fontWeight: 700 }}
        >
          {name}
        </span>
      </span>
    )
  }

  return (
    <span
      className={cn(
        'font-display tracking-tight inline-block',
        size === 'hero' ? 'text-5xl md:text-6xl' : 'text-base',
        className,
      )}
      style={{ fontWeight: 700 }}
    >
      {name}
    </span>
  )
}
