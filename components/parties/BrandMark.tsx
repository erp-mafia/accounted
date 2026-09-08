'use client'

import { cn } from '@/lib/utils'

/**
 * A counterpart's mark: its initials on a tint derived from the name, so
 * the same counterpart always wears the same colour and no external logo
 * service sees which merchants a company pays. A logo domain, when known,
 * is kept on the row for a later self-hosted logo store.
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

export function BrandMark({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  const hue = hueFor(name)
  return (
    <span
      aria-hidden
      className={cn('inline-flex flex-none items-center justify-center rounded-full font-semibold tracking-tight', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 45% 90%)`,
        color: `hsl(${hue} 45% 28%)`,
      }}
    >
      {initialsFor(name)}
    </span>
  )
}
