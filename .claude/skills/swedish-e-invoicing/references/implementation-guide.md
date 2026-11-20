---
audience: developer
---

# Implementation Guide, Building Peppol into a Swedish Accounting Product

This reference is the practical builder's guide. Open-source library landscape, common rejection patterns and validation in CI.

## Contents

- Open-source library landscape
- Common rejection patterns, the high-yield checklist
- Validation in CI
- Critical UX features
- Authoritative source list

## Open-source library landscape

The **Java ecosystem dominates Peppol**. Most production stacks are JVM.

### Java, the canonical stack

- **Oxalis** (https://github.com/OxalisCommunity/oxalis), originally Norwegian. **Oxalis 6.x is end-of-life Dec 2025.**
- **Oxalis-NG** (https://github.com/OxalisCommunity/oxalis-ng), successor, Apache 2.0. Build on this.
- **Oxalis-AS4 7.x** (https://github.com/OxalisCommunity/oxalis-as4).
- **Helger phase4** (https://github.com/phax/phase4), Apache 2.0 AS4 client + server. Most comprehensive alternative to Oxalis.
- **Helger phoss-smp**, production-grade SMP server.
- **Helger peppol-commons**, identifiers, codelists, SBDH, SMP/SML clients.
- **Helger phive + phive-rules**, validation engine and pre-built rules (Schematron compiled to fast XSLT).
- **Helger ph-ubl, ph-cii, ph-sbdh**, JAXB models for UBL 2.1, UN/CEFACT CII, SBDH v1.2.
- **phase4-peppol-standalone**, Spring Boot 3 reference implementation. Template, not turn-key.

Trust stores updated to **G3-only late 2025**. Verify version when integrating.

### Python

- **invoice-x**, UBL/CII generation.
- **drafthorse**, Factur-X (relevant for German/French cross-border).
- **lxml** + Schematron-via-saxon-HE for validation.
- **No production-grade AS4**, bridge to Java via subprocess, container, or REST microservice.

### JavaScript / TypeScript

- **No mature library.** Generate types from UBL 2.1 XSDs (`xsdata`, `xsd2ts`, `xmlbuilder2`) and validate via Schematron-as-WASM or call out to Java. Most TS shops use Storecove or another reseller for this reason.

### .NET

- **`UblLib.Bis3`**, UBL Peppol BIS 3 generation/parsing.
- Several commercial SDKs (Storecove, Pagero).
- Microsoft Dynamics has built-in BIS 3.0 support.

## Common rejection patterns, the high-yield checklist

The seven failure modes that cause **80% of production rejections**:

1. **BR-CO-15 rounding mismatches** between line totals and tax-inclusive totals. Always use BigDecimal/Decimal with explicit scale; round at the boundary, never in intermediate steps.
2. **VAT category code rule violations**, mixing `S` lines with a `Z` summary, or `AE` without `VATEX-EU-AE` reason code.
3. **Missing or malformed BT-10 BuyerReference** for Swedish public sector, each authority has its own format. Maintain a per-buyer-Peppol-ID regex map and validate at compose time.
4. **EndpointID `schemeID` mismatch** with what's published in the receiver's SMP. Verify via Peppol Lookup Service before sending.
5. **Date format errors**, UBL requires `YYYY-MM-DD` xs:date.
6. **Decimal separator and locale serialisation bugs**, period only, no thousand separators, `Locale.ROOT` / `InvariantCulture`.
7. **Swedish character encoding**, UTF-8 throughout. Many ERPs still serialise å/ä/ö with Windows-1252.

Plus:

- **SBDH C1 country code mandatory since January 2024.**
- **Attachments via `cbc:EmbeddedDocumentBinaryObject` should stay under 10 MB** despite the formal 100 MB AS4 ceiling.
- **Multi-currency requires `TaxCurrencyCode` plus a SEK-equivalent BT-111** in a second `TaxTotal`.
- **Missing F-skatt declaration (SE-R-005)** is the single most common Swedish rejection.
- **Forbidden PaymentMeansCode 56 / 50** instead of 30 with `SE:BANKGIRO` / `SE:PLUSGIRO`.

## Validation in CI

Three-layer validation, in this order:

```
[XSD] → [EN 16931 Schematron] → [PEPPOL-EN16931-UBL.sch with SE-R-* overlay]
```

**Run all three on every UBL artifact in CI.** Use Helger phive-rules or run Schematron via Saxon-HE.

```bash
# Example: Helger CLI
java -jar phive-rules-peppol-billing-3-cli.jar \
    --rule "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0" \
    invoice.xml
```

**Validate at three points** in your pipeline:
1. Immediately after UBL generation locally, fail fast.
2. Before handoff to the Access Point, last chance before AS4 transmission.
3. On receive in your inbound flow before bookkeeping, catches malformed inbound from less-strict APs.

Many AP rejections happen post-send when the receiver's MLR comes back hours later, front-load validation aggressively.

### Test environments

- **Peppol Test Network**, `acc.edelivery.tech.ec.europa.eu` SML zone. Free for OpenPeppol members.
- **Helger Peppol Practical**, https://peppol.helger.com, REST + UI validator.
- **Storecove peppolvalidator.com**, error code lookup.
- **EC DG GROW eInvoicing validator**, https://itb.ec.europa.eu/invoice
- **Norwegian validator**, https://anskaffelser.no/verktoy/validator (also useful for Sweden).
- **SFTI Validex**, https://sfti.validex.net/ (DIGG's Peppol testbädd was discontinued in the 2026 handover)

## Critical UX features

1. **Per-buyer BT-10 BuyerReference regex map** for the top 200 Swedish public buyers. Validate at compose time. Prevents 30-day public-sector payment delays.
2. **Free Peppol address out of the box** for every customer.
3. **Inbound triage UI**, parse incoming UBL, show structured fields, propose BAS posting based on supplier history and item descriptions, await user approval.
4. **Multi-mandate send routing**, automatically route based on recipient country (`cbc:Country/cbc:IdentificationCode`) and recipient identifier scheme.

## Authoritative source list

- Oxalis-NG: https://github.com/OxalisCommunity/oxalis-ng
- Helger phase4: https://github.com/phax/phase4
- peppol-commons: https://github.com/phax/peppol-commons
- Phive-rules: https://github.com/phax/phive-rules
- peppol-bis-invoice-3: https://github.com/OpenPEPPOL/peppol-bis-invoice-3
- Storecove docs: https://www.storecove.com/docs/
- SFTI Validex verification service: https://sfti.validex.net/
- Peppol Testbed: https://peppol.org/tools-support/testbed/
- OpenPeppol membership: https://peppol.eu/who-is-who/openpeppol-membership/