# Legal and Regulatory Framework, Swedish E-Invoicing

## Swedish primary legislation

### Lag (2018:1277) om elektroniska fakturor till följd av offentlig upphandling

The operative statute. SFS 2018:1277, in force **1 April 2019**, amended SFS 2023:212 to update VAT-law cross-references to ML 2023:200.

- **§1 Scope.** Covers all invoices issued as a consequence of procurement under LOU 2016:1145, LUF 2016:1146, LUK 2016:1147 and LUFS 2011:1029. The trigger is "consequence of public procurement", not the identity of buyer or seller.
- **§2 Definition.** An e-invoice is an invoice issued, sent and received in a *structured electronic format that allows automatic and electronic processing*. **PDF and scanned paper are explicitly excluded.** Image-based formats fail the definition regardless of how they are transmitted.
- **§4 Standard.** EN 16931 conformance via Commission Implementing Decision (EU) 2017/1870. Parties may bilaterally agree on alternative standards.
- **§5 Reception duty.** Contracting authorities must receive and process EN 16931 invoices.
- **§7 Sanctions.** **DIGG can issue *vitesföreläggande* (penalty injunctions)** against non-compliant suppliers. The amount is set discretionarily.
- **§8 Appeals.** Appeals go to allmän förvaltningsdomstol; prövningstillstånd required for kammarrätten.

Source: https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-20181277-om-elektroniska-fakturor-till_sfs-2018-1277/

### Förordning (2018:1486)

Designates **DIGG (Myndigheten för digital förvaltning)** as supervising authority and Sweden's Peppol Authority. Source: https://www.digg.se/kunskap-och-stod/e-handel/lag-forordning-och-foreskrifter-for-e-handel

### MDFFS 2019:1 (Föreskrift om registrering i PEPPOL)

In force **1 December 2019**. Requires all contracting authorities to publish themselves in Peppol's SMP (Service Metadata Publisher) registry.

### MDFFS 2021:1

§§12-20 require state agencies to:
- use Peppol BIS Billing 3 for outbound invoices to other state agencies;
- send e-invoices to non-state recipients that have consented;
- handle inbound e-invoices in EN 16931 conformance.

### Förordning (2000:606) §21f and Förordning (2003:770)

Have required state agencies to handle invoices and orders electronically since 2008/2014. Per **SFS 2025:1201, regulatory authority over Förordning 2000:606 transfers from ESV to Statskontoret on 1 January 2026**.

### Bokföringslag (1999:1078), archive rules

Most recent consolidation: SFS 2024:342, in force **1 July 2024**. Modernised the archive regime for digital räkenskapsinformation.

- **7 kap. 1 § / 7 kap. 2 §.** Räkenskapsinformation must be stored in the form in which it was created or received. **The inbound UBL XML is itself the verifikation; a printout is not.**
- **7 kap. 2 § (post-2024).** Retention is **7 years** after the calendar year in which the financial year ended. (Reduced from the historical 10 years.)
- **7 kap. 3 §.** Equipment to read electronic data must remain available *in Sweden* throughout retention.
- **7 kap. 3a §.** Electronic storage in another EU country is permitted if (a) Skatteverket is notified, (b) immediate online access is granted, and (c) printouts can be produced in Sweden upon request.
- **5 kap. 5 §.** Immutable bookkeeping, corrections are new posts, never overwrites.
- **4 kap. 4 §.** Language: Swedish, Danish, Norwegian or English.
- **Post-2024-07-01 change:** the prior requirement to retain paper originals for 3 years post-digitisation has been **abolished**. Paper kvitton may be destroyed once correctly scanned.

### Mervärdesskattelag (2023:200), invoice content

Replaces ML 1994:200 since 1 July 2023.

- **2 kap. 9-10 §§.** Defines the e-invoice consistent with Article 217 of Directive 2006/112/EC.
- **17 kap.** Mandatory invoice content, implements Article 226 of the VAT Directive.
- **SKVFS 2024:16.** Simplified invoices (förenklad faktura).
- **No qualified electronic signature is required.** Authenticity and integrity are ensured via "business controls creating a reliable audit trail" per Article 233 of Directive 2006/112/EC. The Peppol AS4 message-level signing between Access Points is sufficient.

