'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { InkText } from './ink'

/**
 * Question scaffold: serif inked title, optional sub line, optional "?"
 * help popover (Esc closes), optional one-line attention text (.jny-attn),
 * and the answer surface as children. One question on screen at a time.
 */
interface QuestionProps {
  title: string
  sub?: ReactNode
  info?: ReactNode
  attn?: ReactNode
  children?: ReactNode
}

export default function Question({ title, sub, info, attn, children }: QuestionProps) {
  const [infoOpen, setInfoOpen] = useState(false)
  const infoId = useId()

  // A new question closes the previous question's popover (render-time
  // derived-state reset, the lint-sanctioned pattern).
  const [lastTitle, setLastTitle] = useState(title)
  if (title !== lastTitle) {
    setLastTitle(title)
    setInfoOpen(false)
  }

  useEffect(() => {
    if (!infoOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInfoOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [infoOpen])

  return (
    <div className="jny-qstep" key={title}>
      <h1 className="jny-qtitle">
        <InkText text={title} />
      </h1>
      {(sub || info) && (
        <p className="jny-qsub">
          {sub}
          {info ? (
            <button
              type="button"
              className={`jny-qhelp${infoOpen ? ' is-on' : ''}`}
              aria-label="Mer information"
              aria-expanded={infoOpen}
              aria-controls={infoId}
              onClick={() => setInfoOpen((v) => !v)}
            >
              ?
            </button>
          ) : null}
        </p>
      )}
      {info && infoOpen ? (
        <p className="jny-qinfo" id={infoId}>
          {info}
        </p>
      ) : null}
      {attn ? <p className="jny-attn">{attn}</p> : null}
      {children}
    </div>
  )
}
