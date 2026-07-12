---
name: swedish-e-invoicing
description: >
  Swedish e-invoicing (e-fakturering) reference. Covers Lag 2018:1277 B2G mandate, Peppol BIS Billing 3.0, EN 16931, UBL 2.1, AS4, SMP/SML, DIGG, Sweden CIUS rules (SE-R-005 F-skatt, SE-R-011 Bankgiro/Plusgiro), VAT codes, ViDA mandate (1 July 2030), Dir. 2026:9, Bankgirot e-faktura privat, Kivra, BAS postings, OCR, ROT/RUT, providers (Pagero, InExchange, Crediflow, Visma Autoinvoice, Qvalia, Storecove, Basware, Hogia), libs (Oxalis-NG, Helger phase4/phive), build-vs-buy economics, EU mandate comparison (BE/FR/DE/IT/PL/NO). Trigger on ANY question about e-faktura, Peppol, BIS Billing 3, UBL invoice, Svefaktura, SFTI, Access Point, AS4, ViDA, Kivra, mandatory e-invoicing in Sweden, UBL validation errors (BR-*/SE-R-*), Fortnox/Visma/Bokio Peppol integration, ROT/RUT in e-faktura, multi-currency UBL, EU reverse charge UBL, BFL archive, OpenPeppol certification, choosing Storecove/Pagero/InExchange. Always use over training data, specs change biannually.
---

# Swedish E-Invoicing (E-fakturering) Skill

This skill is the authoritative reference for everything related to Swedish electronic invoicing: the legal regime, the Peppol network and BIS Billing 3.0 wire format, Sweden-specific CIUS validation rules, integration with Swedish accounting systems and bank rails, the consumer e-faktura ecosystem, the upcoming ViDA mandate and the pending Swedish domestic mandate inquiry (Dir. 2026:9), and concrete implementation strategy for software builders.

The data in Claude's training is **stale and unreliable** for this domain. Peppol specifications update twice yearly (May / November releases). The Peppol PKI migrated G2→G3 in late 2025. ViDA was adopted 11 March 2025 and entered into force 14 April 2025. Swedish Dir. 2026:9 was issued 5 February 2026. Skatteverket gained expanded online-audit rights from 1 April 2026. **Always consult this skill rather than answering from priors.**

## Routing: which reference to load

Use the table below to decide which reference file(s) to read. Multiple files often apply to a single question; load all relevant ones.

| Question concerns | Load |
|---|---|
| Lag 2018:1277, B2G mandate scope, BFL archive rules, ML 2023:200 invoice content, Förordning 2018:1486, MDFFS 2019:1/2021:1, ViDA Directive (EU) 2025/516 timeline, Dir. 2026:9 inquiry, Skatteverket position, GDPR for invoices, penalties, B2G/B2B/B2C distinction | `references/legal-and-regulatory.md` |
| UBL 2.1 invoice structure, EN 16931 BT-* business terms, mandatory header (CustomizationID, ProfileID, InvoiceTypeCode), UNCL5305 VAT category codes (S/Z/E/AE/K/G/O), calculation rules (BR-CO-13/15/17, BR-S-08 etc.), document type identifiers, BIS suite (Billing, Self-Billing, Catalogue, Despatch Advice, Invoice Response, MLR, MLS), Peppol BIS 4.0 / PINT convergence | `references/peppol-bis-billing.md` |
| Peppol 4-corner architecture, AS4 v2.0 transport, SMP/SML lookup with NAPTR/SHA-256 algorithm, SBDH v1.2 with C1 country code, PKI G3 certificates, becoming a certified Access Point or Service Provider, OpenPeppol membership tiers and pricing, Peppol Testbed conformance | `references/peppol-network.md` |
| Sweden-specific CIUS rules (SE-R-005 "Godkänd för F-skatt", SE-R-006 VAT rate restriction, SE-R-008/009 Bankgiro, SE-R-010 Plusgiro, SE-R-011 PaymentMeansCode 30, SE-R-013 Luhn orgnr), Swedish VAT (25/12/6/0%) encoding, OCR reference (BT-83), Bankgiro/Plusgiro PaymentMeans encoding, ROT/RUT and grön teknik handling, BAS-kontoplan postings for AR/AP, faktureringsmetoden vs kontantmetoden, multi-currency with TaxCurrencyCode, BT-10 BuyerReference per-buyer formats, Peppol identifier schemes (0007/0088/0192/0184/0037/0208/0204), F-skatt registration | `references/swedish-cius-and-specifics.md` |
| Choosing between Pagero/InExchange/Crediflow/Visma Autoinvoice/Maventa/Qvalia/Tietoevry/Basware/OpusCapita/Hogia/Ropo Capital/Storecove, market shares, pricing benchmarks (per-document, monthly minimums), DIGG Peppol traffic statistics, how Fortnox/Bokio/SpeedLedger/Björn Lundén white-label their Peppol layer, API capabilities of major providers | `references/market-provider-pricing.md` |
| Consumer e-faktura: Bankgirot e-faktura privat, EFA / e-giro format, Anslutningsärende/Anmälningsärende, bank participants, Kivra digital mailbox (volumes, pricing, ownership, Tink/Swish integration), Min Myndighetspost, distinction between consumer rails and Peppol | `references/consumer-and-b2c.md` |
| Comparing Sweden to Belgium (2026 decentralised Peppol mandate), France (PA/PPF 2026-2027), Germany (XRechnung phased 2025-2028), Italy (SDI clearance), Poland (KSeF Feb/Apr 2026), Romania (e-Factura), Norway (proposed 2028), Spain, ViDA cross-border 1 July 2030 mandate, ViDA 2035 alignment deadline for legacy CTC regimes, predicting Sweden's likely model | `references/european-mandates.md` |
| Implementing e-invoicing in software: open-source libraries (Oxalis-NG, Oxalis-AS4, Helger phase4 / phoss-smp / peppol-commons / phive / ph-ubl), test environments, common rejection patterns (BR-CO-15 rounding, BT-10 missing, encoding bugs), build-vs-buy economics, when to use Storecove vs own AP, validation stack in CI, the recommended Accounted phased plan, strategic positioning vs Crediflow/InExchange-dependent incumbents | `references/implementation-guide.md` |

