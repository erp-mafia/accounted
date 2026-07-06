# Electronic services classification (moms)

## Definition: three cumulative criteria

EU genomförandeförordning 282/2011 art. 7 + bilaga I:
1. Levereras över Internet eller elektroniskt nät
2. Huvudsakligen **automatiserad** med minimal mänsklig inblandning
3. Kan inte tillhandahållas **utan informationsteknik**

Misslyckas något kriterium → inte elektronisk tjänst (typiskt konsulttjänst eller annan tjänstekategori).

## Beslutsträd för IT-konsult-/SaaS-bolag

```
Säljs över Internet?
├── NEJ → Konsulttjänst eller varuförsäljning (separat klassificering)
└── JA  → Huvudsakligen automatiserad?
         ├── NEJ → Konsulttjänst (ML 6 kap 33§ huvudregeln)
         └── JA  → Kräver IT?
                  ├── NEJ → Annan tjänstekategori
                  └── JA  → Elektronisk tjänst (ML 6 kap, OSS för B2C)
```

## Klassificeringsmatris

| Erbjudande | Klassificering | Anmärkning |
|---|---|---|
| Skräddarsydd kod på beställning | Konsulttjänst | Mänsklig leverans, huvudregeln gäller |
| Standard-SaaS (Salesforce, Slack-typ) | Elektronisk tjänst | Helautomatiserad |
| Hostad kundspecifik instans med support | Blandad: separera bashysning (elektronisk) från support (konsult) eller bedöm huvudprestation |
| IaaS (AWS EC2, Azure VM) | Elektronisk tjänst | Helautomatiserad self-service |
| Co-location (kundens hardware) | Fastighetstjänst | Annan placeringsregel: ML 6 kap 38§ |
| GPU/compute (HPC/AI training) | **Elektronisk tjänst** | Skatterättsnämnden förhandsbesked 2024 |
| AI-API (OpenAI, Anthropic API) | Elektronisk tjänst | Automatiserad inference |
| Förinspelad onlinekurs | Elektronisk tjänst | Bilaga I till 282/2011 |
| Live-undervisning via video | **Konsulttjänst** | Mänsklig leverans (genomförandeförordning art. 7.3) |
| Virtuellt evenemang B2B (från 2025-01-01) | Konsulttjänst → köparens land | SFS 2024:942 |
| Streamad konferens till konsument | Elektronisk tjänst → konsumentens land | OSS |
| App-/SaaS-distribution via app store | Plattformen presumeras säljare | SKV dnr 8-2059749, 2022-12-19 |
| Standardprogram på fysiskt medium | **Vara** | Inte tjänst |
| Standardprogram för download | Elektronisk tjänst | Online-leverans = tjänst |
| Royalty för immaterialrätt | "Diverse tjänster" | ML 6 kap 64-66§§ |

## Placeringsregler

### B2B (köparen är beskattningsbar person)

Alla tjänster (inkl. elektroniska) beskattas där **köparen** är etablerad (ML 6 kap 33§, art. 44 i 2006/112/EG). Säljaren fakturerar utan moms; köparen reverse-chargar.

### B2C (köparen är konsument)

| Säljare | Köpare | Beskattningsland |
|---|---|---|
| Svensk säljare | Svensk konsument | Sverige (svensk moms) |
| Svensk säljare | EU-konsument, total försäljning <10 000 EUR/år | Sverige |
| Svensk säljare | EU-konsument, total försäljning ≥10 000 EUR/år | Konsumentens land via OSS |
| Svensk säljare | Konsument utanför EU | Konsumentens land (ofta undantaget från svensk moms) |

## OSS-tröskeln

**Beräkning.** Tröskeln **10 000 EUR / 99 680 SEK** gäller den **sammanlagda** unionsinterna distansförsäljningen av varor + TBE-tjänster B2C (ML 6 kap 62-63§§). Räknas kalenderårsvis.

**Övergång.** När tröskeln passeras under året → svensk moms upp till tröskeln, OSS-moms (köparlandets sats) från och med fakturan som passerar.

**Frivillig registrering.** Säljare under tröskeln kan välja att registrera sig i OSS: typiskt fördelaktigt vid försäljning till lågmoms-länder (Luxemburg 17 %, Tyskland 19 %).

**Deklaration.** OSS-unionsordningen kvartalsvis (Q1 → 30 april, Q2 → 31 juli, Q3 → 31 oktober, Q4 → 31 januari). Allt i EUR.

## Marknadsplats-presumtion

**SKV ställningstagande dnr 8-2059749, 2022-12-19** ("Försäljning av elektroniska tjänster via marknadsplats och andra förmedlare på Internet, mervärdesskatt"):

- Marknadsplats/app store presumeras vara säljare av slutkundstjänsten
- Underleverantören säljer till plattformen (B2B), plattformen säljer till slutkund (B2C eller B2B)
- Praktisk följd för svensk app-utvecklare som säljer via Apple App Store / Google Play / Microsoft Store / Steam: säljer till plattformen i Irland/Luxemburg → svensk faktura utan moms, reverse charge för plattformen
- Ersätter äldre dnr 131 499122-14/111

## Konsult vs licens: kombinerade leveranser

**Princip.** När en leverans innehåller både konsultarbete och licens/SaaS, bedöm vad som är **huvudprestationen** (EU-domstolens CPP-doktrin, mål C-349/96).

Vanliga mönster för IT-konsult:
- **Implementation av standard-SaaS (60 % konsult + 40 % licens):** sammanhängande tjänst med konsultarbete som huvudprestation → konsulttjänst, B2B-huvudregeln gäller hela beloppet
- **SaaS-licens med support (90 % licens + 10 % support):** elektronisk tjänst hela
- **Skräddarsydd utveckling + drift (50/50):** ofta separera i faktura, utveckling som konsult, drift som elektronisk

Dokumentera bedömningen i avtal och faktura för att undvika ifrågasättande.

## Skattesats

**Programvara och SaaS = alltid 25 %.** Reducerade satser (12 %, 6 %) gäller inte programvara, även om innehållet skulle kunna falla under en reducerad kategori (t.ex. e-bok 6 % gäller bok som elektronisk publikation enligt ML 7 kap 1§ 3 st p. 4, inte SaaS-plattform för bokläsning).

**HFD 2024 ref. 42:** EdTech-plattform med läromedel ansågs **inte** vara "bok" → standard 25 %.

## Praxis 2021-2026: moms på digitala tjänster

| Avgörande | Innebörd |
|---|---|
| EUD C-247/21 Luxury Trust Automobil (2022) | Saknad "reverse charge"-text kan inte rättas i efterhand |
| Skatterättsnämnden 2024 (förhandsbesked) | Beräkningskapacitet/GPU = elektronisk tjänst |
| HFD 2024 ref. 42 | EdTech-plattform ej "bok": 25 % moms |
| SFS 2024:942 (ikraft 2025-01-01) | Virtuella evenemang B2B → köparens land |

## Lagreferenser

- ML (2023:200) 6 kap 33§: huvudregeln B2B
- ML 6 kap 56-58§§: elektroniska tjänster B2C
- ML 6 kap 62-63§§: OSS-tröskeln
- ML 22 kap: OSS-deklaration
- 2006/112/EG art. 44 (B2B), art. 58 (B2C TBE)
- Genomförandeförordning (EU) 282/2011 art. 7 + bilaga I: definition elektronisk tjänst
