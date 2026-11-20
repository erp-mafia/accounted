/**
 * The annual report page's way to a missing säte, client-safe: ask the
 * server to fetch it from the register (POST
 * /api/settings/registered-office/from-register) and read the report again
 * when the register had one. The report itself never guesses a säte: without
 * one, completeness refuses to finalise it (AR-COMPANY-REGISTERED-OFFICE).
 */
import type { RegisteredOfficeFill } from '@/lib/company/registered-office'

/**
 * Asks the server to fetch a missing säte from the register and store it.
 * Resolves the säte that was stored, or null when none was: the register had
 * none, the person may not change the company's settings, or the call
 * failed. Never rejects: a failed question leaves the report as it was read.
 */
export async function askRegisterForRegisteredOffice(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/api/settings/registered-office/from-register', { method: 'POST' })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: RegisteredOfficeFill }
    return body.data?.status === 'filled' ? body.data.registered_office : null
  } catch {
    // Safe to ignore: nothing was stored, so the report stands as it was
    // read, and its own blocker asks the person for the säte. A fault on the
    // server is logged there by the route.
    return null
  }
}

/** The report response as far as this module reads it. */
interface ReportBody {
  error?: unknown
  data?: { company?: { registered_office?: string | null } } | null
}

/**
 * Reads the report and, when it has no säte, asks the register before
 * anything is shown: when the register had one, the report is read again and
 * that reading is the answer. When it had none, the first reading stands and
 * its own blocker asks the person for the säte. A report that failed to load
 * is handed back as it is, with nothing asked.
 */
export async function loadReportWithRegisteredOffice<Body extends ReportBody>(options: {
  loadReport: () => Promise<Body>
  /** Resolves the säte the register filled in, or null. */
  askRegister: () => Promise<string | null>
}): Promise<Body> {
  const body = await options.loadReport()
  if (body?.error || !body?.data || body.data.company?.registered_office?.trim()) return body
  return (await options.askRegister()) ? options.loadReport() : body
}
