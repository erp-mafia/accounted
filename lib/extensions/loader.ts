import { extensionRegistry } from './registry'
import { FIRST_PARTY_EXTENSIONS } from './_generated/extension-list'

let loaded = false

/**
 * Load and register all configured extensions.
 * Idempotent: safe to call multiple times.
 *
 * Extensions are controlled by extensions.config.json.
 * Run `npm run setup:extensions` to regenerate after config changes.
 */
export function loadExtensions(): void {
  if (loaded) return
  loaded = true

  for (const extension of FIRST_PARTY_EXTENSIONS) {
    extensionRegistry.register(extension)
  }
}
