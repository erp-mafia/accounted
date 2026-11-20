/** Opens the command palette. It listens for its key and has no open API, so a button sends the same key. */
export function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
}
