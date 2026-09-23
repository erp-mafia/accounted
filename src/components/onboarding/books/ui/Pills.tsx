'use client'

import type { ReactNode } from 'react'

/** A staggered row (or column) of pills; each fades in 45 ms after the previous. */
export function Pills({ column, className, children }: { column?: boolean; className?: string; children: ReactNode }) {
  return <div className={`pills${column ? ' is-col' : ''}${className ? ` ${className}` : ''}`}>{children}</div>
}

interface PillProps {
  index: number
  onClick?: () => void
  /** A logo on the white mark, or short text (initials) on it. */
  logo?: string
  mark?: string
  text?: boolean
  /** Toggle pill: shows the check mark and fills when on. */
  toggle?: boolean
  on?: boolean
  trailing?: ReactNode
  disabled?: boolean
  children: ReactNode
  ariaLabel?: string
}

export function Pill({ index, onClick, logo, mark, text, toggle, on, trailing, disabled, children, ariaLabel }: PillProps) {
  const cls = ['pill', text ? 'is-text' : '', toggle ? 'ypill' : '', on ? 'is-on' : ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={cls}
      style={{ animationDelay: `${index * 45}ms` }}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={toggle ? !!on : undefined}
      aria-label={ariaLabel}
    >
      {toggle ? (
        <span className="pmark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="12" height="12">
            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : logo ? (
        <span className="pmark" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt="" />
        </span>
      ) : mark ? (
        <span className="pmark" aria-hidden="true">{mark}</span>
      ) : null}
      {children}
      {trailing}
    </button>
  )
}

/** Two-letter mark for a bank without a logo: "Swedbank" -> "SW", "ICA Banken" -> "IB". */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}
