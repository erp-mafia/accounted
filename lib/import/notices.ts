/**
 * Import notices: one severity model for everything an import wants to
 * tell the user that is not a hard error.
 *
 * Every import surface used to carry a flat `warnings: string[]`, so a
 * renamed account rendered in the same ochre as an unbalanced ledger and
 * the UI had to guess severity by substring-matching Swedish sentences.
 * A notice carries a code (an i18n key under `import_notices.*`, sv+en),
 * a severity and params, so the renderer can put one sentence on screen
 * and fold the rest away:
 *
 * - `action`: money or legal consequence, or something the user must do
 *   (untransferred result, IB amounts differ from the file, wrong org
 *   number, prices that look VAT-inclusive). At most one ochre sentence
 *   on screen; the rest inside the expander.
 * - `notice`: worth knowing, no money consequence (rows skipped for a
 *   bad date, dimension codes dropped, a batch retried). Collapsed behind
 *   "N anmärkningar".
 * - `info`: it happened, nothing to do (accounts renamed or created, IB
 *   derived from the prior year, duplicates skipped). Behind an info
 *   tooltip, never a line.
 *
 * The legacy `warnings: string[]` stays populated everywhere for API, MCP
 * and import_documentation consumers; the UI prefers `notices` when
 * present and falls back to `legacyNotices()` when it is not.
 */

export type ImportNoticeSeverity = 'info' | 'notice' | 'action'

export interface ImportNotice {
  /** i18n key under `import_notices.*`; rendered with `params`. */
  code: string
  severity: ImportNoticeSeverity
  params?: Record<string, string | number>
}

export interface ImportNoticeGroups {
  actions: ImportNotice[]
  notices: ImportNotice[]
  infos: ImportNotice[]
}

const SEVERITY_ORDER: Record<ImportNoticeSeverity, number> = { action: 0, notice: 1, info: 2 }

export function makeNotice(
  code: string,
  severity: ImportNoticeSeverity,
  params?: Record<string, string | number>
): ImportNotice {
  return params ? { code, severity, params } : { code, severity }
}

/** Split by severity, preserving emission order within each tier. */
export function groupNotices(notices: readonly ImportNotice[]): ImportNoticeGroups {
  const groups: ImportNoticeGroups = { actions: [], notices: [], infos: [] }
  for (const n of notices) {
    if (n.severity === 'action') groups.actions.push(n)
    else if (n.severity === 'notice') groups.notices.push(n)
    else groups.infos.push(n)
  }
  return groups
}

/** Stable sort: actions first, then notices, then info. */
export function sortNotices(notices: readonly ImportNotice[]): ImportNotice[] {
  return [...notices].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/**
 * Wrap free-text warnings that have no structured twin yet. Rendered
 * verbatim through the `legacy` key so a surface that still emits strings
 * keeps them visible, folded into the notice tier.
 */
export function legacyNotices(
  warnings: readonly string[] | undefined,
  severity: ImportNoticeSeverity = 'notice'
): ImportNotice[] {
  return (warnings ?? []).map((text) => makeNotice('legacy', severity, { text }))
}

export interface ParseIssueLike {
  row?: number
  line?: number
  message: string
  severity: 'info' | 'warning' | 'error'
}

/**
 * Parser issues carry their own three-level severity; map it onto the
 * notice tiers. Errors are excluded: they block the import and render
 * through the error surface, not as notices.
 */
export function noticesFromParseIssues(issues: readonly ParseIssueLike[] | undefined): ImportNotice[] {
  const out: ImportNotice[] = []
  for (const issue of issues ?? []) {
    if (issue.severity === 'error') continue
    const row = issue.row ?? issue.line ?? 0
    const severity: ImportNoticeSeverity = issue.severity === 'warning' ? 'notice' : 'info'
    out.push(
      row > 0
        ? makeNotice('parse_issue_row', severity, { row, message: issue.message })
        : makeNotice('parse_issue', severity, { message: issue.message })
    )
  }
  return out
}

/**
 * Notices for the UI: the structured list when the producer emitted one,
 * otherwise the legacy strings wrapped. `exclude` drops codes whose fact
 * a dedicated card already renders (skipped vouchers, untransferred
 * results), so the same thing is never on screen twice.
 */
export function resolveNotices(
  source: { notices?: ImportNotice[] | null; warnings?: string[] | null },
  exclude: readonly string[] = []
): ImportNotice[] {
  const list = source.notices && source.notices.length > 0
    ? source.notices
    : legacyNotices(source.warnings ?? undefined)
  if (exclude.length === 0) return sortNotices(list)
  const drop = new Set(exclude)
  return sortNotices(list.filter((n) => !drop.has(n.code)))
}