### Skatteverket online audit rights, 1 April 2026

Pending legislation removed the historical ban on remote audit access. **From 1 April 2026, Skatteverket has expanded "online audit" rights**, direct read access to taxpayers' digital accounting/VAT records during audit. **This is access-rights legislation, not a SAF-T submission mandate.** Sweden does not yet require periodic SAF-T submission.

## EU framework

### Directive 2014/55/EU and EN 16931

- Directive 2014/55/EU, transposition deadline 27 November 2018.
- Commission Implementing Decision (EU) 2017/1870 anchors EN 16931 as the European e-invoicing semantic.
- **EN 16931-1**: syntax-agnostic semantic data model, BT-1…BT-150+ business terms, BG-1…BG-25 business groups.
- **EN 16931-2**: binds two normative syntaxes: **UBL 2.1** (ISO/IEC 19845:2015) and **UN/CEFACT CII** (D16B).
- Peppol BIS Billing 3.0 is a **CIUS** (Core Invoice Usage Specification) of EN 16931 in UBL syntax only. CII is permitted at the Peppol layer but not in BIS Billing 3.0.

### ViDA, VAT in the Digital Age

Adopted by ECOFIN on **11 March 2025** as three legal acts:
- **Council Directive (EU) 2025/516**
- **Regulation (EU) 2025/517**
- **Implementing Regulation (EU) 2025/518**

Published in OJEU 25 March 2025, in force **14 April 2025**, transposition deadline **31 December 2026**.

Binding dates relevant for Sweden:

| Date | Obligation |
|---|---|
| 14 Apr 2025 | Member states may mandate domestic B2B e-invoicing without Article 395 derogation, provided EN 16931-based; recipient consent abolished |
| 1 Jul 2030 | **Mandatory structured e-invoicing + Digital Reporting Requirements (DRR) for cross-border intra-EU B2B**; recapitulative VIES statements abolished; invoice issuance ≤10 days after chargeable event |
| 1 Jan 2035 | Pre-existing national clearance regimes (IT/FR/PL/RO/HU/ES) must align to the EU DRR standard |

**Sweden has no pre-existing CTC, so Sweden does NOT get the 2035 grandfather clause.** Any new domestic mandate Sweden builds post-2025 must already be EN 16931-compliant by design.

## Swedish authorities

### DIGG (Myndigheten för digital förvaltning)

- Sweden's Peppol Authority.
- Regulator under §7 of Lag 2018:1277.
- Issues binding föreskrifter MDFFS 2019:1 and MDFFS 2021:1.
- DIGG's own Peppol-ID: `0007:2021006883`.
- **Reorganisation alert:** Per regeringsbeslut Fi2025/01826, DIGG's e-handel/Peppol functions transfer to **Upphandlingsmyndigheten on 1 July 2026**. DIGG itself is to be merged into PTS by 1 January 2027 forming a new digitalisation agency. Adjust regulatory monitoring accordingly.

### Skatteverket

- Receives e-invoices via Peppol at `0007:2021005448`.
- Publicly **in favour** of mandatory domestic B2B e-invoicing and transaction-based reporting.
- Ran a public consultation June-July 2025 on three models (SAF-T, clearance, post-audit-with-real-time-reporting).
- Estimates **SEK 10-20 billion/year** in business savings if Sweden mandates domestic e-invoicing.
- Sektionschef Björn Erling has explicitly endorsed Peppol as the future Swedish standard.

### ESV (Ekonomistyrningsverket) and Statskontoret

- ESV historically drove state e-invoicing since 2008 (Förordn. 2000:606 §21f).
- Per SFS 2025:1201, regulatory authority transfers to **Statskontoret on 1 January 2026**.

### SFTI (Single Face To Industry)

- Collaboration between SKR (Sveriges Kommuner och Regioner), DIGG, Upphandlingsmyndigheten and Kammarkollegiet.
- Sets the recommended Swedish standards.
- **From 1 July 2025: SFTI ESAP 6 (EDIFACT) was removed; Svefaktura 1.0/2.0 and SFTI Fulltextfaktura are formally deprecated; Peppol BIS Billing 3 is the only strategic format.**

