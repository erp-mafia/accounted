'use client'

import { Reorder, useDragControls, useReducedMotion } from 'framer-motion'
import { GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'

interface SortableRowProps<T> {
  /** Identity used by Reorder to track this item across reorders. */
  value: T
  /** The row's existing markup: rendered untouched beside the drag handle. */
  children: ReactNode
  /** Localized aria-label for the drag handle. */
  handleLabel: string
  /** Disable dragging (e.g. a single-row list). */
  disabled?: boolean
  className?: string
}

/**
 * A drag-to-reorder row built on framer-motion's Reorder, with the grip handle
 * on the LEFT edge. The handle owns the drag (dragListener=false +
 * dragControls) so text inputs inside the row stay selectable. The handle is
 * vertically centered against the row so it reads correctly for both compact
 * text rows and tall product rows. Motion collapses to instant when the user
 * prefers reduced motion.
 *
 * Wrap the list in `<Reorder.Group as="div" axis="y" values={...} onReorder={...}>`
 * and render one SortableRow per item; the row's own markup goes in `children`,
 * so callers don't have to restructure existing JSX.
 */
export function SortableRow<T>({
  value,
  children,
  handleLabel,
  disabled = false,
  className,
}: SortableRowProps<T>) {
  const controls = useDragControls()
  const reduceMotion = useReducedMotion()

  return (
    <Reorder.Item
      value={value}
      as="div"
      dragListener={false}
      dragControls={controls}
      transition={reduceMotion ? { duration: 0 } : undefined}
      className={className}
    >
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          aria-label={handleLabel}
          disabled={disabled}
          onPointerDown={(e) => {
            if (disabled) return
            e.preventDefault()
            controls.start(e)
          }}
          className="flex shrink-0 touch-none cursor-grab items-center px-1 text-muted-foreground transition-colors duration-150 hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </Reorder.Item>
  )
}
