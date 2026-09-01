'use client'

import { useState } from 'react'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { brandInitials } from '@/lib/brand/initials'

/**
 * The counterparty mark shown beside a merchant, supplier or customer name.
 *
 * Renders a resolved logo when one exists and an initials tile otherwise. The
 * tile is not a placeholder for a missing logo: it is the normal state. Most
 * bank descriptors will never resolve to a brand, so the tile has to look
 * finished on its own rather than like something still loading.
 *
 * Achromatic on purpose. The palette is an achromatic foundation where
 * semantic colour is data-only (.claude/rules/design.md), and
 * `components/ui/provider-marks.tsx` records that its Google/Microsoft marks
 * are "the only coloured glyphs in an otherwise achromatic interface". A
 * per-merchant colour hue would put colour into the chrome of the densest
 * surface in the app, so the tile stays `bg-secondary` / muted text.
 *
 * `next/image` is deliberately not used, for the same reason as
 * `components/agent/AgentAvatar.tsx`: these are tiny images, the optimizer
 * does not process SVG, and it would add a round trip through /_next/image
 * for nothing.
 */

const SIZES = {
  /** List rows. 20px keeps the one-line row height unchanged. */
  sm: { box: 'h-5 w-5', text: 'text-[9px]', icon: 'h-3 w-3' },
  /** Detail headers and pickers. */
  md: { box: 'h-8 w-8', text: 'text-[11px]', icon: 'h-4 w-4' },
} as const

interface BrandMarkProps {
  /** Name the mark stands for: merchant, supplier or customer. */
  label: string | null | undefined
  /**
   * Resolved logo. Absent for now on every surface: the server-side resolver
   * fills this in later without the call sites changing.
   */
  logoUrl?: string | null
  size?: keyof typeof SIZES
  className?: string
}

export function BrandMark({ label, logoUrl, size = 'sm', className }: BrandMarkProps) {
  const [logoFailed, setLogoFailed] = useState(false)
  const dim = SIZES[size]
  const initials = brandInitials(label)

  return (
    <span
      // Decorative: the name it stands for is always rendered next to it, so
      // announcing the initials again would just be noise in a screen reader.
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-muted-foreground',
        dim.box,
        className,
      )}
    >
      {initials ? (
        <span className={cn('font-medium leading-none', dim.text)}>{initials}</span>
      ) : (
        <Building2 className={dim.icon} />
      )}

      {/* Layered over the tile rather than swapped for it, so the cell is
          never empty and nothing reflows when the image arrives or 404s. */}
      {logoUrl && !logoFailed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setLogoFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  )
}

export default BrandMark
