import { describe, it, expect } from 'vitest'
import { tools, deriveToolMeta, isDefaultCatalogTool } from '../server'
import { projectToolInputSchema } from '../company-routing'
import { projectToolReferences } from '../tool-namespace'

// Mirror the real tools/list serializer, including the derived staging _meta
// (requires_approval / approve_tool / preflight) merged over any literal
// _meta: otherwise the guard under-measures the wire payload.
const canonicalToolNames = new Set(tools.map((t) => t.name))

function serializeCatalog(namespace: 'gnubok' | 'accounted'): string {
  const projection = tools.filter(isDefaultCatalogTool).map((t) => {
    const meta = { ...(deriveToolMeta(t) ?? {}), ...(t._meta ?? {}) }
    const projected = {
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: projectToolInputSchema(t),
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: t.annotations,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    }
    return namespace === 'accounted'
      ? projectToolReferences(projected, namespace, canonicalToolNames)
      : projected
  })
  return JSON.stringify({ tools: projection })
}

const tokensFor = (namespace: 'gnubok' | 'accounted') =>
  Math.round(serializeCatalog(namespace).length / 4)

describe('tools/list payload size guard', () => {
  it('keeps the projected tools/list payload under the context-budget ceiling', () => {
    // Measure BOTH namespaces and guard the larger.
    //
    // `?tool_namespace=accounted` rewrites every gnubok_* reference to
    // accounted_* (+3 chars each), so the accounted projection is inherently
    // ~200 tokens larger than the gnubok one. CLAUDE.md points new MCP
    // installs at the accounted-mcp package and the accounted_* aliases, so
    // that larger payload is what a NEW user's client actually receives,
    // while this guard measured only the legacy namespace and let the real
    // worst case drift untested.
    const approxTokens = Math.max(tokensFor('gnubok'), tokensFor('accounted'))
    // Ceiling progression: 20K to 25K to 30K to 31K to 31.5K to 32K to 36K.
    //   * 20K → 25K when item 8 of the agent-native API plan landed
    //     (additionalProperties: false on all inputSchemas + period_status in the
    //     staged operation envelope).
    //   * 25K → 30K when the agentic branch merged with main: catalog grew from
    //     ~75 to 83 tools (added gnubok_create_supplier, gnubok_list_pending_operations,
    //     gnubok_approve_pending_operation, gnubok_reject_pending_operation,
    //     gnubok_set_inbox_extracted_data from main + gnubok_get_agent_briefing,
    //     _remember_fact, _forget_fact, _feedback from the agent branch).
    //   * 30K → 31K when gnubok_match_batch_allocate and
    //     gnubok_bulk_book_transactions landed (PRs #603/#606/#608/#610). Each
    //     adds the shared STAGED_OPERATION_SCHEMA + a non-trivial inputSchema
    //     for the multi-tx flows. Descriptions already trimmed to 230-260 chars.
    //   * 31K → 31.5K when gnubok_link_transaction_to_journal_entry landed (PR
    //     #614). Same family as match_batch_allocate / bulk_book_transactions:
    //     closes the MCP parity gap with the existing REST endpoint so agents
    //     can attach a bank tx to an already-posted verifikat without creating
    //     duplicate bookkeeping. Description trimmed to ~180 chars.
    //   * 31.5K → 32K when gnubok_find_voucher_candidates_for_supplier_invoice +
    //     gnubok_link_supplier_invoice_to_voucher landed: the supplier-side
    //     mirror of the customer find/link voucher tools. The link tool inlines
    //     the shared STAGED_OPERATION_SCHEMA. Lets agents mark a leverantörs-
    //     faktura paid against an already-posted verifikat (no new bokföring),
    //     which is exactly the fix for invoices imported from Fortnox as open
    //     payables while their payment already exists in the SIE-imported GL.
    //   * 32K → 36K when top-level Tool.title (MCP spec 2025-06-18) landed on all
    //     92 tools for Connectors Directory readiness; the ~10 longest descriptions
    //     were trimmed toward 180-200 chars to partly offset. Headroom reserved for
    //     the upcoming Skatteverket tools.
    //   * Held at 36K when gnubok_list_accrual_schedules (add/bokslut) merged with
    //     the categorize vat_amount override (#717): the combination crossed the
    //     ceiling by ~75, offset by trimming the 8 longest descriptions to ~200 chars.
    //   * 36K → 38K with the MCP legibility pass: the machine-readable staging
    //     contract now emits `_meta { requires_approval, approve_tool, preflight }`
    //     on every staging write (~40 tools) so an agent can tell: without reading
    //     prose: which writes need a follow-up gnubok_approve_pending_operation and
    //     which have a pre-flight; gnubok_get_agent_briefing also gained a `company`
    //     identity block in its outputSchema. This is wire data the agent depends
    //     on, not trimmable prose: hence a bump rather than a description trim.
    //   * 38K → 40K as the catalog grew from 92 to 103 tools (gnubok_link_document_
    //     to_voucher #804, gnubok_bulk_book_inbox_items, the categorize-core additions,
    //     plus per-line supplier-invoice overrides). Each new tool carries its
    //     inputSchema + staging _meta; the growth is genuine wire data, not prose,
    //     so descriptions are already at their trimmed floor (~180-220 chars).
    //   * 40K → 42K with dimensions PR3: gnubok_list_dimensions +
    //     gnubok_list_dimension_values (nested registry output schemas) + staged
    //     gnubok_create_dimension_value (STAGED_OPERATION_SCHEMA + _meta), the
    //     dims bag + default_dimensions on create_voucher/correct_entry, and the
    //     agent-briefing dimensions block. Descriptions were trimmed first
    //     (~200 tokens recovered); the remainder is schema structure agents
    //     depend on for resolve-don't-select, not trimmable prose.
    //   * 42K → 43K with dimensions PR4 reports: gnubok_get_dimension_pnl (the
    //     value-as-column matrix outputSchema is the wire contract agents read
    //     the report through), the shared `dimensions` filter arg + echo props
    //     on trial balance / income statement / general ledger, and
    //     group_by/group_by_dimension + totals_scope + groups on
    //     gnubok_query_journal. Descriptions trimmed first (~100 tokens
    //     recovered); the ~55-token remainder is schema structure.
    //   * 43K → 44K with dimensions PR7 producers: default_dimensions + per-item/
    //     per-line dims bags on gnubok_create_invoice, gnubok_create_supplier_
    //     invoice_from_inbox, gnubok_categorize_transaction and
    //     gnubok_bulk_book_transactions (8 new object properties). Descriptions
    //     already use the compact "Dims bag" form (~90 tokens trimmed first);
    //     the remainder is schema structure the resolve-don't-select contract
    //     depends on, not trimmable prose.
    //   * 44K → 45K when the rot/rut branch merged with main: main's #877 put
    //     qualified identifiers in all tool output schemas (+~260 across 103
    //     tools: wire contract, not prose) and the branch added
    //     gnubok_generate_rot_rut_file (~444: begäran-om-utbetalning file flow,
    //     eligible/blocked per-invoice output). Each side alone was under the
    //     ceiling; the combination crossed it by ~220. Descriptions are at
    //     their trimmed floor per the entries above.
    //   * 45K → 45.5K when payment_link_url landed on gnubok_create_invoice
    //     (manual payment-link MVP): one optional string property with an
    //     already-minimal ~24-token description. Headroom before the change was
    //     under 10 tokens, so even this smallest possible addition crossed;
    //     other descriptions are at their trimmed floor per the entries above.
    //   * 45.5K → 50K with the payroll gap-closure (8 tools): 3 reads
    //     (gnubok_get_employee, gnubok_get_payslip, gnubok_list_absence) + 5
    //     staged writes (update_payslip_line, register_absence,
    //     create_employee, update_employee, set_employee_opening_balances).
    //     create/update_employee carry the full employee-config inputSchema
    //     (~27 properties each: the whole point is agent-driveable payroll
    //     onboarding), and every staged write inlines STAGED_OPERATION_SCHEMA
    //     + _meta. Property descriptions trimmed to enum-only where the name
    //     is self-evident; the remainder is wire contract, not prose.
    //   * 50K → 51K with the vacation workflow (gap-closure Phase 3):
    //     gnubok_get_vacation_balance (ledger read) + gnubok_close_vacation_year
    //     (staged HIGH semesterårsavslut with STAGED_OPERATION_SCHEMA + _meta).
    //     Fortnox gap category E closed; both schemas already minimal.
    //   * 51K to 54K for stateless multi-company MCP routing. Every
    //     company-dependent tool must expose the optional company_id input so
    //     the client can target another authorized company without shared
    //     mutable connection state. The repeated property is intentionally
    //     minimal; gnubok_list_companies and initialize instructions explain it.
    //   * 54K → 56K with kontoplan management + verifikat notes (MCP parity
    //     requested by an MCP-driven user): staged gnubok_create_account /
    //     gnubok_update_account (kontoplan reference data, BAS 2026 prefill)
    //     + gnubok_set_voucher_note (notes-only annotation, trigger-guarded),
    //     each inlining STAGED_OPERATION_SCHEMA + _meta + company_id routing.
    //     Descriptions and property prose trimmed first; the remainder is
    //     wire contract.
    //   * 56K → 57K with payroll e2e parity: staged gnubok_book_salary_run
    //     (advances the run through godkänd/utbetald and posts the lön
    //     verifikat: closes the "booking happens in the web UI" gap) +
    //     gnubok_delete_absence (inverse of register_absence), both inlining
    //     STAGED_OPERATION_SCHEMA + _meta + company_id routing. Descriptions
    //     trimmed to the floor first; the remainder is wire contract.
    //   * 57K → 57.5K with recommended_tools on gnubok_get_agent_briefing
    //     (#1098): the per-workflow tool-loadout array in the outputSchema
    //     (~175 tokens) lets deferred-loading harnesses batch-load a whole
    //     workflow cluster in one ToolSearch select call instead of 4-6
    //     discovery round-trips. Schema prose trimmed to the floor first;
    //     headroom before the change was ~15 tokens, and the remainder is
    //     the wire contract agents read the loadout through.
    //   * 57.5K → 58K with the run-scoped AGI filing contract on
    //     gnubok_agi_status (filing_state enum + kvittensnummer + run-scoped
    //     local_state): a correction run must be able to tell, from the wire
    //     contract alone, that it is unfiled for this run even though the
    //     period record holds the superseded original's receipt (a correction
    //     is a full resubmission with its own kvittens). Descriptions were
    //     trimmed to the floor first (agi_status, lock_period, list_employees
    //     gave back ~100 tokens); the ~90-token remainder is the contract
    //     agents read the filing state through.
    //   * 58K → 58.5K with the approval-queue widget: render_ui on
    //     gnubok_list_pending_operations opens the MCP Apps queue where
    //     approve/reject (and the high-risk BFL acknowledgment) are first-party
    //     human clicks instead of agent-asserted confirmed=true. The property +
    //     hint prose was trimmed to the floor first (~30 tokens recovered);
    //     headroom before the change was ~14 tokens, so even the trimmed wire
    //     contract crossed.
    //   * 58.5K → 59K with the model-free upload pair (#748):
    //     gnubok_create_document_upload + gnubok_complete_document_upload move
    //     document bytes out of the model context via a signed PUT URL, fixing
    //     silent base64 corruption on real-size PDFs. Neither tool can be
    //     search-only: the pair is the primary upload path for harnesses with
    //     file access, and the legacy inline tool stays listed for clients
    //     without it. Trimmed first: the create tool's outputSchema was cut to
    //     upload_id/upload_url/expires_at (method, size cap and echo fields
    //     moved to description prose) and mime_type made optional on complete;
    //     the ~360-token remainder is the two tools' wire contract.
    //   * 59K → 59.5K with the correction-chain depth guard: allow_deep_chain on
    //     gnubok_correct_entry + gnubok_reverse_journal_entry (the explicit
    //     bypass agents must discover to override CORRECTION_CHAIN_TOO_DEEP).
    //     Both property descriptions trimmed to one sentence first; headroom
    //     before the change was under 20 tokens, so even the trimmed wire
    //     contract crossed.
    //   * 59.5K to 59.7K with account VAT treatments: create_account and
    //     update_account both expose the 12-value treatment vocabulary. The
    //     descriptions are minimal; the enum values are the wire contract.
    //   * 59.7K to 59.75K with customer_number on gnubok_create_customer:
    //     parity with gnubok_update_customer, so setting a customer number no
    //     longer needs a second staged update after create. The property has
    //     no description (name + maxLength are the whole contract); headroom
    //     before the change was ~11 tokens, so even that minimal form crossed.
    //   * 59.75K to 59.85K with personal_number on gnubok_create_customer: a
    //     private person's personnummer had no input at all on the MCP path,
    //     so agents put it in org_number, where nothing masks it (GDPR art.
    //     5.1 c; 134 such rows across 10 companies on prod). The property is
    //     the contract; its description and the org_number/payment_terms
    //     descriptions were trimmed to one short sentence first; headroom
    //     before the change was ~11 tokens, so even the trimmed form crossed.
    //   * 59.85K to 59.9K with the bank account on transaction listings
    //     (customer A4): cash_account_id + cash_account_ledger on
    //     gnubok_list_uncategorized_transactions and
    //     gnubok_list_transactions_without_documents, plus a cash_account_id
    //     filter on the former, so per-account reconciliation can be driven
    //     from outside. No property descriptions (names are the contract);
    //     the tool description gained six words; headroom before the change
    //     was ~50 tokens, so even the bare contract crossed by ~10.
    //   * 59.9K to 59.95K with the vat_amount currency contract (MCP feedback
    //     seq 254607): vat_amount on categorize + bulk_book now states its
    //     denomination (transaction currency, booked in SEK), and
    //     matched_supplier_id on the two upload tools became ['string','null']
    //     so strict clients stop failing successful unmatched uploads (seq
    //     261972). Prose trimmed to the floor first; headroom before the
    //     change was ~19 tokens, so even the trimmed contract crossed.
    //   * 59.95K to 60K with operation_status on gnubok_approve_pending_operation
    //     (feedback seq 261545): a failed approve used to consume the op
    //     silently, and agents inferred "consumed" from status 'failed' both
    //     ways. The enum is the contract; the description is one clause;
    //     headroom before the change was ~15 tokens, so even that crossed.
    //   * 60K to 60.2K with skatteverket_connection on the briefing: the
    //     connection-health block (status/source/connected_at) that lets an
    //     agent warn the user about a dead 65-minute SKV session at session
    //     start instead of mid-task. The runtime block is emitted only for
    //     companies with a connection; this cost is the outputSchema contract
    //     (~140 tokens), already trimmed to two short description strings.
    //   * 60.2K to 60.7K with gnubok_create_company (issue #1814 PR 3): a
    //     default-catalog tool by necessity, since a client that has not
    //     connected yet can only call what tools/list shows and this is the
    //     first protected call of agent-driven onboarding. Its contract was
    //     trimmed to bare property names first (the two connect-link tools
    //     are search-only); headroom before the change was ~0 after the skatteverket_connection bump, so even the
    //     bare contract crossed by ~420.
    //   * 60.7K to 61.2K with the two connect-link tools moved into the default
    //     catalog (issue #1814): Claude.ai can only CALL tools present in
    //     tools/list, so catalogVisibility 'search' means discover-only there;
    //     the onboarding flow dead-ended on client-side tool-not-found when
    //     the skill pointed at them (SilverPark session, 2026-08-26).
    //   * 61.2K to 61.5K with gnubok_lookup_company (org-number-first
    //     onboarding): default-catalog for the same reason as the connect
    //     tools; the onboarding skill's first instruction is to call it, and
    //     a search-only tool is uncallable on Claude.ai. Descriptions were
    //     trimmed first; the tool costs ~265 tokens against ~0 headroom.
    //   * 61.5K to 62K with gnubok_sie_preflight (migration-first onboarding):
    //     the scan-before-import step the skill instructs for shared SIE
    //     files, so default-catalog for the same Claude.ai reason; ~390
    //     tokens (schema carries the mappings-passthrough contract).
    //   * 62K to 62.4K with gnubok_create_sie_upload + upload_id/sha256 on the
    //     two SIE tools: the byte-exact upload path after a real 104 KB file
    //     dead-ended in chat (a model cannot reproduce 30k tokens verbatim
    //     without silent-truncation risk); skill-instructed, so default catalog.
    //   * 62.4K to 63K with gnubok_connect_migration (the previous-system
    //     connect card, same one-click feel as bank/Skatteverket): the skill
    //     instructs calling it when the user names Fortnox/BL/Briox/Wint, so
    //     default catalog for the standing Claude.ai reason.
    //   * 63K to 63.4K with gnubok_reconcile_match promoted to the default
    //     catalog: the onboarding efterkontroll instructs matching bank rows
    //     against SIE verifikat, and a search-only tool is uncallable on
    //     Claude.ai (E2E #12 punted to the web app over it).
    //   * 63.4K to 63.6K with NO new tool: the guard started measuring the
    //     accounted_* namespace as well as gnubok_* and asserting on the
    //     larger. The accounted projection was already ~90 tokens over the
    //     63.4K line (the namespace rewrite costs ~209 tokens on its own) and
    //     nothing tested it, so this bump buys no new catalog surface. It
    //     re-points an existing ceiling at the payload new installs actually
    //     receive; the gnubok projection still sits ~320 tokens under it.
    //   * 63.6K DOWN to 63.1K, the first tightening in this ledger. Two
    //     changes, net -549 tokens on the guarded (accounted) projection:
    //     gnubok_get_agent_briefing's outputSchema went 7,743 to 4,565 chars
    //     by condensing four sub-schemas whose interiors were documentation
    //     rather than contract (ledger_context, dimensions,
    //     skatteverket_connection, recommended_tools: agent-briefing.test.ts
    //     pins their RUNTIME shape, so nothing was left unguarded), against
    //     +~245 for the new gnubok_call_tool.
    //   * 63.1K to 63.8K with gnubok_update_customer promoted to the default
    //     catalog (#1706, #1876). gnubok_call_tool (above) only bridges READ
    //     tools and refuses writes, so a search-only WRITE tool is still
    //     uncallable on Claude.ai; the reporter read the tool as missing twice.
    //     The +761 tokens are the 19-property partial-update wire contract plus
    //     the staging envelope; the description is already 152 chars.
    //     Measured 63 761 on the accounted projection after merging #1993
    //     (line_type and revenue_account declared on the create item schema).
    //   * 63.8K to 64.4K with gnubok_set_run_salary in the default catalog
    //     (variable owner pay, the payroll_month flagship flow). Same reason
    //     as update_customer: a search-only WRITE is uncallable on Claude.ai,
    //     and both update_payslip_line's description and the payroll_month
    //     loadout point agents at this tool. Measured 64 315 on the accounted
    //     projection. This bump skips the "demote a read first" rule below
    //     deliberately: picking which read to demote needs prod usage data
    //     (MCP usage profile), not a guess inside a payroll PR: do that
    //     demotion as its own change and ratchet this ceiling back down.
    //   * 64.4K to 65K with gnubok_ignore_transaction in the default catalog
    //     (issue #1661: private marking in a locked period). Same reason as
    //     set_run_salary: a search-only WRITE is uncallable on Claude.ai, and
    //     the TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED remediation, three loadouts
    //     and the reconcile-month skill instruct agents to CALL it. Measured
    //     64 863 on the accounted projection (+548: a 4-property schema plus
    //     the staging envelope; the description is one sentence per fact).
    //     Same deliberate skip of the read-demotion rule as the entry above:
    //     the demotion needs prod usage data, not a guess inside this PR.
    //   * 65K to 61.3K by demoting ten rarely-called READ tools to
    //     search-only (2026-08-31). This is the demotion the two entries above
    //     deferred for want of prod usage data, done as its own change and
    //     ratcheting the ceiling back down as they asked.
    //
    //     Picked from 60 days of mcp.tool_called: default-catalog reads with
    //     <= 25 calls, excluding anything in RECOMMENDED_WORKFLOW_LOADOUTS.
    //     Deliberately NOT demoted despite low counts:
    //       - gnubok_call_tool, which IS the search-only bridge;
    //       - gnubok_receipt_matcher and gnubok_vat_review_widget, which are
    //         WIDGET tools: the host renders them from the _meta.ui they
    //         publish in tools/list, so search-only makes the widget
    //         unrenderable. Their own tests catch this; both were demoted in a
    //         first pass and put back.
    //       - the connect_* onboarding tools (#1936 put them in the catalog on
    //         purpose: a fresh agent has not learned to search yet);
    //       - gnubok_lookup_company, the org-number-first onboarding entry;
    //       - every arsredovisning / dispositioner / depreciation / accrual
    //         PROPOSAL tool. A 60-day window ending in August cannot see
    //         bokslut season at all: most Swedish companies close on 31 Dec and
    //         do the work Jan-Jun, so summer counts understate them to near
    //         zero. Demoting those would hide the year-end flow exactly when it
    //         is needed. Usage data is necessary here, not sufficient.
    //
    //   * 61.3K to 61.5K by adding worked `examples` to five tools
    //     (2026-09-01, #2066): categorize_transaction, create_voucher,
    //     query_journal, approve_pending_operation, get_kpi_report. 199 tokens
    //     for 10 examples, spending part of what the demotion above reclaimed
    //     and leaving ~118 under the ceiling. The ceiling is NOT raised.
    //     Examples were priced against 30 days of mcp.tool_called and aimed at
    //     the combinations the descriptions already warn about and callers
    //     still get wrong (account_override without vat_treatment;
    //     representation without deltagare; confirmed on a high-risk approval;
    //     `metric` sent to a tool whose only parameter is period_id).
    //     Cheaper than it looks per example, so the next batch should still
    //     demote a read first rather than assume there is room.
    //
    // Long-term answer to growth is no longer a ceiling bump. gnubok_call_tool
    // makes `catalogVisibility: 'search'` usable for READ tools on hosts that
    // can only invoke what tools/list showed them, which is the constraint that
    // forced gnubok_reconcile_match back into the default catalog on
    // 2026-08-26. Demote a read to search-only before proposing a bump.
    //
    // Only READ tools may be demoted: gnubok_call_tool refuses writes, so a
    // search-only WRITE is uncallable on Claude.ai. That is why the three
    // bumps above happened instead of demotions.
    expect(approxTokens).toBeLessThan(61_600)
  })

  /**
   * The trap that catches anyone reclaiming budget by demoting reads.
   *
   * A widget tool publishes _meta.ui in tools/list, and that is how the host
   * knows to render it. Search-only hides it from tools/list, so the widget
   * silently stops rendering while the tool still "works" when called. Two
   * widget tools were demoted in the 2026-08-31 pass and put back; their own
   * suites caught it, but only because those suites happen to exist. This
   * makes the rule hold for every widget tool added later.
   */
  it('never lets a widget tool fall out of the default catalog', () => {
    const hiddenWidgets = tools
      .filter((t) => (t as { _meta?: { ui?: unknown } })._meta?.ui)
      .filter((t) => !isDefaultCatalogTool(t))
      .map((t) => t.name)

    expect(
      hiddenWidgets,
      `Widget tools publish _meta.ui in tools/list and the host renders them from it. ` +
        `catalogVisibility: 'search' hides them there, so the widget stops rendering: ` +
        hiddenWidgets.join(', '),
    ).toEqual([])
  })

  it('keeps the accounted_* namespace as the measured worst case', () => {
    // Pins the DIRECTION of the delta, not its size. If a future change ever
    // made gnubok_* the larger projection, the Math.max above would silently
    // keep passing while this guard stopped describing reality.
    expect(serializeCatalog('accounted').length).toBeGreaterThan(
      serializeCatalog('gnubok').length,
    )
  })
})
