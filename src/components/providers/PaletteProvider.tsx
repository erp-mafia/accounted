'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  DEFAULT_PALETTE,
  PALETTE_STORAGE_KEY,
  PALETTE_VALUES,
  isPalette,
  type Palette,
} from '@/lib/theme/palettes'

const PALETTE_CHANGE_EVENT = 'accounted:palette-change'

interface PaletteContextValue {
  palette: Palette
  setPalette: (palette: Palette) => void
}

const PaletteContext = createContext<PaletteContextValue | null>(null)

const paletteInitScript = `
(function () {
  var palette = ${JSON.stringify(DEFAULT_PALETTE)};
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});
    if (${JSON.stringify(PALETTE_VALUES)}.indexOf(stored) !== -1) palette = stored;
  } catch (_) {}
  document.documentElement.dataset.palette = palette;
})();
`

function applyPalette(palette: Palette) {
  document.documentElement.dataset.palette = palette
}

function getPaletteSnapshot(): Palette {
  const palette = document.documentElement.dataset.palette
  return isPalette(palette) ? palette : DEFAULT_PALETTE
}

function subscribeToPalette(onStoreChange: () => void) {
  function handlePaletteChange() {
    onStoreChange()
  }

  function handleStorage(event: StorageEvent) {
    if (event.key !== PALETTE_STORAGE_KEY && event.key !== null) return
    const palette = isPalette(event.newValue) ? event.newValue : DEFAULT_PALETTE
    applyPalette(palette)
    onStoreChange()
  }

  window.addEventListener(PALETTE_CHANGE_EVENT, handlePaletteChange)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(PALETTE_CHANGE_EVENT, handlePaletteChange)
    window.removeEventListener('storage', handleStorage)
  }
}

export function PaletteProvider({
  children,
  nonce,
}: {
  children: ReactNode
  /** The request's CSP nonce (root layout): the no-flash script needs it. */
  nonce?: string
}) {
  const palette = useSyncExternalStore(
    subscribeToPalette,
    getPaletteSnapshot,
    () => DEFAULT_PALETTE,
  )

  const setPalette = useCallback((nextPalette: Palette) => {
    applyPalette(nextPalette)
    try {
      window.localStorage.setItem(PALETTE_STORAGE_KEY, nextPalette)
    } catch {
      // The active tab still keeps the selected palette when storage is blocked.
    }
    window.dispatchEvent(new Event(PALETTE_CHANGE_EVENT))
  }, [])

  const value = useMemo(() => ({ palette, setPalette }), [palette, setPalette])

  return (
    <>
      {/* The strict script-src only runs this inline script with the
          request's nonce. Server render only, as next-themes does: the
          browser hides the attribute once the script has run, and a client
          render stamping it back would expose the value in the DOM. */}
      <script
        suppressHydrationWarning
        nonce={typeof window === 'undefined' ? nonce : ''}
        dangerouslySetInnerHTML={{ __html: paletteInitScript }}
      />
      <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>
    </>
  )
}

export function usePalette() {
  const context = useContext(PaletteContext)
  if (!context) throw new Error('usePalette must be used within PaletteProvider')
  return context
}
