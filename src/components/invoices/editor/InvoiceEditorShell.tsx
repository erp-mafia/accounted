'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { cn } from '@/lib/utils'

export type EditorPane = 'form' | 'preview'

interface InvoiceEditorShellProps {
  /** Which pane shows at narrow widths (both show side by side when wide). */
  pane: EditorPane
  onPaneChange: (pane: EditorPane) => void
  /** The top bar; receives the narrow-width Formulär | Förhandsgranskning switch to place. */
  renderTopBar: (paneSwitch: ReactNode | null) => ReactNode
  /** The left column: the form. */
  form: ReactNode
  /** The right pane: the live preview. Null renders the form alone (självfaktura). */
  preview: ReactNode | null
}

/**
 * The one-screen invoice editor ("Ett fönster"): the form in a fixed 560 px
 * column on the left, the live preview filling the rest on the frame tone,
 * each pane scrolling on its own under one top bar. Rendered full-bleed
 * (MainContainer), so the panel is the frame of the whole thing.
 *
 * The split follows the panel's own width (a container query), not the
 * viewport's, so a docked assistant narrowing the panel switches it too.
 * Below 900 px of panel (about a 1150 px window) the two panes do not fit
 * side by side and a segmented "Formulär | Förhandsgranskning" switch in the
 * top bar shows one at a time instead of stacking them.
 */
export function InvoiceEditorShell({ pane, onPaneChange, renderTopBar, form, preview }: InvoiceEditorShellProps) {
  const t = useTranslations('invoice_editor_shell')

  const paneSwitch = preview ? (
    <SegmentedControl
      className="@min-[900px]:hidden"
      aria-label={t('pane_switch_aria')}
      value={pane}
      onChange={onPaneChange}
      options={[
        { value: 'form', label: t('pane_form') },
        { value: 'preview', label: t('pane_preview') },
      ]}
    />
  ) : null

  return (
    <div className="@container flex min-h-dvh flex-col md:h-full md:min-h-0">
      {renderTopBar(paneSwitch)}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'min-w-0 flex-1 px-4 pb-12 pt-6 md:overflow-y-auto md:px-6',
            preview && '@min-[900px]:w-[560px] @min-[900px]:flex-none @min-[900px]:border-r @min-[900px]:border-border',
            preview && pane === 'preview' && 'hidden @min-[900px]:block',
          )}
        >
          <div className={cn(!preview && 'max-w-[640px]')}>{form}</div>
        </div>
        {preview && (
          <div
            className={cn(
              'min-w-0 flex-1 flex-col bg-frame',
              pane === 'form' ? 'hidden @min-[900px]:flex' : 'flex',
            )}
          >
            {preview}
          </div>
        )}
      </div>
    </div>
  )
}
