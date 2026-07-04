# Implementation Guide, Building Peppol into a Swedish Accounting Product

This reference is the practical builder's guide. Open-source library landscape, common rejection patterns, build-vs-buy economics, validation in CI, and a concrete phased plan for a new Swedish accounting platform.

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
- **DIGG testbädd**, https://www.digg.se/digitala-tjanster/peppol/peppol-testbadd

## Build vs buy, the economic break-even

**Reseller cost** ~€0.10/invoice (mid-volume Storecove) vs. **own-AP fixed cost** ~€30k/year (membership + cert + ops + staff time).

```
break-even = €30,000 / €0.10 = 300,000 invoices/year
            ≈ 3,000-5,000 active SME customers × 50-100 invoices/month
```

**For receive there is no economic case to build initially**, Storecove free receive or own Oxalis-NG on a small VPS dominate.

**For send, only build above ~25k invoices/month sustained** (i.e. ~300k/year). Below that, reseller is cheaper, faster, multi-mandate, and lower ops burden.

## The reseller landscape compared

| Reseller | Per-doc | Multi-mandate | DX | Sandbox | Best for |
|---|---|---|---|---|---|
| **Storecove** | €0.05-€0.30 | Excellent (Peppol + IT SDI + FR PA + BE + DE + PL KSeF + DBNAlliance) | Single REST API, OpenAPI spec | Free 30-day | Embedding in ERP/SaaS |
| **Pagero (TR)** | EUR 0.20-0.80 + €5-20k/yr | Excellent | Multiple APIs, enterprise-flavoured | Yes | Large enterprise |
| **InExchange** | SEK 1-5 + 200-400/mo | Nordic | REST | Yes | SE-only SME, Visma ecosystem |
| **Maventa (Visma)** | SEK 0.50-3 | Nordic+ | REST + SOAP | Yes | Visma ecosystem |
| **Galaxy Gateway, Babelway, SBSCon, Comarch, Edicom, Sovos, Avalara, Tradeshift, Basware, Seeburger, Esker** | Various | Excellent | Enterprise-tier | Varies | Multi-mandate enterprise |

## Recommended stack for a new Swedish accounting platform

```
Application core (bookkeeping engine, UI, API)
  → typed UBL/EN 16931 generator (ph-ubl JAXB / xsdata-Python / UblLib.Bis3)
    → local Schematron validator (peppol-bis-invoice-3 + phive-rules)
      → split path:
         RECEIVE: own Oxalis-NG AP (€100/mo Hetzner + €4,400 yr-1 OpenPeppol fees)
         SEND:    Storecove API (until ~25k invoices/month, then own phase4 AP)
```

This hybrid is the dominant strategy:

- **Oxalis-NG receive on day one** is open-source-friendly, scales linearly without per-doc fees, and gives genuine "native Peppol receive" differentiation that incumbents (white-labelling Crediflow/InExchange) cannot match without rebuilding their stack.
- **Storecove send** handles Belgium 2026, France 2026 PA flow, Italy SDI, Germany XRechnung, Poland KSeF in one API, you don't want to be re-implementing FatturaPA.
- **Migrate send to own AP only when volume justifies it**, likely 2028-2029 at the earliest for an early-stage product.

## Critical UX features

1. **Per-buyer BT-10 BuyerReference regex map** for the top 200 Swedish public buyers. Validate at compose time. Prevents 30-day public-sector payment delays.
2. **Free Peppol address out of the box** for every customer, major customer-acquisition lever in a market where competitors charge for Peppol setup.
3. **Inbound triage UI**, parse incoming UBL, show structured fields, propose BAS posting based on supplier history and item descriptions, await user approval.
4. **Multi-mandate send routing**, automatically route based on recipient country (`cbc:Country/cbc:IdentificationCode`) and recipient identifier scheme.

## Phased plan for a new product (12 months)

### Phase 0, today (Month 0)

