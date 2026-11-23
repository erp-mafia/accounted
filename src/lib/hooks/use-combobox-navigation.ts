'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

/**
 * Where an arrow key moves a combobox highlight among `count` options:
 * clamped at both ends, or wrapping around (`wrap`). A highlight of -1 means
 * none yet: ArrowDown lands on the first option, ArrowUp on the last when
 * wrapping and on the first otherwise.
 */
export function nextHighlight(prev: number, key: 'ArrowDown' | 'ArrowUp', count: number, wrap = false): number {
  if (count <= 0) return prev
  if (key === 'ArrowDown') {
    if (prev >= count - 1) return wrap ? 0 : count - 1
    return prev + 1
  }
  if (prev <= 0) return wrap ? count - 1 : 0
  return Math.min(prev - 1, count - 1)
}

const DEFAULT_OPEN_KEYS = ['ArrowDown', 'ArrowUp'] as const

export interface ComboboxNavigationOptions {
  /** Options in keyboard order. */
  count: number
  isOpen: boolean
  /** Opens a closed list; gets the key that asked for it. */
  open: (key: string) => void
  close: () => void
  /**
   * Enter on the highlighted option. The index may point at nothing (-1, or
   * past an emptied list): the caller checks. Return false to let the Enter
   * reach the form instead of being consumed.
   */
  activate: (index: number) => boolean | void
  /** The element holding the options: the one marked data-highlighted="true" is kept in view. */
  listRef: RefObject<HTMLElement | null>
  /** A pointer press outside all of these closes the list (the field, and a portaled panel). */
  insideRefs: ReadonlyArray<RefObject<HTMLElement | null>>
  /** Keys that open a closed list. Arrow keys by default. */
  openKeys?: readonly string[]
  /** Arrow past the last option goes to the first, and back. */
  wrap?: boolean
  /** The highlight before any navigation. */
  initialIndex?: number
  /** An arrow move inside the open list: the user's explicit choice. */
  onNavigate?: () => void
  /** Tab closes the list (focus is leaving the field). */
  closeOnTab?: boolean
}

/**
 * The keyboard and pointer behaviour every hand-rolled combobox shares: the
 * highlighted option, ArrowDown/ArrowUp, Enter, Escape (and optionally Tab),
 * keeping the highlighted option scrolled into view, and closing on a press
 * outside. Filtering, what an option is and what choosing one does stay with
 * the component; so do rules for keys the list does not own (a full account
 * number committed on Enter while the list is closed, say), which the
 * component handles before calling handleKeyDown.
 */
export function useComboboxNavigation({
  count,
  isOpen,
  open,
  close,
  activate,
  listRef,
  insideRefs,
  openKeys = DEFAULT_OPEN_KEYS,
  wrap = false,
  initialIndex = 0,
  onNavigate,
  closeOnTab = false,
}: ComboboxNavigationOptions) {
  const [highlightedIndex, setHighlightedIndex] = useState(initialIndex)
  // The highlight as last committed, read by resetHighlight.
  const committedHighlightRef = useRef(highlightedIndex)
  useLayoutEffect(() => {
    committedHighlightRef.current = highlightedIndex
  }, [highlightedIndex])

  /**
   * Puts the highlight on `index` unless it is there already: for the effect
   * that resets the highlight when the options change. That effect runs after
   * every keystroke in the field, and right after a render React does not
   * drop an update that changes nothing: it leaves one more render pending
   * behind the keystroke. React counts each commit that leaves one pending as
   * nested: keystrokes handled before that render ran added up, and past 50
   * the next keystroke threw "Maximum update depth exceeded" (React #185).
   */
  const resetHighlight = useCallback((index: number) => {
    if (committedHighlightRef.current !== index) setHighlightedIndex(index)
  }, [])

  useEffect(() => {
    if (!isOpen || !listRef.current) return
    listRef.current.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, isOpen, listRef])

  useEffect(() => {
    if (!isOpen) return
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node
      if (insideRefs.some((ref) => ref.current?.contains(target))) return
      close()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [isOpen, close, insideRefs])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) {
        if (openKeys.includes(e.key)) {
          e.preventDefault()
          open(e.key)
        }
        return
      }
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault()
          const key = e.key
          onNavigate?.()
          setHighlightedIndex((prev) => nextHighlight(prev, key, count, wrap))
          break
        }
        case 'Enter':
          if (activate(highlightedIndex) !== false) e.preventDefault()
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
        case 'Tab':
          if (closeOnTab) close()
          break
      }
    },
    [isOpen, openKeys, open, onNavigate, count, wrap, activate, highlightedIndex, close, closeOnTab],
  )

  return { highlightedIndex, setHighlightedIndex, resetHighlight, handleKeyDown }
}
