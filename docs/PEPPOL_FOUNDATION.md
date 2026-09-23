# Peppol invoice foundation

Issue #546 requires two separable capabilities:

1. Produce a correctly structured Peppol BIS Billing 3 invoice from Accounted data.
2. Deliver and receive documents through the Peppol network.

The first slice implemented the invoice profile. The second slice added an immutable staged-delivery and audit foundation. Neither of those two slices claimed network delivery; since 2026-08-21 both sending and receiving run over the Peppol network through Qvalia (see the Qvalia and Receiving (PR2) sections below). The sections up to "Access point: Qvalia" describe the foundation those slices left behind and the requirements the Qvalia work had to meet.

## Implemented scope

`GET /api/invoices/{id}/peppol` produces a UBL 2.1 invoice with the Peppol BIS Billing 3 CustomizationID and ProfileID. It is available to an authenticated member of the active company and applies the same explicit `company_id` isolation as other invoice routes.

`POST /api/invoices/{id}/peppol` now stores the exact generated XML as an immutable staged delivery. Staging assigns a stable UUID idempotency key, stores the recipient, profile identifiers, filename, SHA-256, retention date, and an append-only local audit event. It explicitly returns `network_submitted: false`. Repeating the request for the same invoice and XML returns the existing staged record.

`GET /api/invoices/{id}/peppol/deliveries` returns a minimized status timeline projection without exposing XML, raw webhooks, or provider evidence. The invoice page can prepare a delivery; since 2026-08-21 its send control performs the network send through `POST /api/invoices/{id}/peppol/send` for companies holding a Peppol access grant (aktiebolag senders, standard invoices only; see "Access point: Qvalia" below).

The provider-neutral `PeppolTransport` boundary separates:

- recipient lookup and advertised document/process capabilities;
- idempotent submission and provider correlation;
- cryptographically verified webhook normalization;
- evidence retrieval, including an optional exact transmitted document.

Core registers an adapter only when provider credentials are present in the environment (`src/lib/init.ts`); no environment value can make an absent adapter appear available.

The export supports:

- numbered standard sales invoices, not credit notes, self-billing, proformas, or delivery notes;
- Swedish limited-company sellers and organization-number buyers identified with scheme `0007`;
- SEK invoices with Swedish standard VAT categories at 6, 12, or 25 percent;
- Bankgiro or Plusgiro credit transfers using payment means code `30` and an OCR reference;
- mixed supported VAT rates, text-line omission, and UNECE unit mappings for Accounted's invoice units;
- Accounted's SEK rounding as `PayableRoundingAmount`;
- buyer reference, address, VAT, F-tax, payment, totals, and line reconciliation checks;
- deterministic UTF-8 XML download from the invoice detail page.

Unsupported input is rejected with structured, field-addressable errors. The generator never emits partial XML after a failed preflight.

Sole-trader sellers and personnummer-derived `0007` identifiers are rejected. They require a separately configured `0088` GLN so the export does not publish personal identity data as a Peppol participant identifier.

The local preflight is not a replacement for the official validation stack. Before network delivery, every document must pass the UBL XSD, EN 16931 Schematron rules, and the Peppol BIS Billing rules for the active release. The selected access-point provider must perform that validation as part of submission. Accounted should also run the same release-pinned artifacts before calling the provider so failures can be explained before transport.

## Remaining architecture

The subsections below are the requirements written before the Qvalia decision. Access-point delivery and the UI send flow shipped on 2026-08-21 and are described under "Access point: Qvalia"; the text is kept as the acceptance criteria that work met. Standards validation (the release-pinned validator run before transport) is still open.

### Standards validation

Pin and execute the official release artifacts from OpenPeppol and the EN 16931 validation artifact registry. The November 2025 release is the active production release at implementation time. The May 2026 release becomes mandatory on 17 August 2026, so provider onboarding and conformance testing must target the May 2026 validator before launch.

Validation must return stable rule identifiers, severity, source path, and localized remediation. Provider validation responses are useful evidence but must not become Accounted's only explanation layer.

### Access-point delivery

Accounted should integrate with a certified Peppol access-point provider. The provider owns AS4 transport, Peppol PKI, service metadata lookup, certificate rotation, and network conformance. Accounted should not implement an access point itself.

A provider adapter needs at least:

- recipient capability lookup by scheme and identifier;
- invoice submission with an Accounted idempotency key;
- a provider document identifier;
- synchronous rejection details;
- authenticated webhooks or polling for final transport status;
- test and production environments with equivalent validation behavior.