- Join OpenPeppol as End User (€650 sign-up + €1,250/yr) for forum access and early-warning on spec changes.
- Register a Peppol participant ID for the company itself for dogfooding.
- Set up CI with Helger phive-rules.

### Phase 1, Months 1-3

- UBL generator with full Peppol BIS Billing 3 + Sweden CIUS rules (SE-R-* including F-skatt).
- Storecove sandbox for outbound test.
- Oxalis-NG TEST environment for inbound test.
- Schematron in CI on every UBL output.
- BT-10 regex map for top 100 Swedish myndigheter.

### Phase 2, Months 4-6

- Become Candidate Service Provider (AP-only) with OpenPeppol (~€4,400 one-off + €3,350/year ongoing).
- Pass Conformance Test Suite.
- Sign Service Provider Agreement with DIGG (free).
- Migrate to native Oxalis-NG receive.
- Marketing message: "your customers email PDFs, your suppliers send Peppol e-invoices, both arrive in your inbox."

### Phase 3, Months 7-12

- Multi-mandate readiness for BE/DE/FR/PL/RO destinations through Storecove.
- Per-customer compliance dashboard.
- Begin SMP work (€2,200 + €5,000/yr SMP-only or upgrade to AP+SMP S1).

### Phase 4, Year 2+

- Switch send to own phase4 AP when monthly volume crosses ~25,000.
- Pre-build Skatteverket DRR ingestion behind feature flag for July 2030 activation.
- Pivot on SOU 2027 (due 30 November 2027), adjust architecture if Sweden chooses non-Peppol model.

**Total go-live cost** for a credible, differentiated, open-source native-Peppol Swedish bookkeeping product: **approximately €10-15k plus 3 months engineering**.

## Strategic positioning vs incumbents

The competitive landscape has a hole.

- **Visma eEkonomi, Fortnox, Bokio, SpeedLedger, Björn Lundén** all outsource their Peppol layer to Crediflow or InExchange/Maventa. None differentiate on Peppol-native architecture.
- **The 3.00-3.50 SEK per outbound markup** these vendors charge has a baked-in reseller cost, building native eliminates that markup AND removes dependency risk now visible after the Pagero→Thomson Reuters acquisition.
- **Native Peppol receive as a free out-of-the-box feature**, every customer gets a Peppol address by default, every supplier can send them invoices for free, is a brutal customer acquisition anchor in a market where the SMB end is underserved.
- **The open-source angle is force multiplier**: publishing the UBL generator on GitHub under BSD/MIT earns trust with bookkeeping/Linux-friendly customers without surrendering the moat, which lives in the bookkeeping engine and UX, not the XML serialiser.

Three forces converge to make this strategically valuable:

1. **B2G compliance has been mandatory since April 2019**, any customer with public-sector revenue is a non-starter without native Peppol.
2. **Large-enterprise customers** (Volvo, Ericsson, IKEA-supply, ICA, plus all Belgian/German/French subsidiaries hitting Swedish suppliers from 2026) increasingly require Peppol from suppliers.
3. **ViDA cross-border B2B mandate of 1 July 2030 is non-negotiable**, plus the plausible domestic mandate window of 2029-2031.

The window to build with this advantage is the next **18-24 months** before incumbents finish their own native-Peppol projects.

## Authoritative source list

- Oxalis-NG: https://github.com/OxalisCommunity/oxalis-ng
- Helger phase4: https://github.com/phax/phase4
- peppol-commons: https://github.com/phax/peppol-commons
- Phive-rules: https://github.com/phax/phive-rules
- peppol-bis-invoice-3: https://github.com/OpenPEPPOL/peppol-bis-invoice-3
- Storecove docs: https://www.storecove.com/docs/
- DIGG Peppol testbädd: https://www.digg.se/digitala-tjanster/peppol/peppol-testbadd
- Peppol Testbed: https://peppol.org/tools-support/testbed/
- OpenPeppol membership: https://peppol.eu/who-is-who/openpeppol-membership/