'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

export interface Verdict {
  tone: 'ok' | 'warn' | 'info'
  text: string
  href?: string
}

/** The verdict lines: each draws its check (or dot) 260 ms after the previous. */
export function VerdictList({ verdicts, loading, base = 200, narrow }: { verdicts: Verdict[]; loading?: boolean; base?: number; narrow?: boolean }) {
  const cls = `bks-verdicts${narrow ? ' is-narrow' : ''}`
  if (loading) {
    return (
      <div className={cls} role="status">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return (
    <ul className={cls}>
      {verdicts.map((v, i) => (
        <VerdictLine key={v.text} verdict={v} delay={base + i * 260} />
      ))}
    </ul>
  )
}

export function VerdictLine({ verdict, delay }: { verdict: Verdict; delay: number }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const id = window.setTimeout(() => setOn(true), delay)
    return () => window.clearTimeout(id)
  }, [delay])
  const body = verdict.href ? (
    <a href={verdict.href} className="bks-vlink">{verdict.text}</a>
  ) : (
    <span>{verdict.text}</span>
  )
  return (
    <li className={`bks-v is-${verdict.tone}${on ? ' is-on' : ''}`}>
      <span className="bks-vmark" aria-hidden="true">
        {verdict.tone === 'ok' ? (
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="bks-vdot" />
        )}
      </span>
      {body}
    </li>
  )
}

/** Facts that ink in one after the other under a name (the file, the provider, the bank). */
export function Facts({ facts }: { facts: { text: string; warn?: boolean }[] }) {
  return (
    <div className="bks-facts" aria-live="polite">
      {facts.map((f, i) => (
        <span key={f.text} className={`bks-f${f.warn ? ' is-warn' : ''}`} style={{ animationDelay: `${i * 150}ms` }}>
          {i > 0 ? ' · ' : ''}
          {f.text}
        </span>
      ))}
    </div>
  )
}

export function Wait({ text, height }: { text: string; height?: number }) {
  return (
    <div className="bank-wait" role="status" style={height ? { height } : undefined}>
      <span className="spin" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}