The existing email delivery model cannot honestly represent Peppol receipts. The Peppol-specific model therefore records `staged`, recipient lookup, submission acceptance, Corner 3 transport success, recipient acknowledgement, and business acceptance or rejection separately. Every verified raw event remains append-only even when it is duplicated or arrives out of order. The latest normalized status is only a projection.

### Status and audit handling

The Peppol-specific tables now preserve the exact staged XML, its SHA-256 hash, recipient scheme and identifier, provider and tenant correlation, attempt timestamps, normalized status, raw verified event metadata, immutable failure history, and retrieved evidence. A successful API acceptance is not the same as Corner 3 transport, and Corner 3 transport is not the same as buyer acknowledgement or business acceptance.

Provider event and evidence RPCs are service-role only. Future webhook routes must first use the selected adapter to authenticate and normalize the provider payload, then persist the verified event. A public webhook endpoint is intentionally not exposed before its authentication contract is known.

No invoice status should change merely because XML was generated or accepted by a provider. The send workflow must define exactly which provider receipt constitutes delivery, how retries preserve idempotency, and how a permanent rejection is shown without mutating the posted invoice.

### Receiving

Inbound invoices are a separate acceptance slice. It requires provider webhook authentication, raw XML retention, duplicate detection, supplier matching, safe attachment handling, and mapping into the supplier-invoice inbox without treating received content as trusted. The original foundation did not claim inbound support; that slice has since shipped (`peppol_registrations`, `peppol_inbound_documents`, the inbound cron and inbox delivery) and is described under "Receiving (PR2)" below.

### UI and API

The UI downloads a locally checked XML file and can prepare an immutable delivery snapshot. Both actions state that they did not send the invoice. Once an adapter exists, sending must be a distinct confirmation flow that performs recipient lookup, shows the discovered participant and capabilities, and records the resulting timeline. The download remains available for diagnosis and interoperability testing. Shipped 2026-08-21: the confirmation dialog on the invoice page and `POST /api/invoices/{id}/peppol/send` (see "Access point: Qvalia").

### Access point: Qvalia (decided 2026-08-21)

The contract with Qvalia (certified Swedish Access Point + SMP, partner model) was signed on 2026-08-21. The adapter lives in `src/lib/invoices/transports/qvalia.ts` and implements the `PeppolTransport` boundary:

- recipient lookup: `GET /partner/{partnerRegNo}/peppol/lookup/{scheme:id}?docTypeRoot=Invoice`;
- submission: `POST /partner/{partnerRegNo}/transaction/{accountRegNo}/invoices/outgoing` with the staged UBL XML (`content-type: application/xml`); the returned `integrationId` is the provider submission id; a `409` (same document id and receiver) is recovered to the existing `integrationId` only when Qvalia's stored copy carries the same seller endpoint, otherwise it stays a duplicate error;
- webhooks: `POST /api/webhooks/peppol/qvalia`, authenticated by the shared secret Accounted configures as Qvalia's outbound auth header (Qvalia did not sign webhooks when the adapter was built; see the September update below); the same event can arrive more than once and is deduplicated on `eventType + globalTransactionId + status.status`; `status.status` is declared free text, so the mapping is tolerant and unknown wording never advances beyond `submission_accepted`;
- evidence: the message-log status and Qvalia's stored XML copy, recorded as `qvalia_message_record`.

#### Qvalia API update (docs re-read 2026-09-21)

