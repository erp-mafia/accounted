# Invoice text library: IT consulting (Sweden)

## B2B inom EU (omvänd betalningsskyldighet)

**Krav (ML 17 kap):** köparens VAT-nr på fakturan + uttrycklig text om reverse charge + ingen moms.

**Svensk/engelsk dubbeltext (rekommenderad):**

```
Omvänd betalningsskyldighet / Reverse charge
Artikel 44 och 196 i rådets direktiv 2006/112/EG
VAT to be accounted for by the recipient under Article 196 of Directive 2006/112/EC

Buyer VAT-ID: DE123456789
```

Försäljning bokas på **3308 Försäljning tjänster till annat EU-land**. Momsdeklaration **ruta 39**. Periodisk sammanställning kvartalsvis med köparens VAT-nr.

**VIES-validering** ska sparas per kund per faktureringscykel (SKV ställningstagande dnr 202 460649-17/111). Skärmdump av VIES-kontroll med datum och VAT-nr i klientmappen.

## B2B utanför EU

```
Outside scope of Swedish VAT
Article 44 Council Directive 2006/112/EC (place of supply: customer's country)
This transaction is not subject to Swedish VAT.
```

Försäljning bokas på **3305 Försäljning tjänster till land utanför EU**. Momsdeklaration **ruta 40**. Ej i periodisk sammanställning.

Behov av lokalt VAT-nr beror på köparlandet (US: typiskt inget krav; UK: VAT-nr om köparen är registrerad).

## B2C inom Sverige

Standard 25 % moms:

```
Moms 25 % ingår med [belopp] SEK
```

Försäljning **3001/3041**, utgående moms **2611**. Momsruta **05+10**.

## B2C inom EU: under OSS-tröskel (10 000 EUR / 99 680 SEK)

Behandlas som Sverige-försäljning, svensk moms 25 %. Försäljning på 3001/3041, ruta 05+10.

## B2C inom EU: över OSS-tröskel (eller frivillig OSS-registrering)

```
VAT [köparlandets sats] %
[Sats × belopp] [köparlandets valuta eller SEK]
Reported via the One Stop Shop scheme (Union scheme).
Seller's OSS identification: SE[VAT-nr]
```

Försäljning **3308**, utgående OSS-moms **2670**. OSS-deklaration kvartalsvis i EUR, separat från ordinarie momsdeklaration.

Tabell över relevanta momssatser i EU (uppdateras 2025-2026, kontrollera vid behov):

| Land | Standardsats |
|---|---|
| DE | 19 % |
| FR | 20 % |
| NL | 21 % |
| DK | 25 % |
| FI | 25,5 % |
| IT | 22 % |
| ES | 21 % |
| PL | 23 % |
| BE | 21 % |

## Royalty / licensavgift (utgående)

### Med IP-överlåtelse

```
Härmed överlåts samtliga immateriella rättigheter avseende [leveransen]
i enlighet med upphovsrättslagen (1960:729) 27 §.
Köparen erhåller ekonomiska rättigheter; ideella rättigheter förblir hos upphovsmannen
i den omfattning lagen kräver.
```

### Utan IP-överlåtelse (endast nyttjanderätt)

```
Denna leverans omfattar nyttjanderätt till programvaran enligt bifogade licensvillkor.
Inga immateriella rättigheter överlåts.
URL (1960:729) gäller; alla rättigheter förbehålls upphovsmannen.
```

Royaltyintäkt bokas på **3922 Licensintäkter och royalties** eller (om huvudverksamhet) **3001/3041** beroende på affärsmodell.

## Subkontraktör (underkonsult AB→AB)

Standardfaktura i Sverige med 25 % moms. F-skatt anges:

```
F-skatt: Innehavaren av denna faktura är godkänd för F-skatt.
Org.nr: 556xxx-xxxx
```

Mottagaren bokar på **6850 Inhyrd IT-personal**, drar ingående moms 2641.

## Förskottsfakturering SaaS-prenumeration

```
Period: 2026-01-01 till 2026-12-31
Avgift för årsprenumeration på [tjänst].
Tjänsten levereras löpande under avtalsperioden.
```

Mottagaren bokar fakturan på **2972 Förutbetalda intäkter** (kreditsida) vid utfärdande, periodiserar 1/12 per månad mot 3922/3041.

## Praktiska fallgropar

1. **C-247/21 Luxury Trust Automobil (2022).** Saknad "reverse charge"-text kan inte rättas i efterhand. Verifiera fakturamallen innan första fakturan till EU B2B-kund.

2. **VAT-nr-format.** EU-länderna har olika format (DE 9 siffror, FR 11 tecken, NL 12 tecken inklusive "B01" etc.). VIES validerar formatet: om kunden ger ogiltigt nummer, fråga om uppdaterat eller behandla som B2C.

3. **Microsoft Ireland vs Microsoft US.** Olika kundavtal får olika faktureringsentiteter. Kontrollera fakturafoten varje månad: kan bytas vid avtalsändring.

4. **OSS-tröskeln gäller summan av varor + TBE-tjänster B2C inom EU.** Lätt att missa när man säljer både SaaS B2C och fysiska varor.

5. **Reverse charge-text på engelska räcker.** Säljarens hemspråk är inte tvingande (ML 17 kap), men dubbeltext minskar tolkningsproblem.

## Lagreferenser

- ML (2023:200) 17 kap: faktureringsskyldighet och fakturainnehåll
- ML 6 kap 33§: B2B-huvudregeln
- ML 6 kap 56-58§§ + 62-63§§: TBE-tjänster B2C och OSS-tröskeln
- ML 22 kap: OSS-deklaration
- 2006/112/EG art. 44, 196, 226: placeringsregler och fakturainnehåll
- EUD C-247/21 (2022): reverse charge-text kan inte rättas
- SKV ställningstagande dnr 202 460649-17/111 (2018-01-25): VIES-validering bevisbörda