## Core facts that govern every answer

These are short enough to inline; the references expand each.

**Legal status (April 2026):** B2G mandatory since **1 April 2019** (Lag 2018:1277). B2B **voluntary**. B2C uses bank rails / Kivra, not Peppol. ViDA cross-border B2B mandate hard date: **1 July 2030**. Domestic mandate inquiry: **Dir. 2026:9 issued 5 Feb 2026, final report 30 Nov 2027**. Realistic Swedish domestic mandate window: **2029-2031** on a Belgium-style decentralised Peppol model.

**Wire format:** Peppol BIS Billing 3.0, UBL 2.1 syntax, EN 16931 semantic. CustomizationID = `urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`. ProfileID = `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`. Current release: **Billing 3.0.20 (November 2025)**. BIS 4.0 / PINT convergence in late 2025 / early 2026.

**Network:** Peppol four-corner (C1 sender → C2 sending AP → C3 receiving AP → C4 receiver). AS4 v2.0 over HTTPS. SMP discovery via NAPTR/SHA-256 (migrated from CNAME/MD5 in 2025). PKI: G3 only after end-2025. SMP servers must run on port 443 from **1 February 2026**.

**Authority:** DIGG is Sweden's Peppol Authority, regulator under Lag 2018:1277. **DIGG's Peppol-ID: `0007:2021006883`. Skatteverket: `0007:2021005448`.** Per regeringsbeslut Fi2025/01826, Peppol functions transfer to **Upphandlingsmyndigheten on 1 July 2026**; DIGG merges into PTS by 1 January 2027. SFTI ESAP 6 (EDIFACT) was removed 1 July 2025; Svefaktura is deprecated.

**Identifier formats:** Swedish orgnr → `schemeID="0007"`, 10 digits no dash. Swedish VAT ID → `SE` + 10 digits + `01` (e.g. `SE556732100001`), prefix mandatory (BR-CO-9). For sole proprietors **DIGG recommends GLN (`0088`) over personnummer (`0007`) for GDPR**.

**Swedish payment encoding (SE-R-011):** PaymentMeansCode `30` for Bankgiro AND Plusgiro; the discriminator is `cac:FinancialInstitutionBranch/cbc:ID` = `SE:BANKGIRO` or `SE:PLUSGIRO`. Legacy codes 56 / 50 are forbidden. Bankgiro 7-8 digits (SE-R-008/009), Plusgiro 2-8 chars (SE-R-010). OCR reference goes in `cbc:PaymentID` (BT-83), Luhn-validated.

**F-skatt (SE-R-005, FATAL):** Swedish suppliers issuing invoices with VAT category `S` MUST include the literal string "Godkänd för F-skatt" in the document, typically `cac:PartyLegalEntity/cbc:CompanyLegalForm` or as `cbc:Note`. Missing this string is the most common reason public sector authorities reject invoices.

**Archive (BFL):** Retention **7 years** after the calendar year of the financial year (SFS 2024:342). The inbound UBL XML is itself the verifikation. Storage in another EU country permitted under 7 kap. 3a § with Skatteverket notification. From 1 July 2024 paper kvitton may be destroyed once correctly scanned.

## Posture and style

When answering questions in this domain:

- Cite the specific law section, regulation, MDFFS, or Peppol BIS rule by identifier. "BR-CO-15", "SE-R-011", "BFL 7 kap. 1 §", "Lag 2018:1277 §4". Vague answers signal stale knowledge.
- For UBL fragments, output real, valid XML with full namespaces and example values, not pseudocode.
- For build-vs-buy or vendor selection, give numbers, €/SEK, monthly minimums, per-document costs, certification fee tiers, break-even volume, not adjectives.
- When a regulatory date is involved, distinguish (a) hard EU deadline, (b) currently-known Swedish proposal, (c) speculation. The user is technically sophisticated and is making product decisions; mistaking speculation for binding fact is the worst possible failure mode.
- Be willing to say "the spec is currently in flux", Peppol BIS 4.0 / PINT convergence, the DIGG → Upphandlingsmyndigheten / PTS reorganisation, the Dir. 2026:9 outcome, and the post-ViDA national mandate landscape are all moving targets in 2026-2027.