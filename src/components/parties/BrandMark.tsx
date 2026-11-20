'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { vendorLook, vendorLookFor, type VendorKey, type VendorLook } from '@/lib/vendor-marks'

/**
 * A counterpart's mark. By default its initials on a tint derived from the
 * name, so the same counterpart always wears the same colour. With
 * variant="mark" the most specific look wins, in this order:
 *   1. a built-in mark (lib/vendor-marks): the brand's mark on a white chip
 *      with a hairline border;
 *   2. the vendor's own icon, when the caller passes `logoUrl`: fetched once
 *      per domain by our server from the vendor's own website and served
 *      from our storage (lib/vendor-logos), on the same white chip; if it
 *      fails to load, the next look takes over;
 *   3. a built-in monogram: the vendor's initials in its own colours;
 *   4. the tinted initials.
 *
 * No logo service is ever called and the browser never contacts a vendor:
 * built-in marks ship inside the app, and a stored icon is a plain image
 * from our own bucket, named by content hash, not by domain.
 */
const HUES = [18, 42, 96, 152, 190, 214, 252, 288, 330]

function hueFor(name: string): number {
  let h = 0
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]!
}

export function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/** The chip every mark sits in: round, at the size asked for (22, 28 and 40 in the app). */
function Chip({ size, className, style, children }: { size: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex flex-none select-none items-center justify-center overflow-hidden rounded-full leading-none', className)}
      style={{ width: size, height: size, ...style }}
    >
      {children}
    </span>
  )
}

function VendorChip({ look, size, className }: { look: VendorLook; size: number; className?: string }) {
  if (look.kind === 'mark') {
    // 15px in a 28px chip, as in the prototype; the chip is white unless the mark is too faint on white.
    const glyph = Math.round(size * 0.54)
    return (
      <Chip size={size} className={cn(look.chip === '#FFFFFF' && 'border border-border', className)} style={{ background: look.chip }}>
        <svg viewBox="0 0 24 24" width={glyph} height={glyph} focusable="false">
          <path d={look.path} fill={look.fill} />
        </svg>
      </Chip>
    )
  }
  // Letters scale with the chip; three of them (K&C, AWS) a little smaller so they fit.
  const fontSize = Math.round(size * (look.initials.length >= 3 ? 0.3 : 0.38) * 2) / 2
  return (
    <Chip size={size} className={cn('font-semibold', className)} style={{ background: look.bg, color: look.fg, fontSize }}>
      {look.initials}
    </Chip>
  )
}

/**
 * The vendor's stored icon on the white chip. A URL that fails to load
 * (deleted, offline, blocked) shows what the chip would show without it.
 */
function StoredIconChip({ url, size, className, fallback }: { url: string; size: number; className?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <>{fallback}</>
  return (
    <Chip size={size} className={cn('border border-border', className)} style={{ background: '#FFFFFF' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a 128 px PNG from our own bucket; nothing for the optimiser to do */}
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </Chip>
  )
}

function InitialsChip({ name, size, className }: { name: string; size: number; className?: string }) {
  const hue = hueFor(name)
  return (
    <Chip
      size={size}
      className={cn('font-semibold tracking-tight', className)}
      style={{
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 45% 90%)`,
        color: `hsl(${hue} 45% 28%)`,
      }}
    >
      {initialsFor(name)}
    </Chip>
  )
}

export function BrandMark({
  name,
  size = 22,
  className,
  variant = 'initials',
  vendor,
  logoUrl,
}: {
  name: string
  size?: number
  className?: string
  /** initials (the default): the tinted initials. mark: a known vendor's own mark, icon or colours first. */
  variant?: 'initials' | 'mark'
  /** The vendor when the caller knows it (a door: Gmail, Peppol); otherwise it is read from the name. */
  vendor?: VendorKey | null
  /** The vendor's stored icon (lib/vendor-logos), used with variant="mark" when no built-in mark exists. */
  logoUrl?: string | null
}) {
  if (variant === 'mark') {
    const look = vendor ? vendorLook(vendor) : vendorLookFor(name)
    if (look?.kind === 'mark') return <VendorChip look={look} size={size} className={className} />
    const fallback = look ? (
      <VendorChip look={look} size={size} className={className} />
    ) : (
      <InitialsChip name={name} size={size} className={className} />
    )
    if (logoUrl) return <StoredIconChip key={logoUrl} url={logoUrl} size={size} className={className} fallback={fallback} />
    return fallback
  }
  return <InitialsChip name={name} size={size} className={className} />
}

/**
 * A door that is not a vendor (the intake address, an upload, the API): its
 * glyph on the quiet chip, at the same sizes as a mark.
 */
export function GlyphMark({ size = 22, className, children }: { size?: number; className?: string; children: ReactNode }) {
  return (
    <Chip size={size} className={cn('bg-secondary text-foreground', className)}>
      {children}
    </Chip>
  )
}
