'use client'

import { forwardRef, useCallback, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * A single-line-looking textarea that grows with its content.
 *
 * Invoice line descriptions used to be `<input>`s, so a user could never put
 * a line break where they wanted one; the PDF then wrapped wherever the
 * column ran out. This keeps the dense one-row look of the editor grid while
 * letting Enter insert a newline, and re-measures on every render so a
 * prefilled multi-line description (edit flow) opens at the right height.
 */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function AutoGrowTextarea({ className, onInput, ...props }, ref) {
    const inner = useRef<HTMLTextAreaElement | null>(null)

    const setRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        inner.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      },
      [ref],
    )

    useLayoutEffect(() => {
      resize(inner.current)
    })

    return (
      <textarea
        {...props}
        ref={setRef}
        rows={1}
        onInput={(e) => {
          resize(e.currentTarget)
          onInput?.(e)
        }}
        className={cn('block resize-none overflow-hidden leading-5', className)}
      />
    )
  },
)

function resize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
