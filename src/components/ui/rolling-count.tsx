'use client'

import { cn } from '@/lib/utils'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * A count that rolls its digits when it changes (the rolling counter, one of
 * the four named motions of Stil v3): each digit is a column of 0-9 that
 * slides to its value, so a queue going from 43 to 42 reads as movement, not
 * a swap. Tabular figures keep the width steady. Screen readers get the
 * plain number; reduced motion gets the new number at once.
 */
export function RollingCount({ value, className }: { value: number; className?: string }) {
  const text = String(Math.max(0, Math.round(value)))
  return (
    <span className={cn('inline-flex tabular-nums', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex">
        {text.split('').map((digit, i) => (
          // Keyed from the right so a digit column keeps its place when the
          // number gains or loses a digit on the left.
          <span key={text.length - i} className="roll-digit">
            <span style={{ transform: `translateY(-${Number(digit) * 1.15}em)` }}>
              {DIGITS.map((d) => (
                <span key={d} className="block h-[1.15em]">
                  {d}
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </span>
  )
}
