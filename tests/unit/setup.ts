import { vi } from 'vitest'

// lib/init wires the core event handlers (event_log, webhooks, supplier
// invoices) and loads every enabled extension. eventBus.emit() and the
// registry getters load it on first use (lib/initialized.ts); in a unit test
// that would put real handlers behind each test's own mocks. Stubbed for every
// unit test, so a test sees only what it registers itself. A test of the
// real wiring overrides this with its own vi.mock('@/lib/init', ...).
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
