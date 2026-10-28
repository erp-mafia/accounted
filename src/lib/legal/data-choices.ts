/**
 * A company's data choices (Inställningar → Datadelning och AI), founder
 * decisions of 2026-10-21. Stored as company_capability_config rows and
 * written only by set_company_data_choice (migration 20261021170000), so
 * every change has who decided, when, and a dated line in behandlingshistorik.
 *
 *   ai            AI processing (categorisation, document reading and
 *                 extraction, the assistant). On unless switched off. The key
 *                 is CAPABILITY.ai itself: switching it off is the ENABLEMENT
 *                 axis the paywall already reads.
 *   pooling       The company's anonymous patterns join the shared ones that
 *                 make suggestions better for everyone (the counterparty
 *                 directory, calibration samples). Covered by the terms: on
 *                 unless the company opts out.
 *   contribution  Real content (vouchers, documents) may be used to evaluate
 *                 and improve the service. Off unless the company opts in.
 *                 Nothing reads it yet.
 *
 * Pure data with no server imports: client code may read it.
 */

export const DATA_CHOICES = ['ai', 'pooling', 'contribution'] as const

export type DataChoice = (typeof DATA_CHOICES)[number]

/** The company_capability_config key each choice is stored under. */
export const DATA_CHOICE_CONFIG_KEYS: Record<DataChoice, string> = {
  ai: 'ai',
  pooling: 'data:pooling',
  contribution: 'data:contribution',
}

/** What a company with no row has chosen. */
export const DATA_CHOICE_DEFAULTS: Record<DataChoice, boolean> = {
  ai: true,
  pooling: true,
  contribution: false,
}

export type CompanyDataChoices = Record<DataChoice, boolean>
