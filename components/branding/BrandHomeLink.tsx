'use client'

/**
 * Dashboard sidebar brand mark: the top-left home link (WL-12 slice A3).
 *
 * On a branded host with an uploaded logo it renders that logo; on every
 * other host it renders exactly the legacy `getBranding().logoPath` image
 * with the same dimensions, classes and aria-label as before, keeping
 * default hosts byte-identical.
 *
 * With `showLabel` (expanded sidebar) a branded host also renders the
 * brand's app name beside the mark (byra-editable in the Varumärke
 * settings). Unbranded hosts never show a label.
 */

import Link from 'next/link'
import Image from 'next/image'
import { useBranding } from '@/lib/branding/brand-context'

export function BrandHomeLink({ showLabel = false }: { showLabel?: boolean }) {
  const { appName, logoUrl, logoPath, brand } = useBranding()
  const label = brand ? brand.appName : null
  return (
    <Link href="/" aria-label={appName} className="flex items-center gap-2 rounded-lg">
      {logoUrl ? (
        <Image
          src={logoUrl}
          alt=""
          width={26}
          height={26}
          className="h-[26px] w-[26px] rounded-md object-contain"
        />
      ) : (
        <Image
          src={logoPath}
          alt=""
          width={26}
          height={26}
          className="h-[26px] w-[26px] rounded-md"
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
