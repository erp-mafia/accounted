# Marketplace deemed supplier: 5 kap. 5-6 §§ ML 2023:200

## När triggas reglerna

**5 kap. 5 § ML**: distansförsäljning av **importerade varor ≤ 150 EUR** via elektroniskt gränssnitt. Plattformen anses ha köpt och sålt varan. Tillämpas oavsett säljarens etableringsland.

**5 kap. 6 § ML**: leverans **inom EU** från en **icke-EU-etablerad säljare** till en EU-konsument via elektroniskt gränssnitt. Tillämpas både vid gränsöverskridande och inom samma EU-land.

**Fakta-test**:
1. Är försäljningen via elektroniskt gränssnitt (online marketplace, plattform, portal)?
2. Är säljaren EU-etablerad eller icke-EU-etablerad?
3. Är varan importerad och ≤ 150 EUR? (5 §)
4. Eller är varan redan i EU-lager men säljaren är icke-EU-etablerad? (6 §)

## Konsekvenser för säljaren

- Säljarens leverans till plattformen är **undantagen** (10 kap. ML, art. 136a direktivet). Ingen momsregistrering i destinationsstaten för säljaren genom denna transaktion.
- Säljaren ska inte ta ut moms av plattformen.
- Plattformen redovisar destinationslandets moms via sitt IOSS (för 5 §) eller via OSS/lokal registrering (för 6 §).
- Transport hänförs till plattformens leverans (6 kap. 17 § ML).

## Per plattform

### Amazon

**EU-marknadsplatser**: Amazon.de, Amazon.fr, Amazon.it, Amazon.es, Amazon.nl, Amazon.se, Amazon.pl, Amazon.com.be.
**Deemed supplier-aktivering**: 
- Säljare utanför EU (B2C-omsättning från EU-lager) → 5 kap. 6 § ML triggas.
- Säljare med varor från tredjeland direkt till konsument ≤ 150 EUR → 5 kap. 5 § ML triggas (Amazon kör IOSS).
- Säljare etablerad i EU med EU-lager → reglerna triggas INTE; säljaren redovisar moms själv (OSS eller lokal reg).

**FBA (Fulfilment by Amazon)**: Egna varor i Amazon-lager. Säljaren är "owner of record".
**PAN-EU FBA**: Amazon kan flytta säljarens varor mellan EU-lager (DE, FR, IT, ES, PL, CZ, NL, SE) för optimering. **Varje flytt utlöser lokal momsregistreringsskyldighet** i mottagande land (förvärv lika med, art. 17 direktivet). OSS kan inte ersätta dessa lokala registreringar.

**Rapporter att tolka momsmässigt**:
- *VAT Transactions Report*: visar varje transaktion med plattformens deemed supplier-status.
- *Amazon VAT Calculation Service (VCS)*: Amazon räknar och samlar in moms.
- *Settlement Report*: payout-detaljer för bokföring (brutto, refunds, fees).

**BAS-mappning säljarens bokföring**:
- 1580-AMZ-DE, 1580-AMZ-FR etc. per marketplace.
- 6050: Amazon Referral Fee, FBA Fulfilment Fee (RC: Amazon EU S.à r.l., LU → 4535 + 2614/2645).
- 3990: Övrig försäljning (deemed supplier-fall där säljarens leverans är undantagen) eller normal 3001/3106 om säljaren bär momsen själv.

### eBay
- Deemed supplier för icke-EU-säljare och importerade varor ≤ 150 EUR enligt samma logik.
- Final value fee (provisionen) bokas på 6050 (eBay Marketplaces GmbH, CH-baserat för EU, RC kan tillämpas; eller eBay Commerce Inc, US, RC).

### Etsy
- Etsy Ireland UC (IE) → RC på provisioner.
- Listing fees, transaction fees, Offsite Ads-fees → 6050 + 4535 RC.

### CDON Marketplace
- CDON AB (SE, org.nr 556406-1702) → svensk moms på fakturan, ingen RC.
- Referral fee per kategori → 6050 + 2611 (ingående svensk moms avdragsgill).

### Fyndiq
- Fyndiq AB (SE) → svensk moms, ingen RC.
- Provisioner → 6050.

### TikTok Shop
- Säljare måste vara EU-etablerade för EU-marknader (per 2025). Deemed supplier-frågan begränsad.
- TikTok Information Technologies UK Ltd (UK) eller TikTok Technology Limited (IE) beroende på avtal: verifiera entiteten på faktura.

### Temu och Wish
- Operationsmodell varierar. Säljare via Temu är ofta kinesiska entiteter; Temu kan agera deemed supplier för importerade varor ≤ 150 EUR.
- Svensk säljare via Temu: ovanligt scenario, kräver klientspecifik analys.

## Säljarens bokföringspraxis vid deemed supplier

Vid scenarier där 5 kap. 5 eller 6 § triggas och säljarens leverans till plattformen är undantagen:

1. Bruttoförsäljning enligt plattformens settlement report bokas på fordringskonto (1580-AMZ etc.) mot **3990 Övrig försäljning** eller separat konto (t.ex. 3091 "Försäljning via marketplace, deemed supplier") för att skilja från egen omsättning som faller under momslagen.
2. Provisioner och fees bokas separat på 6050 (RC tillämpas om plattformens entitet är utanför SE).
3. Refunds bokas som negativ försäljning, ej som kostnad.
4. **Ingen utgående moms** redovisas av säljaren för dessa transaktioner i svensk momsdeklaration.
5. **Periodisk sammanställning**: dessa transaktioner ingår inte i VIES-rapporteringen: det är plattformen som rapporterar.
6. För blandad verksamhet (egen omsättning + marketplace-omsättning som deemed supplier-skyddas): se HFD 2023 ref. 45 om proportionell avdragsrätt vid blandad verksamhet.

## Bevisning vid revision
- Plattformens VAT-rapport eller motsvarande underlag som styrker att plattformen redovisar momsen.
- Settlement reports per period.
- Klassificering av varje order: vilken paragraf (5 kap. 5 §, 6 §, eller utanför deemed supplier).
- Avgöranden grundade på dnr 8-1293055 (transportallokering vid flerstegsförsäljning).

## Öppen fråga: PAN-EU FBA + OSS

Skatteverket har inte publicerat aktörsspecifik vägledning. Praktisk hantering:
- Flytt av egna varor mellan EU-lager → lokal momsregistrering i varje destinationsland för förvärv.
- Försäljning från utländskt EU-lager till konsument i annat EU-land → kan rapporteras via OSS (eftersom OSS täcker unionsintern distansförsäljning oavsett startland inom EU).
- Försäljning från utländskt EU-lager till konsument i **samma** land som lagret → lokal momsregistrering krävs, OSS täcker inte detta.

Kombinationen genererar typiskt 3-7 lokala momsregistreringar för PAN-EU FBA-säljare. Kräver klientspecifik analys.
