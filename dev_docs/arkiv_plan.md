# Arkiv: the document knowledge layer. Plan of record

Date: 2026-09-14. Status: DECIDED, NOTHING BUILT. Owner: founders. This file is the single
source for the build; the research memos and the design canvas explain the why, this file
says what gets built, in which order, and how we know each step worked.

Related: the research memos "Obsidian for the Ledger" and "Arkiv, Built Right" (artifacts),
the design canvas "Arkiv" (artifact b0c1af96), issues #2498 (link basis), #2063
(affärshändelse), #2190 (text-PDF path), #2571 (partial PDF reads), #2561, #1357; open PRs
#2410, #2411, #2412 (underlag pipeline), #2603 (UI shell guard), #2609 (SFS number).

## 1. The outcome

When this is done, the following is true for every company on Accounted:

1. Any document about the business can be dropped in, in any format, through any channel
   (upload, mail, WhatsApp, Peppol, API, an agent), and it lands in Arkiv the same second:
   immutable, hashed, printable, searchable by its text, kept seven years.
2. The system says what the document is (lease, loan, rental contract, subscription,
   registreringsbevis, Skatteverket decision, invoice, receipt, statement, minutes, other),
   and if nothing ties it to the company it asks before admitting it.
3. Each typed document becomes a record with fields that cite their page and text span, checked
   by two readings and by rules, reviewed by a person only where the readings disagree.
4. Records link to what already exists (counterparty, asset, agreement, transaction,
   verifikat), each link with a basis: proven or guessed.
5. Facts carry a source, a validity window and a belief window, are superseded rather than
   deleted, and are confirmed by the ledger or a register before a person is asked.
6. What the facts imply is produced without asking: expected payments, important dates,
   settings checks against registrations and decisions, year-end notes with sources.
7. Agents read all of it through six tools with stable ids and citations, and curate it by
   proposing changes that people (or a deterministic policy) apply. Nothing an agent does
   touches the journal.
8. Underlag stays the queue for what must become a verifikat. Arkiv is the place that grows.
9. Every step that changes how documents are treated (schema, model, prompt, rule) is an
   event in the same log the behandlingshistorik report reads.

Measures that say it works (targets after phase 5, per company in the trial set):

| Measure | Target |
|---|---|
| Documents leaving `other` after classification | over 90 % |
| Extracted fields accepted without edit, per type | over 90 % money and dates, over 80 % descriptive |
| Fields routed to a person | under 15 % of fields, under 30 % of documents |
| Auto-approved fields found wrong in the 5 % audit | under 1 % |
| Median time from arrival to linked | under 2 minutes attended, under 24 h unattended |
| Agent answers on the 30-case set that cite a fact and a page | 100 %; accuracy at least as good as without the record, measured |
| Cost per document | under 0.05 USD invoices, under 0.60 USD 20-page agreements |

## 2. Decisions taken (do not re-litigate; append here if a decision changes)

| # | Decision (2026-09-14) | Rejected |
|---|---|---|
| 1 | Reading: pdf-inspector for PDFs (text vs scanned routing, local text with coordinates), AnyDoc for Office and OpenDocument, Claude vision for scans and photos. No OCR vendor. Two new MIT dependencies approved. | Mistral OCR 4 sidecar (deferred, not refused); Claude-only with Office formats rejected at upload |
| 2 | `agreements` is a first-class table with an entity page. | Facts only |
| 3 | Search: Postgres full-text (swedish) plus trigram first; embeddings only after logged misses show a vocabulary problem. | Hybrid with embeddings from day one |
| 4 | Arkiv is its own entry in the v2 sidebar under Bolaget, after Inköp (where Underlag lives); sub-pages Alla dokument, Avtal, Myndighet. Underlag unchanged. | A tab inside Underlag |
| 5 | First extraction schemas: lease, loan, rental, subscription, registreringsbevis, Skatteverket decisions. Classification covers the whole taxonomy from day one. | Agreements only; registrations first; whole taxonomy at once |
| 6 | Relevance gate: after classification, if nothing ties the file to the company (no amount, counterparty, org number or business text; or addressed to another company), ask "Är du säker på att det här rör bolaget?" before admission. No discards the file (never stored as räkenskapsinformation); yes with a reason admits it as Övrigt. Unattended channels put the question in Att göra with the file held. | Silent admission; silent rejection |
| 7 | Arkiv graph: on the page, no box, blue company hub, groups on a ring, documents as points, names and a card on hover; still tilted view by default, drag and zoom on demand, no auto-rotation in the product. | Dark boxed panel (kept on the canvas for comparison); force-directed hairball |
| 8 | Arkiv toolbar: type dropdown and search on the left, the year picker far right, no attention line. | Segmented type filter |