Qvalia reworked the parts of its API that the notes above, and the pre-contract comparison further down, called out as missing. What its documentation states now ([webhooks](https://api.qvalia.io/api-documentation/apis/partner-api/webhooks), [webhook payload](https://api.qvalia.io/api-documentation/apis/partner-api/webhooks/webhook-payload)); read from the docs, not yet exercised by our adapter:

- Signed webhooks: HMAC-SHA256 in `X-Qvalia-Signature: t=<unix>,v1=<hex>` over `<t>.<raw body>`, with `X-Qvalia-Event-Id` for replay protection (recommended tolerance 5 minutes). The first `PUT .../webhook/configure` returns the `signingSecret` once; rotation through `POST .../webhook/{id}/secret` keeps the old secret valid for an overlap (default 24 h).
- Event payload: a documented schema with `eventId` (the dedupe key, stable across redeliveries), `occurredAt` (order by this, arrival order is not guaranteed), `integrationId`, `globalTransactionId`, `direction`, `status` and `peppol_metadata`. A fourth event type, `document_delayed`, reports a Peppol send that is being retried.
- Status values: `pending`, `delayed` and `warning` are non-terminal; `processed`, `processed_with_warning` and `error` are terminal. The field is still declared free text, so unknown wording must keep meaning "no change".
- Idempotent submission: an `Idempotency-Key` request header; a repeat within 24 hours returns the original response with the original `integrationId`. Per Qvalia (2026-09-18) it is live in the test environment. A duplicate document id and receiver still answers `409` (`?overwrite=true` replaces the document).
- Authentication and environments: the docs now show the bare key in `Authorization: <key>` (what the sandbox always accepted) and name two environments, `api.qvalia.com` and `api-test.qvalia.com`.
- Errors: one JSON envelope (`status`, `type`, `data`, `metadata`); branch on `type`, which is stable.
- By design, per Qvalia: `integrationId` appears in several places of a response, always with the same value; `readinvoices` acknowledges and marks documents read, while the plain incoming endpoint with `includeRead=true` does not. Still under review on their side: the last error-envelope variants and normalizing document types from SMP lookups (the adapter keeps reducing SMP service URLs to the bare identifier).
- Webhook availability: per Qvalia (2026-09-18) live for partner accounts, general availability in the API within two weeks. Not re-tested by us against the production host since the 404 on 2026-08-21.

One limit is explicit in the same docs and shapes our design: a failed webhook delivery (non-2xx, 10 s timeout, unreachable endpoint) is not retried, and a missed event is lost. The status poll below therefore stays as the safety net even after webhooks are switched on.

Adapter follow-ups (not built): verify `X-Qvalia-Signature` instead of the shared-secret header, dedupe on `eventId`, send `Idempotency-Key` on submit, handle `document_delayed`, and treat the documented terminal `error` status as final.

Configuration is environment-only (`PEPPOL_TRANSPORT_PROVIDER=qvalia` plus `QVALIA_API_KEY`, `QVALIA_PARTNER_REG_NO`, `QVALIA_BASE_URL`, `QVALIA_WEBHOOK_SECRET`, optional `QVALIA_ACCOUNT_REG_NO`, `QVALIA_WEBHOOK_HEADER`, `QVALIA_AUTH_SCHEME`; see `.env.example`). `src/lib/init.ts` registers the adapter when the credentials are present; the product only sends when the provider is also selected. `scripts/peppol/qvalia-probe.ts` is the first-contact probe against the sandbox (auth scheme, child accounts, registered Peppol IDs, lookup, send).

`POST /api/invoices/{id}/peppol/send` performs the send: stage the exact XML, look up the recipient, record `recipient_verified` and `submitting`, submit, record `submission_accepted` with the provider submission id, and only then issue a draft with the mark-sent semantics (`issueAndBookInvoice`: F-number, status, verifikat under faktureringsmetoden, PDF archived as underlag). A synchronous rejection is recorded as a terminal `failed` event so the identical document is never re-sent; an operational failure is `retryable_failure` and a retry is allowed. Resending an exact XML that already carries a provider submission id is an idempotent replay, never a second transmission.

v1 uses Qvalia's consolidated setup (every company's documents under Accounted's partner account, `accountRegNo = partnerRegNo`). Qvalia confirmed (2026-08-21) that the sending account is irrelevant as long as `AccountingSupplierParty` carries a valid endpoint id, so no per-company child accounts are needed.

### Receiving (PR2)

- `peppol_registrations`: one live row per company and per participant; written by `POST/DELETE /api/settings/peppol` (service role after the membership check) through `src/lib/invoices/peppol-registration.ts`, which publishes `0007:orgnr` with the company's business card and the BIS Billing 3 Invoice + CreditNote document types via `transport.registerRecipient()`. Personnummer-based identifiers are refused (`0088` GLN pending). The switch lives in Settings > Fakturering ("E-faktura via Peppol").
- `peppol_inbound_documents`: every document the Access Point hands us, with the exact XML (immutable, undeletable) and the provider's UBL-JSON; routed to a company by the `AccountingCustomerParty` endpoint through the registrations; states `received`, `routed`, `unrouted`, `converted`, `ignored`, `failed`.
- `GET /api/peppol/inbound/cron` every 10 minutes: `src/lib/invoices/peppol-inbound.ts` lists unread invoices and credit notes, archives (`archiveInboundPeppolMessage`), routes and delivers; `src/lib/invoices/peppol-inbox-delivery.ts` archives the XML as a WORM document (`upload_source: 'e_invoice'`, no AI extraction), the embedded PDF when present, and creates the `invoice_inbox_items` row (`source: 'peppol'`) with the extraction filled from the structured UBL (`src/lib/invoices/peppol-inbound-ubl.ts`, confidence 1). The existing inbox review and convert flows take over from there.
- Outbound status without webhooks: `GET /api/peppol/outbound/status/cron` (four times an hour) asks the Access Point about every open delivery (`transport.pollDeliveryStatus`, Qvalia: `/invoices/outgoing/status`) and records the answer through the same lifecycle RPC a webhook uses, with the same dedupe key, so a later webhook for the same transition is a harmless duplicate. Built because Qvalia's webhook API answered 404 on its production host on 2026-08-21 (Qvalia reports it live for partner accounts since September); kept as the safety net regardless, since Qvalia does not retry a failed webhook delivery.
- Still open: the Qvalia `new_document` webhook for inbound (today polled), credit-note conversion from the inbox, `0088` GLN for enskild firma, the release-pinned validation stack, and a UI surface for `unrouted` documents.

### Storecove versus Qvalia (historical, pre-contract)

Storecove is the stronger fit for the lifecycle already modeled. Its official API documents recipient discovery, caller-supplied `idempotencyGuid`, a returned submission `guid`, tenant correlation, asynchronous sending webhooks, and a dedicated evidence endpoint. Its sandbox supports webhook simulation and the OpenPeppol test network. A Storecove adapter still requires a commercial contract and credentials; these public semantics do not prove Accounted's tenant is authorized or onboarded.

Qvalia is a Swedish certified Access Point and SMP with an explicit partner and multi-tenant offering. Its public quick start documents production and sandbox endpoints, account registration numbers, and separate keys. As of August 2026, public material did not specify a Storecove-equivalent contract for idempotency, signed webhooks, event ordering, or exact transmitted-document evidence. Those points had to be obtained from Qvalia Sales or Support before an adapter could be production quality.

Superseded 2026-09-21: Qvalia has since documented an idempotency key, HMAC-signed webhooks with replay protection, an event id and `occurredAt` for ordering, and terminal versus non-terminal statuses (see "Qvalia API update" above). The gap this paragraph describes no longer separates the two providers; what remains different is that Qvalia does not retry a failed webhook delivery.

Inputs required for either selection:

- multitenant or reseller authorization for Accounted customer companies;
- setup, monthly, per-document, inbound, lookup, and support pricing;
- test and production API credentials and secret rotation;
- sender-only versus searchable participant registration;
- Swedish organization-number and optional GLN onboarding;
- webhook signing, retention, service levels, and data-processing terms;
- support for the mandatory May 2026 Peppol release.

Additional API contract inputs required before implementation:

- the external tenant, legal entity, and account identifiers for every Accounted company;
- exact discovery request and response semantics for `0007` and `0088` participants;
- idempotency retention, duplicate response behavior, and retry guarantees;
- webhook signature or authentication scheme, secret rotation, replay window, event identifiers, retry policy, and ordering guarantees;
- exact meanings of transport, acknowledgement, acceptance, rejection, and terminal events;
- evidence endpoint response, retention, exact-document guarantees, and audit export format;
- sandbox participant IDs, production onboarding checks, and agreed conformance acceptance tests.

Provider credentials and prices are external operational inputs. They are not invented, stored in source, or represented by a fake provider in this change.

## Primary specifications and authority guidance

- [OpenPeppol BIS Billing 3, November 2025](https://docs.peppol.eu/poacc/billing/3.0/2025-Q4/)
- [OpenPeppol BIS Billing 3, May 2026](https://docs.peppol.eu/poacc/billing/3.0/upcoming/)
- [OpenPeppol post-award release schedule](https://peppol.org/documentation/technical-documentation/post-award-documentation/)
- [European Commission EN 16931 validation artefacts](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/Registry+of+supporting+artefacts+to+implement+EN16931)
- [SFTI Peppol BIS Billing 3 guidance](https://www.sfti.se/sfti/standarder/peppolbisochpeppolinfrastruktur/peppolbisbilling3.26609.html)
- [Swedish authority guidance for connecting to Peppol](https://www.upphandlingsmyndigheten.se/inkopsprocessen/e-handel/peppol/anslut-till-peppol/)
- [Storecove API documentation](https://www.storecove.com/docs/)
- [Qvalia API quick start](https://api.qvalia.io/quick-start)
- [Qvalia API environments and formats](https://api.qvalia.io/api-documentation/apis)
- [Qvalia partner API and Peppol infrastructure](https://qvalia.com/help/overview-of-qvalias-partner-api-and-peppol-infrastructure/)
