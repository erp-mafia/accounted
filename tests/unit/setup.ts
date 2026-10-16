import { vi } from 'vitest'
import { registerInitLoader } from '@/lib/initialized'

// lib/init wires the core event handlers (event_log, webhooks, supplier
// invoices) and loads every enabled extension. Under Next.js
// instrumentation.ts registers the loader that eventBus.emit() and the
// registry getters wait for (lib/initialized.ts); here the setup registers the
// same loader, so a unit test behaves as the app does. lib/init itself is
// stubbed for every unit test, so a test sees only what it registers itself:
// putting the real handlers behind each test's own mocks would break them. A
// test of the real wiring overrides this with its own vi.mock('@/lib/init', ...).
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
registerInitLoader(() => import('@/lib/init').then((m) => m.ensureInitialized()))
