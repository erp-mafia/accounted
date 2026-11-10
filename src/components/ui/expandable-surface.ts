'use client'

import type { MouseEvent } from 'react'

const INTERACTIVE = 'object,iframe,video,audio,a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="combobox"],[role="menuitem"],[tabindex],[contenteditable]:not([contenteditable="false"]),[data-expandable-surface]'

/** Add a pointer shortcut to a surface that already contains a native disclosure button. */
export function expandableSurface<T extends HTMLElement = HTMLElement>(onToggle: (event: MouseEvent<T>) => void) {
  return {
    'data-expandable-surface': '',
    onClick(event: MouseEvent<T>) {
      if (event.defaultPrevented || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return
      const control = event.target.closest(INTERACTIVE)
      if (control && control !== event.currentTarget) return
      const selection = event.currentTarget.ownerDocument.getSelection()
      if (selection && !selection.isCollapsed && (
        event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode)
      )) return
      onToggle(event)
    },
  }
}
