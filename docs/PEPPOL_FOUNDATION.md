# Peppol invoice foundation

Issue #546 requires two separable capabilities:

1. Produce a correctly structured Peppol BIS Billing 3 invoice from Accounted data.
2. Deliver and receive documents through the Peppol network.

This change implements the first capability for a deliberately constrained Swedish invoice profile. It does not claim network delivery.

## Implemented scope

`GET /api/invoices/{id}/peppol` produces a UBL 2.1 invoice with the Peppol BIS Billing 3 CustomizationID and ProfileID. It is available to an authenticated member of the active company and applies the same explicit `company_id` isolation as other invoice routes.

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

The existing email delivery model cannot honestly represent Peppol receipts. Provider selection should precede the database design because provider status vocabularies and webhook guarantees determine the durable state machine.

### Status and audit handling

After provider selection, add a migration and pg-real tests for a Peppol-specific delivery record. It should preserve the exact submitted XML, its SHA-256 hash, recipient scheme and identifier, provider id, attempt timestamps, normalized status, raw receipt metadata, and immutable failure history. A successful API acceptance is not the same as network delivery.

No invoice status should change merely because XML was generated or accepted by a provider. The send workflow must define exactly which provider receipt constitutes delivery, how retries preserve idempotency, and how a permanent rejection is shown without mutating the posted invoice.

### Receiving

Inbound invoices are a separate acceptance slice. It requires provider webhook authentication, raw XML retention, duplicate detection, supplier matching, safe attachment handling, and mapping into the supplier-invoice inbox without treating received content as trusted. Nothing in this foundation claims inbound support.

### UI and API

The current UI downloads a locally checked XML file and states that it was not sent. Once delivery exists, sending should be a distinct confirmation flow that performs recipient lookup, shows the discovered recipient, and records the resulting delivery timeline. The download should remain available for diagnosis and interoperability testing.

### Credentials and commercial decision

Emil must choose and contract a certified access-point provider before full send or receive can be completed. The decision needs verified answers for:

- multitenant or reseller authorization for Accounted customer companies;
- setup, monthly, per-document, inbound, lookup, and support pricing;
- test and production API credentials and secret rotation;
- sender-only versus searchable participant registration;
- Swedish organization-number and optional GLN onboarding;
- webhook signing, retention, service levels, and data-processing terms;
- support for the mandatory May 2026 Peppol release.

Provider credentials and prices are external operational inputs. They are not invented, stored in source, or represented by a fake provider in this change.

## Primary specifications and authority guidance

- [OpenPeppol BIS Billing 3, November 2025](https://docs.peppol.eu/poacc/billing/3.0/2025-Q4/)
- [OpenPeppol BIS Billing 3, May 2026](https://docs.peppol.eu/poacc/billing/3.0/upcoming/)
- [OpenPeppol post-award release schedule](https://peppol.org/documentation/technical-documentation/post-award-documentation/)
- [European Commission EN 16931 validation artefacts](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/Registry+of+supporting+artefacts+to+implement+EN16931)
- [SFTI Peppol BIS Billing 3 guidance](https://www.sfti.se/sfti/standarder/peppolbisochpeppolinfrastruktur/peppolbisbilling3.26609.html)
- [Swedish authority guidance for connecting to Peppol](https://www.upphandlingsmyndigheten.se/inkopsprocessen/e-handel/peppol/anslut-till-peppol/)
