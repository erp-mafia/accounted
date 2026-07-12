# European E-Invoicing Mandates, Comparison and ViDA Timeline

This reference compares Sweden's likely trajectory to the mandates already enacted or pending in other EU member states, and lays out the binding ViDA cross-border timeline.

## ViDA, the binding EU floor

**VAT in the Digital Age** package adopted by ECOFIN on 11 March 2025; in force 14 April 2025; transposition deadline 31 December 2026.

| Date | Obligation |
|---|---|
| **14 Apr 2025** | Member states may mandate domestic B2B e-invoicing without Article 395 derogation, provided EN 16931-based; recipient consent abolished |
| **1 Jul 2030** | **Mandatory structured e-invoicing + Digital Reporting Requirements (DRR) for cross-border intra-EU B2B**; recapitulative VIES statements abolished; invoice issuance ≤10 days after chargeable event |
| **1 Jan 2035** | Pre-existing national clearance regimes (IT/FR/PL/RO/HU/ES) must align to the EU DRR standard |

**Sweden has no pre-existing CTC, so Sweden does NOT get the 2035 grandfather clause.** Any new domestic mandate must be EN 16931-compliant by design.

## Country-by-country mandate status (April 2026)

### Italy, centralised CTC clearance

- **Sistema di Interscambio (SDI)**, government clearance hub.
- Format: **FatturaPA**.
- Live for B2B since 1 January 2019. Cross-border via SDI from 1 July 2022. Forfettari fully included in 2024.
- Pre-clearance: every invoice routed through SDI before reaching the buyer.
- **EU derogation extended to 31 December 2027.**
- Penalties: 90-180% of VAT.
- Archive: 10 years.
- The "old" model that ViDA's 2035 alignment deadline forces to harmonise.

### France, Y-model (Plateforme Agréée + PPF directory)

- Plateforme Agréée (ex-PDP, "Partenaire de Dématérialisation Privée") + Portail Public de Facturation (PPF) as central directory.
- Formats: **Factur-X**, UBL, CII (multi-format permitted).
- **1 September 2026** receive obligation for all + send obligation for large enterprises and ETI (mid-cap).
- **1 September 2027** SMEs and micro-enterprises.
- National Assembly rejected further postponement in April 2025.
- DGFiP became France's Peppol Authority in 2025.
- Hybrid: PA processes the invoice, PPF receives reporting data.

### Germany, decentralised, no clearance hub

- Format: **XRechnung** (UBL or CII profile) or **ZUGFeRD ≥2.0.1** (hybrid PDF/A-3 + XML).
- **Receive obligation already live since 1 January 2025**, every German business must be able to receive an e-invoice.
- **1 January 2027** send obligation for businesses with annual turnover >€800k.
- **1 January 2028** all businesses send.
- Archive period reduced 10 → 8 years (from 2025).
- Decentralised: no government hub, no clearance.

### Belgium, the ViDA template

- **Decentralised 4-corner Peppol mandate, live 1 January 2026.**
- Format: **Peppol BIS Billing 3.0 / UBL** (peppol-only).
- Tolerance period through Q1 2026 (no penalties).
- 5-corner e-reporting layer added from 2028.
- Penalties: €1,500 first violation / €3,000 second / €5,000 third.
- **This is the model Sweden will most likely mirror.**

### Poland, KSeF centralised clearance

- **Krajowy System e-Faktur (KSeF)**, government clearance.
- Format: **FA(3) XML**.
- **Phase 1 live 1 February 2026** for ~4,200 entities with turnover >PLN 200M.
- **1 April 2026** all VAT-registered.
- **1 January 2027** micro-enterprises.
- Penalty-free through 2026.
- Like Italy, a CTC model that ViDA 2035 forces to align to EU DRR.

### Spain, decentralised: AEAT public + private platforms

- Format: **UBL / Facturae / CII / EDIFACT** (multi-format).
- **RD 238/2026 published 31 March 2026.**
- **+12 months (July 2027)** for businesses with turnover >€8M.
- **+24 months (July 2028)** all.
- Parallel **VeriFactu** invoicing software certification, January/July 2027.

