import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

// A size utility (size-*, h-*, w-*, with or without variants such as md:)
// in the caller's className; without one the icon falls back to 24px.
const SIZED = /(^|\s)([\w-]+:)*(size|h|w)-/

// `inline` on the box itself, with plain variants such as md: and the
// important modifier (an arbitrary variant like [&_svg]: aims elsewhere).
// On a lucide svg (a replaced element) it kept its size; on this span box it
// makes h-*/w-* inert and the glyph's 100% resolves against the page, so it
// means inline-flex here: still in the text flow, still sized.
const INLINE = /^((?:[\w-]+:)*)(!?)inline(!?)$/

function boxDisplay(className: string | undefined): string | undefined {
  return className
    ?.split(/\s+/)
    .map((token) => token.replace(INLINE, '$1$2inline-flex$3'))
    .join(' ')
}

/** Optional paint overrides: Heroicons draw with a 1.5 stroke and no fill. */
export interface IconPaint {
  strokeWidth?: number
  fill?: string
}

/**
 * The props of an icon's box: the caller's className sizes and colors it,
 * exactly as it did on a lucide svg, and the glyph fills the box. A stroke
 * or fill override reaches the svg through a CSS variable, because the svg's
 * own attributes would win over anything set on the box.
 */
export function iconBoxProps(
  className: string | undefined,
  style: CSSProperties | undefined,
  { strokeWidth, fill }: IconPaint,
): { className: string; style: CSSProperties | undefined } {
  return {
    className: cn(
      'inline-flex shrink-0 [&_svg]:size-full',
      !SIZED.test(className ?? '') && 'size-6',
      strokeWidth !== undefined && '[&_svg]:[stroke-width:var(--icon-stroke)]',
      fill !== undefined && '[&_svg]:[fill:var(--icon-fill)]',
      boxDisplay(className),
    ),
    style:
      strokeWidth === undefined && fill === undefined
        ? style
        : ({ ...style, '--icon-stroke': strokeWidth, '--icon-fill': fill } as CSSProperties),
  }
}
