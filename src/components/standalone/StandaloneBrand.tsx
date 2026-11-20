'use client'

import Image from 'next/image'
import { useBranding } from '@/lib/branding/brand-context'
import { DEFAULT_LOGO_PATH } from '@/lib/branding/service'
import { cn } from '@/lib/utils'

/**
 * The brand mark over a standalone page (sign-in, two-factor, invite, error):
 * the 24px mark with the app name beside it, in the same place on every page.
 * On a branded host with an uploaded logo the logo carries the brand alone,
 * the rule BrandHomeLink and BrandWordmark follow (byrå logos usually carry
 * their own name).
 */
export function StandaloneBrand({ className }: { className?: string }) {
  const { appName, logoUrl, logoPath } = useBranding()
  return (
    <div className={cn('flex h-6 items-center gap-2', className)}>
      {logoUrl ? (
        <Image
          src={logoUrl}
          alt={appName}
          width={96}
          height={24}
          className="h-6 w-auto max-w-[200px] object-contain object-left"
          // The optimizer's remote-host allowlist is fixed at build time
          // (issue #2203, as BrandHomeLink).
          unoptimized
        />
      ) : (
        <>
          <Image
            src={logoPath}
            alt=""
            width={24}
            height={24}
            className={cn('h-6 w-6 rounded-md', logoPath === DEFAULT_LOGO_PATH && 'dark:invert')}
          />
          <span className="text-[15px] font-semibold leading-[22px] text-strong">{appName}</span>
        </>
      )}
    </div>
  )
}
