# Bokio supplier invoice completion

Import and recovery share `enrichBokioSupplierInvoice`. Bokio's list is the complete supplier-invoice resource; hydration fetches its referenced journal entry instead of fetching the same invoice again. References retain the entry date, so a December invoice can resolve a January voucher in the correct fiscal year.

VAT is accepted from explicit invoice lines that reconcile to gross, or from ordinary input VAT on 2640/2641 when the source lines independently corroborate the net amount. A matching 244x/19xx gross alone is insufficient. Other VAT accounts, reversed entries, unsupported currencies and credit notes do not establish voucher VAT. Explicit mixed rates survive. Multiple unknown rates stay unresolved; journal lines never become invoice rows.

A paid SEK cash purchase can attach settlement evidence through `attach_supplier_invoice_settlement_voucher`. That RPC remains responsible for capacity and year-end cutoff checks. Its entry date supplies the payment date. The registration FK stays empty. Open invoices naming cash vouchers require review. Both the wizard and the durable import worker retain the evidence decision, source identity and upload references.

Document import records upload identities on both new uploads and existing hash-plus-voucher matches. Every upload reference must resolve, with exactly one distinct document, before a missing primary document is filled. Multiple documents and partially imported references remain unresolved.

Historical recovery uses durable source IDs first. Legacy fallback also requires supplier identity, invoice number, date, currency, total and credit status, unique across the complete source and local populations. Same-name supplier fallback is allowed only when the name is unique on both sides. An ambiguity never selects the first candidate.

The completion RPC locks and rechecks each invoice. Header, empty rows, missing document, eligible payment date, history and retry receipt commit together. Totals and journal entries are preserved. Existing rows and non-default VAT splits are preserved. A changed invoice is deferred. The exact pre-fix fabricated date signature is cleared only on an identified historical paid invoice, without contradictory payment evidence. A verified settlement replaces that signature or a missing date.

## Preview and activation

Use the existing authenticated, company-scoped POST action:

`/api/extensions/ext/arcim-migration/reconcile`

```json
{"consentId":"<Bokio consent UUID>","completeBokioSupplierInvoices":true,"dryRun":true}
```

Omitting `dryRun` on this path also previews. No invoice, source mapping, enrollment or progress receipt is written by preview. It reports the proposed payment-state refresh separately. If an open local invoice first needs that refresh, settlement validation reports `PAYMENT_REFRESH_REQUIRED`; that attachment has not yet passed the settled-invoice RPC checks.

After reviewing a company's preview, the same request with `dryRun:false` explicitly enrolls that company. The existing invoice-completion cron continues enrolled work. Deploying the code or migration enrolls no company. Production repair requires Emil's approval for the specific company/write.

Each run shares one paginated supplier list between matching and payment refresh, prioritizes due open rows, and caps hydration and writes within a deadline. Leases prevent overlapping writers. Per-invoice receipts survive a lost response; refused and unresolved rows receive a retry time so they cannot monopolize every batch. Runtime depends on actual provider pagination, throttling and eligible rows, so no fixed run-count estimate is promised.

Rollout: preview the reporting company, inspect representative changed and unresolved invoices, approve its repair, then verify receipts, history, document links and settlement dates before enrolling another company. Batch payments, missing source invoices, ambiguous identities, missing source lines and unbooked invoices are reported; they are not guessed.
