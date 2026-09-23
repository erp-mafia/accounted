'use client'

import type { CSSProperties, ReactNode } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { START_CARDS, type StartCardName } from './startkort-assets'

// The start card is a self-contained dark surface: like LedgerGraph it carries
// its own palette in both themes, because the strata image bakes its ground
// color into the pixels. Warm white type and a white primary pill sit on top.
// Gradients here are image scrims inside a hero surface, not card chrome
// (see DECISIONS.md 2026-08-13), and rounded-xl is the hero-surface allowance.
const TITLE_COLOR = '#FAF8F1'
const BODY_COLOR = 'rgba(247, 244, 236, 0.72)'
const EYEBROW_COLOR = 'rgba(247, 244, 236, 0.52)'

interface StartCardAction {
  label: string
  href?: string
  onClick?: () => void
}

interface StartCardProps {
  card: StartCardName
  /** 'side-right': image on the right half. 'bleed-left': full-bleed image,
   *  text over a scrim on the left. 'center': full-bleed, centered text. */
  layout: 'side-right' | 'bleed-left' | 'center'
  title: string
  body: string
  eyebrow?: string
  primary: StartCardAction
  secondary?: StartCardAction
  /** Floating channel badges over the right half (Underlag). */
  floatIcons?: boolean
  /** Tighter type for narrow containers (the inbox preview pane). */
  dense?: boolean
  onDismiss?: () => void
  dismissLabel?: string
  className?: string
}

function ActionButton({ action, kind }: { action: StartCardAction; kind: 'primary' | 'secondary' }) {
  const styles =
    kind === 'primary'
      ? 'bg-white text-[#1A1410] hover:bg-white/90 active:bg-white/90 focus-visible:ring-white/60 focus-visible:ring-offset-transparent'
      : 'border border-white/30 bg-transparent text-[#F7F4EC] hover:bg-white/10 active:bg-white/10 focus-visible:ring-white/60 focus-visible:ring-offset-transparent'
  if (action.href) {
    return (
      <Button asChild className={styles}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    )
  }
  return (
    <Button className={styles} onClick={action.onClick}>
      {action.label}
    </Button>
  )
}

// Channel badges for the Underlag card, Wispr-style: translucent circles over
// the image, one deliberately cropped by the card edge. Brand marks inline so
// the card stays self-contained (Gmail's M, WhatsApp's glyph).
const BADGE_STROKE = '#F4F1E8'

function badgeSvg(paths: string) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={BADGE_STROKE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  )
}

const FLOAT_BADGES: Array<{ style: CSSProperties; icon: ReactNode }> = [
  {
    style: { right: '34%', top: '8%', width: 38, height: 38 },
    icon: badgeSvg(
      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    ),
  },
  {
    style: { right: '6%', top: '14%', width: 46, height: 46 },
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7c1.657 0 3-1.343 3-3V16.2z" />
        <path fill="#1e88e5" d="M3 16.2l3.614 1.71L11 22.7V40H4c-1.657 0-3-1.343-3-3V16.2z" />
        <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
        <path
          fill="#c62828"
          d="M3 12.298V16.2l8 6.5V11.2L7.4 8.504A1.61 1.61 0 0 0 6.41 8.174C4.527 8.174 3 9.7 3 11.583v.715z"
        />
        <path
          fill="#fbc02d"
          d="M45 12.298V16.2l-8 6.5V11.2l3.6-2.696c.286-.214.633-.33.99-.33C43.473 8.174 45 9.7 45 11.583v.715z"
        />
      </svg>
    ),
  },
  {
    style: { right: '22%', top: '46%', width: 54, height: 54 },
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#25D366"
          d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"
        />
      </svg>
    ),
  },
  {
    style: { right: '5%', top: '64%', width: 42, height: 42 },
    icon: badgeSvg(
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    ),
  },
  {
    style: { right: '26%', bottom: '-8%', width: 50, height: 50 },
    icon: badgeSvg(
      '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    ),
  },
]

export function StartCard({
  card,
  layout,
  title,
  body,
  eyebrow,
  primary,
  secondary,
  floatIcons = false,
  dense = false,
  onDismiss,
  dismissLabel,
  className,
}: StartCardProps) {
  const asset = START_CARDS[card]
  const g = asset.groundRgb

  const scrim =
    layout === 'center'
      ? `radial-gradient(ellipse 90% 130% at 50% 55%, rgba(${g}, 0.7) 0%, rgba(${g}, 0.36) 55%, rgba(${g}, 0.06) 100%)`
      : `linear-gradient(90deg, rgba(${g}, 0.92) 0%, rgba(${g}, 0.55) 45%, rgba(${g}, 0.08) 75%)`

  return (
    <div
      className={cn('relative h-[216px] overflow-hidden rounded-xl', className)}
      style={{ backgroundColor: asset.ground }}
    >
      {layout === 'side-right' ? (
        <div className="absolute inset-y-0 right-0 w-1/2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.src}
            width={asset.w}
            height={asset.h}
            alt=""
            decoding="async"
            loading="lazy"
            className="h-full w-full object-cover"
            style={{ objectPosition: asset.objectPosition }}
          />
          <div
            className="absolute inset-0"
            style={{ background: `linear-gradient(90deg, ${asset.ground} 0%, rgba(${g}, 0) 42%)` }}
          />
        </div>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.src}
            width={asset.w}
            height={asset.h}
            alt=""
            decoding="async"
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: asset.objectPosition }}
          />
          <div className="absolute inset-0" style={{ background: scrim }} />
        </>
      )}

      {floatIcons &&
        FLOAT_BADGES.map((badge, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="absolute z-[2] flex items-center justify-center rounded-full border border-white/15 backdrop-blur-[3px] [&>svg]:h-[46%] [&>svg]:w-[46%]"
            style={{ ...badge.style, backgroundColor: 'rgba(30, 36, 52, 0.55)' }}
          >
            {badge.icon}
          </div>
        ))}

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="absolute right-4 top-3 z-[3] p-1 text-[#EBE5D3]/50 transition-colors duration-150 hover:text-[#EBE5D3]"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      <div
        className={cn(
          'relative z-[2] flex h-full flex-col justify-center',
          dense ? 'px-6 py-4' : 'px-7 py-5',
          layout === 'center'
            ? 'mx-auto max-w-[70%] items-center text-center'
            : floatIcons
              ? 'max-w-[66%] items-start'
              : 'max-w-[58%] items-start',
        )}
      >
        {eyebrow && (
          <div
            className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.12em]"
            style={{ color: EYEBROW_COLOR }}
          >
            {eyebrow}
          </div>
        )}
        <h2
          className={cn('font-display text-balance', dense ? 'text-[19px] leading-snug' : 'text-2xl leading-tight')}
          style={{ color: TITLE_COLOR }}
        >
          {title}
        </h2>
        <p className="mb-4 mt-2 text-[13px] leading-relaxed" style={{ color: BODY_COLOR }}>
          {body}
        </p>
        <div className={cn('flex flex-wrap gap-2', layout === 'center' && 'justify-center')}>
          <ActionButton action={primary} kind="primary" />
          {secondary && <ActionButton action={secondary} kind="secondary" />}
        </div>
      </div>
    </div>
  )
}