### Government inquiry Dir. 2026:9, the single most important date

**Kommittédirektiv Dir. 2026:9** "Moderniserad och brottsförebyggande hantering av mervärdesskatt" was issued **5 February 2026** with a final report deadline of **30 November 2027**.

The inquiry will determine:
- whether Sweden mandates domestic B2B e-invoicing;
- whether Sweden adopts transaction-based reporting (DRR-style or otherwise);
- the architectural model (decentralised Peppol vs. centralised clearance vs. post-audit with real-time reporting).

**Realistic Swedish trajectory:** SOU report 30 November 2027 → lagrådsremiss/proposition 2028 → first domestic obligations **2029-2030** (likely receive obligation first, send obligation phased by entity size, mirroring Germany's 2025/2027/2028 rollout). The reference design Sweden will mirror is **Belgium's 2026 decentralised Peppol 4-corner model**, eventually augmented with a 5-corner DRR layer where Skatteverket becomes Corner 5.

## Penalties and the B2G/B2B/B2C distinction

| Segment | Status (April 2026) | Format | Penalty |
|---|---|---|---|
| **B2G** (consequence of public procurement) | Mandatory since 1 April 2019 | EN 16931 / Peppol BIS Billing 3 | DIGG vitesföreläggande, discretionary fine; practical risk also: lost public-sector business |
| **B2G** (state-to-state, state-to-private with consent) | Mandatory | Peppol BIS Billing 3 | Internal compliance |
| **B2B** | **Voluntary** | Free choice (Peppol BIS dominant; legacy Svefaktura tolerated bilaterally) | None |
| **B2C** | Voluntary | Bank rails / Kivra (not Peppol) | None |

## GDPR for e-invoicing

- Invoices to natural persons and sole proprietors contain personal data.
- **DIGG recommends sole proprietors use a GLN identifier (ICD `0088`) rather than a personnummer-based Peppol-ID (`0007`)** to minimise exposure of the personnummer in routing metadata visible across the network.
- Lawful basis is Article 6(1)(c) (legal obligation under BFL/ML/Lag 2018:1277).
- The 7-year BFL retention overrides Article 5(1)(e) storage limitation.
- **Access points act as Article 28 processors.** DPAs are required between sending business and its AP, and between recipient and its AP.
- Cross-border Peppol routing within EEA is not a Chapter V transfer; care is needed if an AP routes via non-EEA infrastructure (some APs use US/UK clouds).
- From 1 April 2026, the Skatteverket online-audit power requires architecting a "tax-auditor" role with secure read-only API access on the accounting system itself.

## Authoritative source list

- Lag (2018:1277): https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-20181277-om-elektroniska-fakturor-till_sfs-2018-1277/
- Bokföringslag (1999:1078): https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/
- DIGG e-handel laws and regs: https://www.digg.se/kunskap-och-stod/e-handel/lag-forordning-och-foreskrifter-for-e-handel
- DIGG Peppol statistics: https://www.digg.se/digitala-tjanster/peppol/statistik-fran-peppolnatverket-
- SFTI standards: https://sfti.se/sfti/standarder/peppolbisehandel/peppolbisbilling3.49021.html
- Skatteverket e-faktura: https://skatteverket.se/omoss/varverksamhet/forleverantorer/efakturortillskatteverket.4.b1014b415f3321c0de2680.html
- Skatteverket on transaction-based reporting: https://www.skatteverket.se/foretag/internationellt/transaktionsbaseradrapporteringochefakturering.4.386bd4b919276cc86c42b3f.html
- Dir. 2026:9: https://www.regeringen.se/pressmeddelanden/2026/02/ny-utredning-om-modernare-momsregler-och-battre-verktyg-mot-momsbedragerier/
- ViDA package: https://taxation-customs.ec.europa.eu/news/adoption-vat-digital-age-package-2025-03-11_en
- EC eInvoicing Country Sheet for Sweden: https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108902/eInvoicing+in+Sweden