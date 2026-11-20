'use client'

import type { CSSProperties, ReactNode } from 'react'
import Link from 'next/link'
import { XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { START_CARDS, type StartCardName } from './startkort-assets'

// The start card is a self-contained dark surface: like LedgerGraph it carries
// its own palette in both themes, because the strata image bakes its ground
// color into the pixels. Warm white type and a white primary sit on top.
// Gradients here are image scrims inside a hero surface, not card chrome
// (see DECISIONS.md 2026-08-13).
const TITLE_COLOR = '#FAF8F1'
const BODY_COLOR = 'rgba(247, 244, 236, 0.72)'
const EYEBROW_COLOR = 'rgba(247, 244, 236, 0.52)'
const INK_COLOR = '#1A1410'
const CREAM_COLOR = '#F7F4EC'
// The focus ring sits on the image, so it is light, not the page's ring.
const ON_IMAGE_FOCUS = 'focus-visible:ring-white/60 focus-visible:ring-offset-transparent'

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
  /** A short kicker above the title ("Kom igång"). */
  eyebrow?: string
  primary: StartCardAction
  /** A second, quieter way in, drawn as a text link. */
  secondary?: StartCardAction
  /** Floating channel badges over the right half (Underlag). */
  floatIcons?: boolean
  /** Tighter type for narrow containers (the inbox preview pane). */
  dense?: boolean
  onDismiss?: () => void
  dismissLabel?: string
  className?: string
}

// The Stil v3 button shapes (6px, the toolbar height, a text link for the
// second way in) in the card's own colours: the primary is the light chip, as
// on the dark theme.
function ActionButton({ action, kind }: { action: StartCardAction; kind: 'primary' | 'secondary' }) {
  const props =
    kind === 'primary'
      ? {
          size: 'toolbar' as const,
          className: cn('bg-white hover:bg-white/90 active:bg-white/90', ON_IMAGE_FOCUS),
          style: { color: INK_COLOR },
        }
      : {
          variant: 'link' as const,
          className: cn('decoration-white/30 hover:decoration-white/70', ON_IMAGE_FOCUS),
          style: { color: CREAM_COLOR },
        }
  if (action.href) {
    return (
      <Button asChild {...props}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    )
  }
  return (
    <Button {...props} onClick={action.onClick}>
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

/**
 * The first-time state of a page that has nothing yet: the painted start card
 * (Bokföring, Kundfakturor, Löner, Skattekonto, Transaktioner, Underlag). Stil
 * v3 keeps the painting (product call 2026-11-02) and brings the rest to the
 * system: Inter titles (Hedvig is for numbers), a sentence-case eyebrow, the
 * 6px toolbar-height primary, a text link for the second way in and the 8px
 * radius of a single object. One sentence, one primary, at most one link, as
 * every v3 state. The ongoing empty, done and error states stay plain
 * (EmptyState, LoadError).
 */
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
  // Below sm the text column widens to 80% of the card, past the point where
  // the scrims above have faded out, so a phone-only layer holds the ground
  // under the whole column. WCAG AA for the body text: simulated over every
  // side-right and bleed-left card at 288-576px wide, the worst case is
  // 1.6:1 without this layer and 5.4:1 with it. The right edge stays clear.
  const phoneScrim =
    layout === 'center'
      ? null
      : `linear-gradient(90deg, rgba(${g}, 0.8) 0%, rgba(${g}, 0.8) 75%, rgba(${g}, 0) 100%)`

  return (
    <section
      data-ph-unmask=""
      className={cn('relative flex min-h-[216px] overflow-hidden rounded-lg', className)}
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

      {phoneScrim && <div className="absolute inset-0 sm:hidden" style={{ background: phoneScrim }} />}

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
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className={cn(
            'absolute right-3 top-3 z-[3] text-white/55 hover:bg-white/10 hover:text-white active:bg-white/10 active:text-white',
            ON_IMAGE_FOCUS,
          )}
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </Button>
      )}

      <div
        className={cn(
          'relative z-[2] flex flex-col justify-center',
          dense ? 'px-5 py-4' : 'px-6 py-5',
          layout === 'center'
            ? 'mx-auto max-w-[70%] items-center text-center'
            : floatIcons
              ? 'max-w-[80%] items-start sm:max-w-[66%]'
              : 'max-w-[80%] items-start sm:max-w-[58%]',
        )}
      >
        {eyebrow && (
          <div className="mb-1.5 text-xs font-medium" style={{ color: EYEBROW_COLOR }}>
            {eyebrow}
          </div>
        )}
        <h2 className={cn('text-balance', dense ? 'text-lg' : 'text-xl')} style={{ color: TITLE_COLOR }}>
          {title}
        </h2>
        <p className="mb-4 mt-1.5 text-pretty text-sm" style={{ color: BODY_COLOR }}>
          {body}
        </p>
        <div className={cn('flex flex-wrap items-center gap-4', layout === 'center' && 'justify-center')}>
          <ActionButton action={primary} kind="primary" />
          {secondary && <ActionButton action={secondary} kind="secondary" />}
        </div>
      </div>
    </section>
  )
}
