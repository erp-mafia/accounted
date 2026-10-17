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

// The package start gate (lib/modules/package-gate.ts) reads the company's
// package switch on every start door (a new invoice, salary run, asset, ...).
// A unit test models a company with every package on, which is every company
// without a profile or a switch: the gate answers "on" without a read, so a
// route test's queued Supabase answers are not consumed by it. A test of the
// gate's own read uses vi.importActual; a test of a door's refusal sets
// vi.mocked(packageStartRefusal).mockResolvedValueOnce(...).
vi.mock('@/lib/modules/package-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modules/package-gate')>()
  return { ...actual, packageStartRefusal: vi.fn(async () => null) }
})
