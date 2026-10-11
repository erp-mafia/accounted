'use client'

import * as React from 'react'
import { Input, type InputProps } from '@/components/ui/input'
import { parseAmountExpression, formatAmountValue } from '@/lib/money-expression'

export interface AmountInputProps extends Omit<InputProps, 'type' | 'onChange' | 'value'> {
  /** Current field text. Controlled, exactly like the Input it replaces. */
  value: string
  /** Called with the field text, on every keystroke and again after evaluation. */
  onValueChange: (value: string) => void
}

/**
 * An amount field that accepts arithmetic: `1200+300`, `4500*0,25`, `12500/4`.
 *
 * The expression is evaluated when the field is left (blur, Enter or Tab), and
 * the result is written back into the field, so the number that will be booked
 * is on screen before anything is committed. Nothing is evaluated while typing:
 * a value that changes under the user's fingers mid-keystroke is worse than no
 * arithmetic at all.
 *
 * Deliberately `type="text"`, not `type="number"`. A native number input
 * discards anything non-numeric, so the browser would eat the `+` before this
 * component ever saw it. Going through text also fixes a separate long-standing
 * papercut: `type="number"` rejects the Swedish decimal comma on some browser
 * and locale combinations, and `parseFloat('1200,50')` silently reads 1200.
 * Here the comma is parsed and normalised on blur. `inputMode="decimal"` keeps
 * the numeric keypad on mobile.
 *
 * Unparseable text is left exactly as typed: no write-back, no coercion to
 * zero. The user sees what they wrote, and the form's own validation (which
 * still reads the field with parseFloat) refuses to submit it.
 */
const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(
  ({ value, onValueChange, onBlur, onKeyDown, ...props }, ref) => {
    const evaluate = React.useCallback(() => {
      const raw = value.trim()
      if (raw === '') return
      const result = parseAmountExpression(raw)
      // Negative results are never a valid amount: the side (debit or credit)
      // carries the sign in double-entry bookkeeping, so leave the text for the
      // user to fix rather than writing back a number the form would reject.
      if (result === null || result < 0) return
      const canonical = formatAmountValue(result)
      if (canonical !== value) onValueChange(canonical)
    }, [value, onValueChange])

    const handleBlur = React.useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        evaluate()
        onBlur?.(e)
      },
      [evaluate, onBlur],
    )

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        // Enter and Tab commit the field without necessarily firing blur first
        // (the surrounding forms move focus themselves on Enter), so evaluate
        // here too. Evaluation runs before the wrapped handler so focus has not
        // moved on yet.
        if (e.key === 'Enter' || e.key === 'Tab') evaluate()
        onKeyDown?.(e)
      },
      [evaluate, onKeyDown],
    )

    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        {...props}
      />
    )
  },
)
AmountInput.displayName = 'AmountInput'

export { AmountInput }
