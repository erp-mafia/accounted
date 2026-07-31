---
id: product/bokforingsmallar
tier: product
title: "Bokföringsmallar (radtyper: Kostnad/Intäkt, Moms, Betalning)"
description: >
  Product knowledge for Accounted's bokföringsmallar (booking templates,
  Inställningar → Bokföringsmallar): what the three radtyper on a template line
  mean (Kostnad/Intäkt, Moms, Betalning), how the amount is split when a mall is
  applied, and the rule that makes a mall pickable directly on a bank
  transaction. Load whenever the user asks about mallar, bokföringsmallar,
  skapa mall, "kostnad eller betalning", radtyp, andel/ratio i mallar,
  "Endast i verifikat", why a mall does not appear in the transaction picker,
  or how to build or edit a booking template.
version: 1
---

# Bokföringsmallar

En bokföringsmall är ett återanvändbart recept för ett verifikat. Användaren
anger ett totalbelopp när mallen används; mallen fördelar beloppet över sina
rader. Mallar hanteras under Inställningar → Bokföringsmallar och används på
två ställen: direkt när en banktransaktion bokförs (mallväljaren) och från
verifikatformuläret.

## De tre radtyperna

Varje rad i en mall har ett konto, en sida (debet/kredit) och en radtyp:

- **Betalning**: raden för kontot där pengarna faktiskt rör sig, oftast
  `1930` Företagskonto (eller t.ex. `1630` skattekonto). Raden får hela
  totalbeloppet.
- **Kostnad/Intäkt**: raden för det som köpet eller försäljningen avser, t.ex.
  `5410` förbrukningsinventarier eller `3011` försäljning. Finns flera
  kostnads-/intäktsrader fördelas beloppet med radens andel (andelarna ska
  summera till 1,0).
- **Moms**: momsraden (t.ex. `2641` ingående, `2611` utgående). Beloppet
  räknas ut automatiskt ur totalbeloppet med radens momssats:
  total × sats / (1 + sats).

Snabbregeln vid "kostnad eller betalning?": raden som pekar på bankkontot är
Betalning; raden som pekar på det pengarna användes till är Kostnad/Intäkt.

## Vad radtypen INTE styr

Radtypen ändrar aldrig vilket konto som bokförs: kontot kommer alltid från
radens kontofält, och sidan från debet/kredit-valet. Radtypen styr bara hur
beloppet fördelas (hela beloppet, andel, eller uträknad moms) och om mallen kan
väljas direkt på en transaktion (nästa stycke).

## När kan mallen väljas direkt på en banktransaktion?

Mallväljaren vid transaktionsbokning visar bara mallar med exakt en
kostnads-/intäktsrad och exakt en betalningsrad, på motsatt sida (den ena
debet, den andra kredit). Momsrader får finnas fritt. En mall som inte
uppfyller det märks "Endast i verifikat" och kan bara användas från
verifikatformuläret; formuläret visar samma hint redan medan mallen byggs.

## Typiska exempel

- Kostnadsmall (kortköp med 25 % moms): debet Kostnad/Intäkt `5410`,
  debet Moms `2641` (25 %), kredit Betalning `1930`.
- Intäktsmall: kredit Kostnad/Intäkt `3011`, kredit Moms `2611` (25 %),
  debet Betalning `1930`.

Momsfria mallar utelämnar momsraden helt eller sätter momssatsen till 0 %.
