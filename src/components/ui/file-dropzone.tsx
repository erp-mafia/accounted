'use client'

import { useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface FileDropzoneProps {
  /** The dropped or picked file. The caller decides whether it is one it takes. */
  onFile: (file: File) => void
  /**
   * The picker's accept attribute. Leave it out where Safari would grey out
   * valid files: it maps extensions to system types, and .sie/.se/.si have none.
   */
  accept?: string
  disabled?: boolean
  /** The zone's accessible name, e.g. "Välj SIE-fil". */
  label: string
  /** Tints the zone as refused while an error stands under it. */
  invalid?: boolean
  className?: string
  children: ReactNode
}

/**
 * The drop zone of an import step: drop a file on it, or click it, or focus
 * it and press Enter or Space, to pick one. The five import steps each wrote
 * this themselves and had drifted: two put the picker behind a label that a
 * keyboard could not reach, three opened it through a page-global element id,
 * and every one dropped the drag tint whenever the pointer crossed a child.
 */
export function FileDropzone({ onFile, accept, disabled = false, label, invalid = false, className, children }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const open = () => {
    if (!disabled) inputRef.current?.click()
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        'rounded-lg border-2 border-dashed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        dragging
          ? 'border-primary bg-primary/5'
          : invalid
            ? 'border-destructive bg-destructive/5'
            : 'border-muted-foreground/25 hover:border-primary/50',
        disabled ? 'pointer-events-none opacity-60' : 'cursor-pointer',
        className,
      )}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={(e) => {
        // Moving onto a child fires a leave on the zone; only leaving the
        // zone itself ends the drag.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file && !disabled) onFile(file)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        tabIndex={-1}
        disabled={disabled}
        // The programmatic click bubbles; without this it would reach the
        // zone's own onClick and ask for the picker a second time.
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the same file again (after a refusal) fires.
          e.target.value = ''
          if (file) onFile(file)
        }}
      />
      {children}
    </div>
  )
}