Constraints carried over: the ledger is the arbiter (ledger-derived facts have confidence 1
and are never superseded by an extraction); nodes are existing rows, no shadow copies; no
foreign key from core tables into this layer; controlled vocabularies for predicates and
relations; never touch posted lines; coordinate the extraction schema lineage with #2411
before cutting per-type schemas.

## 3. Outcomes by phase

Each phase ships value on its own and can stop there. "Try" is what Jakob can do the day the
phase is live. Acceptance is what must be true before the phase is called done.

### Phase 0: measure and label (1 PR, needs founder documents)

Outcome: we know the baseline and have a labelled Swedish set to score every later phase.

- Read-only production query: share of inbox documents in `ready` with no link, share
  classified `other`, sample of what they are. Numbers go into this file.
- Trial set: 20 to 50 real documents of the six target types plus a handful of receipts,
  invoices and clearly irrelevant files, from the founders' companies. See section 9.
- Eval harness: `scripts/arkiv/eval.ts` reads a directory of documents with a `labels.json`
  sidecar and scores classification (accuracy per type) and extraction (per field: exact for
  identifiers, tolerance for amounts, semantic for names; three states present, null,
  missing; a hallucinated identifier scores worse than a blank). Output: one markdown report.
- Try: run the harness on the trial set with today's extractor. Every document gets a page in
  the report: what the system thinks it is, what it read, what it would have created.
- Acceptance: baseline numbers written here; harness runs on the trial set; a golden set of
  at least 50 labelled documents exists outside the repo (real documents are never committed).

### Phase 1: read (2 to 3 PRs)

Outcome: every document in Arkiv has page text, scanned or not, and is searchable.

- `document_pages` (text, words with coordinates when read locally, reader, tsvector swedish);
  reading router: pdf-inspector for PDFs (text vs scanned), AnyDoc for Office and OpenDocument,
  Claude vision for scans and photos, HTML bodies as text.
- Upload allowlist and magic-byte checks widened to Office formats; HEIC converted in the
  browser before upload.
- Backfill cron over existing documents, newest first. Diagnose #2571 on real page text;
  #2190 closes.
- Try: search a phrase from a scanned PDF and find it; open a document and see its text layer.
- Acceptance: 100 % of trial documents have page text; a known phrase in a scanned trial
  document is found by full-text search; no document read takes longer than 60 s.

### Phase 2: classify and admit (2 PRs)

Outcome: every document is sorted, and nothing irrelevant enters the record.

- Taxonomy v1 with a one-paragraph description per class; Haiku on the first and last page:
  type, confidence, language, multi-document flag; `document_classifications`.
- Split step for multi-document scans (page ranges per segment).
- Relevance gate (decision 6): held state on the document, the question dialog, the Att göra
  item for unattended channels, admission as the event that starts retention.
- Att göra item "Vad är det här dokumentet?" for low confidence or `other`; `suggested_type`
  mined weekly for new classes.
- Try: drop a lease, a registreringsbevis, a receipt and a holiday photo; watch three sort
  themselves and the fourth get the question.
- Acceptance: classification accuracy on the trial set over 90 %; every irrelevant trial file
  gets the question; no relevant trial file gets it.

### Phase 3: extract (3 to 4 PRs)

Outcome: the six first types become records with sourced fields; a person sees only the
fields where two readings disagree.

- `extraction_schemas` registry (type, version, JSON schema, upcast rule); a shared core plus
  a grounded field wrapper (value, normalised, page, span, box when local, confidence,
  method); per-type Zod schemas for lease, loan, rental, subscription, registreringsbevis,
  Skatteverket decisions; forced tool call on Bedrock, Zod refinements post-parse.
- Two readings per document (differently framed prompts); deterministic checks (sums, VAT,
  org number, OCR and Bankgiro checksums, dates in range); disagreement or a failed check
  routes the field, not the document.
- `document_extractions` versioned, never overwritten; `agents` and `activities` in the PROV
  shape record who and what produced each extraction (model id, prompt hash, schema version).
- Review in Att göra: field, both values, source highlighted; corrections stored with a
  reason and fed to the golden set.
- Try: upload the lease again and open its record: rent, notice period, end date, each with
  "sida N" beside it; change a value and see the source it was read from.
- Acceptance: per-field accuracy targets in section 1 on the trial set; every accepted field
  resolves to a page; reprocessing a document under a bumped schema version produces a new
  extraction row and leaves the old one intact.

### Phase 4: link and entities (2 to 3 PRs)

Outcome: records attach to the company's existing objects, and agreements become expected
money and dates.

- `document_links` (target kind and id, basis proven or guessed, method, confidence, who);
  the legal link `journal_entry_id` on `document_attachments` untouched.
- `agreements` and `agreement_obligations`; assets can hold their document; party resolution
  reused from #2411 and #2412.
