/**
 * Vitest setup for the tests over the simulated company. The company must
 * already be built; a test against nothing would prove nothing.
 */
import { registerInitLoader } from '@/lib/initialized'
import { TOOL_PG_REST_URL } from '@/tests/tool-pg/client'
import { installSimNetwork } from './network'

registerInitLoader(() => import('@/lib/init').then((m) => m.ensureInitialized()))
installSimNetwork({ databaseUrl: TOOL_PG_REST_URL, bareRest: true })
