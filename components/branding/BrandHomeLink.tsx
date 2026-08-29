'use client'

/**
 * Dashboard sidebar brand mark: the top-left home link (WL-12 slice A3).
 *
 * On a branded host with an uploaded logo it renders that logo; on every
 * other host it renders exactly the legacy `getBranding().logoPath` image
 * with the same dimensions, classes and aria-label as before, keeping
 * default hosts byte-identical.
 *
 * With `showLabel` (expanded sidebar) a branded host without an uploaded
 * logo renders the brand's app name beside the mark (byra-editable in the
 * Varumärke settings). With an uploaded logo the logo carries the brand
 * alone (same founder call as BrandWordmark, 2026-08-05: byrå logos usually
 * carry their own name, so logo + text read as a duplicate). Unbranded
 * hosts never show a label.
 */

import Link from 'next/link'
import Image from 'next/image'
import { useBranding } from '@/lib/branding/brand-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'

export function BrandHomeLink({ showLabel = false }: { showLabel?: boolean }) {
  const { appName, logoUrl, logoPath, brand } = useBranding()
  const label = brand && !logoUrl ? brand.appName : null
  // Byrå team members (any role) home to the cockpit, never to "/" (which
  // would open whatever client company happens to be active). Everyone
  // outside a byrå keeps the legacy home link.
  const byraTeam = useCompanyOptional()?.byraTeam
  const homeHref = byraTeam ? '/byra' : '/'
  return (
    <Link href={homeHref} aria-label={appName} className="flex items-center gap-2 rounded-lg">
      {logoUrl ? (
        <Image
          src={logoUrl}
          alt=""
          width={26}
          height={26}
          className="h-[26px] w-[26px] rounded-lg object-contain"
        />
      ) : (
        <Image
          src={logoPath}
          alt=""
          width={26}
          height={26}
          className="h-[26px] w-[26px] rounded-lg"
        />
      )}
      {showLabel && label && (
        <span
          className="truncate font-display text-base tracking-tight text-foreground"
          style={{ fontWeight: 700 }}
        >
          {label}
        </span>
      )}
    </Link>
  )
}
