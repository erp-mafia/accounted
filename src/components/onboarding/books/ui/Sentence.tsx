'use client'

import type { ReactNode } from 'react'

/**
 * The one-sentence summary with Ändra under it: what will happen, in
 * words, then one quiet row of tools (Ändra, and whatever the step adds),
 * and the rows that change it only when asked for.
 */
export function Sentence({
  children,
  open,
  onToggle,
  changeLabel,
  closeLabel,
  hasOptions = true,
  tools,
}: {
  children: ReactNode
  open: boolean
  onToggle: () => void
  changeLabel: string
  closeLabel: string
  hasOptions?: boolean
  /** Extra controls on the tools row, after Ändra. */
  tools?: ReactNode
}) {
  return (
    <div className="imp-sentence">
      <p className="imp-line">{children}</p>
      {hasOptions || tools ? (
        <p className="imp-tools">
          {hasOptions ? (
            <button type="button" className="imp-change" onClick={onToggle} aria-expanded={open}>
              {open ? closeLabel : changeLabel}
            </button>
          ) : null}
          {tools}
        </p>
      ) : null}
    </div>
  )
}

export function OptRows({ children }: { children: ReactNode }) {
  return <div className="opts">{children}</div>
}

export function OptRow({
  name,
  desc,
  off,
  locked,
  stacked,
  control,
}: {
  name: ReactNode
  desc?: ReactNode
  off?: boolean
  locked?: boolean
  /** The choices go on their own line under the label. */
  stacked?: boolean
  control: ReactNode
}) {
  return (
    <div className={`opt${locked ? ' is-locked' : off ? ' is-off' : ''}${stacked ? ' is-stacked' : ''}`}>
      <div className="l">
        {name}
        {desc ? <div className="d">{desc}</div> : null}
      </div>
      {control}
    </div>
  )
}

export function Switch({ on, onToggle, label, locked }: { on: boolean; onToggle: () => void; label: string; locked?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`sw${on ? ' is-on' : ''}`}
      onClick={locked ? undefined : onToggle}
      disabled={locked}
    />
  )
}