### Romania, CTC (RO e-Factura)

- Format: **UBL 2.1 + RO-CIUS, ANAF seal**.
- **B2B mandatory 1 July 2024.**
- **B2C added 1 January 2025.**
- Pre-clearance to be removed January 2026 to align with ViDA.

### Norway, proposed mandatory 2028

- Format: **Peppol BIS 3 / EHF**.
- **Mandatory B2B 1 January 2028 (proposed).**
- The Nordic peer pressure factor: a 2028 Norwegian mandate makes it implausible that Sweden would wait beyond 2030.

## Sweden's likely trajectory

Sweden has **20+ years of Peppol/SFTI infrastructure**, B2G mandatory since 2019, and DIGG already accredited as Peppol Authority. There is **zero political appetite** for an Italian-style centralised clearance hub, the existing decentralised infrastructure works, has proven low-friction, and aligns with EU peer countries (Belgium, Norway, Germany).

**Realistic trajectory:**

1. **Now → 30 November 2027**, Dir. 2026:9 inquiry runs. Skatteverket's preferred model (decentralised Peppol + DRR layer) is articulated.
2. **2028**, Lagrådsremiss and proposition. Likely model: Belgium-style Peppol 4-corner B2B, plus a 5-corner DRR layer where Skatteverket becomes Corner 5.
3. **2029-2030**, First domestic obligations. Likely: receive obligation first (all VAT-registered), then send obligation phased by entity size mirroring Germany's 2025→2027→2028 rollout.
4. **1 July 2030**, ViDA cross-border B2B obligation kicks in regardless of domestic timeline. Sweden is bound.
5. **2031-2032**, Full domestic mandate live including DRR layer.

The single most important date to monitor is **30 November 2027** (Dir. 2026:9 final report). Architectural decisions made before then should preserve optionality between (a) pure Peppol 4-corner with no central reporting, (b) Peppol + DRR 5-corner, and (c) the unlikely-but-possible centralised clearance fallback.

## Cross-border invoicing through Peppol, practical implications

For a Swedish supplier invoicing into a mandate country today:

| Destination | Current method | After 1 July 2030 |
|---|---|---|
| **Belgium** (since Jan 2026) | Peppol BIS Billing 3 | Same (Peppol is the format) |
| **Italy** | Peppol→SDI bridge via service provider, or direct SDI submission | Aligned to EU DRR by 2035 |
| **France** | Peppol→PA bridge after 1 Sep 2026 | DRR via PA / PPF |
| **Germany** | XRechnung via Peppol or direct | XRechnung continues, DRR added |
| **Poland** | Peppol→KSeF bridge | Aligned to EU DRR by 2035 |
| **Romania** | Peppol→RO e-Factura bridge | Aligned to EU DRR by 2035 |

**Operational implication for a Swedish accounting product:** by 2027, customers will increasingly expect "send invoice anywhere in EU" to just work. Multi-mandate routing is a hard capability, not an enterprise add-on. **Storecove or Pagero are the realistic outsourcing options** for multi-mandate send; building per-country yourself is uneconomic until very high volume.

## Authoritative source list

- ViDA package adoption: https://taxation-customs.ec.europa.eu/news/adoption-vat-digital-age-package-2025-03-11_en
- ViDA Wikipedia summary (kept current): https://en.wikipedia.org/wiki/VAT_in_the_Digital_Age
- Belgium 2026 mandate: https://edicomgroup.com/blog/belgium-will-make-b2b-electronic-invoice-mandatory
- France PA/PPF model: https://www.impots.gouv.fr (DGFiP)
- Germany BMF ordinance: https://www.bundesfinanzministerium.de
- Italy SDI: https://www.fatturapa.gov.it
- Poland KSeF: https://www.podatki.gov.pl/ksef
- Norway 2028 proposal: https://www.regjeringen.no
- Comarch country trackers: https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/
- EC eInvoicing Country Sheets: https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108902/eInvoicing+in+Sweden