- Obligations become expected rows for the arrival matcher; notice periods, renewals and end
  dates go into the deadline calendar with the source attached.
- Try: after uploading the lease, see next month's rent as an expected payment and the
  notice date in Viktiga datum, both pointing back at the page.
- Acceptance: every trial agreement has an obligations schedule; expected rows confirmed by
  real transactions in the trial company; median arrival-to-linked time under the target.

### Phase 5: facts, briefs, tools, Arkiv (3 to 4 PRs)

Outcome: the record exists as dated, sourced facts; agents read and curate it; people get
Arkiv.

- `company_facts` (subject, predicate, value, valid daterange, sys tstzrange, rank, supersedes,
  deprecation reason, source extraction, evidence, asserted by, approved by; exclusion on live
  single-valued predicates) and `fact_sources`.
- `change_proposals` (prior state, checks, rationale, evidence, status, reviewer, applied
  event) as the only table agents write; rollback is one command.
- `events` append-only log feeding the behandlingshistorik report (PR #1787): propose, review,
  apply, revert, schema, model and prompt changes.
- Six MCP tools (`search_records`, `get_record`, `get_record_links`, `get_fact_history`,
  `get_source`, `propose_fact`) with `as_of` and stable ids; a stanza of at most 1 500 tokens
  in the agent briefing written as instructions and anchor ids.
- Arkiv page: the graph (decision 7), the toolbar (decision 8), the table; entity pages for
  agreements, registrations and decisions with facts, source highlight and backlinks; the
  facts section in "Vad din agent vet".
- Confidence routing calibrated from phase 3 data; 5 % audit of auto-approved fields; autonomy
  ladder per (document type, action) with demotion wired to the audit and the override rate.
- Try: ask the assistant what the rent is and when to give notice; get the answer with the
  page cited; hover the graph; open the agreement; see the facts change history.
- Acceptance: the 30-case agent set scores at least as well with the record as without and
  cites a fact and a page every time; every proposal by an agent is reviewable and revertible;
  the behandlingshistorik report shows a schema change as an event.

### Phase 6: later, decided by phase 5 measures

Precedent reader over pending operations, the rättelse log and corrections (the context graph
proper); settings reconciliation from registrations and decisions (#1357); automatic
embeddings if the search log shows vocabulary misses; nightly lint that files proposals;
authenticity signals on uploads as reason codes; employment, shareholder, minutes and
annual-report schemas; earned auto-settle for customer payments (founder call).

## 4. Pipeline and data model

Pipeline (each stage one job, idempotent behind `doc:<sha256>:<stage>:<schema version>`):
intake, hold or admit, split, read, classify, relevance, extract (two readings), check, route,
review, link, facts, derive, brief.

Tables (all under RLS on `company_id`; originals immutable; everything else append-only with
supersession; every derived row points to the activity and agent that produced it):

```
document_attachments   existing; the original file. Gains: admission_state held|admitted|discarded,
                       admitted_at, media_type identified from bytes, retention_until
document_segments      document, page range, kind, confidence (split step)
document_pages         document, page_no, text, words jsonb [{t, x0,y0,x1,y1}] when read locally,
                       reader, has_text_layer, tsv (swedish, generated)
document_classifications  document, doc_type, confidence, model, prompt_sha256, language,
                       is_multi_document, relevance (relevant|ask|irrelevant), reason,
                       suggested_type, decided_by
extraction_schemas     (schema_type, version) json_schema, upcast_from_prev, introduced_at, deprecated_at
document_extractions   document, file, activity, schema_type, schema_version, pass, payload jsonb
                       { field: {value, normalized, page, span, bbox, confidence, method} },
                       validation jsonb, is_current, superseded_by
document_links         document, target_kind, target_id, basis proven|guessed|ambiguous, method,
                       confidence, created_by, retired_at
agreements             kind, counterparty ref, title, starts_on, ends_on, notice_period,
                       renewal_rule, amount, currency, period, status, source_document_id
agreement_obligations  agreement, kind payment|interest|amortisation|index, due_on or recurrence,
                       amount, expected_row_ref
company_facts          subject_kind, subject_id, predicate (controlled), value jsonb,
                       valid daterange, sys tstzrange, supersedes_id,
                       rank preferred|normal|deprecated, deprecation_reason,
                       source_extraction_id, evidence jsonb, asserted_by, approved_by,
                       status proposed|confirmed
                       EXCLUDE gist (subject, predicate, valid &&) WHERE live AND single_valued
fact_sources           fact, document, page, span, bbox, model, extracted_at
agents                 kind human|software, name, version, acted_on_behalf_of
activities             kind, agent, schema_type, schema_version, model_id, prompt_sha256,
                       started_at, ended_at, outcome, detail
change_proposals       proposer, target_table, target_id, operation, proposed, prior, rationale,
                       evidence, checks, risk, status proposed|approved|rejected|applied|
                       reverted|expired, reviewer, decided_at, applied_event_id
events                 append only: txid, occurred_at, event_type, agent, object, outcome, detail
entity_briefs          kind, id, markdown, generated_at, stale (trigger-set)
```

Rules: the only UPDATE ever allowed on `company_facts` is closing `sys` when superseding;
`document_attachments` and `events` reject UPDATE and DELETE by trigger; `document_extractions`
are never overwritten; a schema bump is a backfill job, not a migration.

## 5. Reading, classification, extraction rules

- Reading: text layer first (pdf-inspector, AnyDoc), model only for scans and photos; page text
  always stored; word boxes when read locally; page-level provenance otherwise.
- Classification: Haiku on page one plus the last page; `other` and `ask` are valid answers;
  escalate to Sonnet only on low confidence.
- Extraction: Sonnet per type; Opus for agreements over ten pages; only the pages the text
  search flags for long documents; two differently framed readings; model self-confidence is
  never the routing signal, agreement and rule outcomes are.
- Thresholds per field type from measured error on the golden set, not by hand; money and
  dates stricter than descriptive fields.
- Everything Swedish about treatment (VAT, leasing, loans, notes) is taken from the
  `swedish-*` skills at build time, never from the model's general knowledge.

## 6. Rules for agent curation

1. Agents read files and pages; they never write or delete them.
2. Agents insert only `change_proposals`; applying is a person or a deterministic policy that
   records the human who authorised the policy.
3. Every proposal carries evidence: extraction, file hash, page or snippet, retrieval time.
4. New evidence for an existing fact attaches to it, never a duplicate.
5. A human-asserted or approved fact is never overwritten; a conflicting reading is a
   supersession proposal that shows the diff.
6. Wrong values are deprecated with a reason; historically true values get a closed validity.
7. Constraint checks run on every proposal; mandatory violations block auto-apply.
8. Every agent has an identity and version; every write is tagged and linked to its activity.
9. A new agent version runs a supervised batch before unattended operation.
10. Rollback is one command; each applied proposal stores the prior state.
11. A periodic lint files proposals for contradictions, stale claims, orphans and missing
    links; it never fixes.
12. Propose, review, apply, revert, and every schema, model or prompt change are events.

## 7. Legal guarantees (BFL 7 kap as amended by SFS 2024:342; BFNAR 2013:2 as amended 2024)

- Received electronic documents are kept in the format and with the content they had on
  arrival, seven years, printable on demand. Admission is the moment this starts.
- Extraction and text layers are derived data with provenance, never a replacement; originals
  are never deleted, so the överföring rule is never triggered.
- Non-durable input (thermal receipts) is satisfied by a complete, readable image.
- Schema, model, prompt and rule changes that affect bookkeeping proposals are dated events in
  the behandlingshistorik; the document layer gets a section in the systemdokumentation.

## 8. Plumbing on our stack

pgmq is the queue of record (at-least-once, idempotent handlers); pg_cron ticks; pg_net only
wakes a Vercel function; one function per stage under the 300 s default; uploads go direct to
storage; dead-letter queue by read count; alert on the age of the oldest message. Claude
citations are page-level and cannot combine with structured outputs, so field boxes come from
our own text layer by matching the model's `source_text` per field.

## 9. The trial with the founders' documents

Real documents are never committed to the repo. They live in a directory outside it, path in
`ARKIV_TRIAL_DIR`, with this layout:

```
ARKIV_TRIAL_DIR/
  <company-slug>/
    <any-file-name>.pdf|.jpg|.png|.heic|.docx|.xlsx
    labels.json      one entry per file: { "file": "...", "type": "agreement.lease",
                     "relevant": true, "fields": { "monthly_rent": 19300, "ends_on": "2027-12-31", ... },
                     "notes": "free text" }
```

What to send, ideally 20 to 50 files in total: leases and rental contracts (with any addenda),
loan agreements, subscription terms, the registreringsbevis, Skatteverket decisions (F-skatt,
moms, arbetsgivare), a few supplier invoices and receipts (one photo, one text PDF, one scan),
and three or four clearly irrelevant files (a private photo, a screenshot, a document addressed
to another company). PDFs and phone photos both, so both reading paths are exercised.

What comes back: one report per run (phase 0 harness), with a page per document: detected
type and confidence, the relevance verdict, the fields read with their page, what would be
created (agreement, obligations, dates, facts), and the score against `labels.json`. Labels can
be added after the first run; the first run is the baseline.

## 10. Open technical checks before phase 1

- Haiku 4.5 on the EU Bedrock inference profile for the classification tier.
- pdf-inspector and AnyDoc prebuilt binaries on Vercel's Node runtime (a spike, not a PR).
- Merge order: #2410, #2411, #2412 before the per-type schemas in phase 3.
