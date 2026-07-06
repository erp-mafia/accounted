# Vouchers och presentkort: SPV vs MPV

## Lagstöd

- **2 kap. 26-27 §§ ML 2023:200**: definitioner av voucher, SPV, MPV.
- **5 kap. 40-44 §§ ML 2023:200**: beskattningsbara transaktioner kring vouchers. Kontrollera konsoliderad version efter renumrering enligt SFS 2024:942 (ikraft 2025-01-01).
- **Rådets direktiv (EU) 2016/1065** (voucher-direktivet), implementerat i Sverige 2019-01-01.
- **Skatteverkets ställningstagande dnr 202 488720-18/111** (2018-11-26): fortsatt giltigt.
- **Skatteverkets ställningstagande dnr 202 508158-18/111** (2018-12-06): fakturering och redovisning.

## Definitioner

**Voucher**: Instrument som måste tas emot som vederlag (helt eller delvis) för leverans av varor eller tjänster, där varorna/tjänsterna eller säljarens identitet anges på instrumentet eller i tillhörande dokumentation.

**SPV (Single-Purpose Voucher), enfunktionsvoucher**: Voucher där **både** följande är kända vid utställandet:
- Platsen för leverans (beskattningsland).
- Den moms som ska betalas (momssats).

**MPV (Multi-Purpose Voucher), flerfunktionsvoucher**: Alla andra vouchers (där minst en av platsen eller momssatsen är okänd vid utställandet).

## Beslutsmatris

| Scenario | SPV/MPV | Skäl |
|---|---|---|
| Gift card för en specifik svensk e-handelsbutik som säljer enbart 25 %-momsade varor | **SPV** | Land (SE) och sats (25 %) känd |
| Gift card för butik som säljer både 25 % (varor) och 6 % (e-böcker) | **MPV** | Sats okänd |
| Gift card för butik som säljer till både SE och EU-konsumenter | **MPV** | Land okänt |
| Steam Wallet (digitala spel, många länder, olika satser) | **MPV** | Båda okända |
| iTunes-voucher | **MPV** | Lex specialis: separat hantering av e-tjänster vs spel |
| ICA-presentkort (matkedja, blandade satser 12 % och 25 %) | **MPV** | Sats okänd |
| Sommarjobb-bonus i form av butiksvärdesedel (en butik, bara 12 %-livsmedel) | **SPV** | Båda kända |
| Rabattkupong (-100 kr på köp över 500 kr) | **Ingen voucher**: rabattinstrument, ej voucher (2 kap. 27 § ML) |

## Redovisningsregler

### SPV
- **Moms vid varje överlåtelse** (5 kap. 40 § ML).
- Vid utställande/försäljning av voucher = momspliktig leverans → 3001 + 2611 direkt.
- Vid faktisk leverans av varan mot inlösen av voucher → ingen ny momspliktig händelse. Voucher-värdet är redan beskattat.
- Bokföring (försäljning av SPV-presentkort 1 000 SEK):
  - Dt 1930 (eller 1580) 1 000
  - Kr 3001 800
  - Kr 2611 200
- Vid inlösen mot vara värt 1 000 SEK:
  - Bokföringsmässigt: ingen momseffekt. Vara levereras mot redan registrerad intäkt.
  - Lagervärdesminskning bokas normalt (4xxx + 14xx beroende på K2/K3 och lagermetod).

### MPV
- **Moms först vid inlösen** (5 kap. 41 § ML).
- Vid utställande av MPV-presentkort: ingen utgående moms. Mottaget belopp bokas som skuld (2421 Ej inlösta presentkort).
- Vid inlösen: skulden omklassificeras till intäkt + utgående moms.
- Bokföring (försäljning av MPV-presentkort 1 000 SEK):
  - Dt 1930 1 000
  - Kr 2421 1 000
- Vid inlösen mot vara med 25 % moms:
  - Dt 2421 1 000
  - Kr 3001 800
  - Kr 2611 200

### Distributörsprovision
- Om voucher säljs via återförsäljare/distributör som tar provision: distributörens tjänst (förmedling) är separat **momspliktig** oavsett om voucher är SPV eller MPV (5 kap. 42 § ML).
- Bokföring hos voucher-utfärdaren: 6050 + RC om utländsk distributör.

## Preskription och utgångsdatum

- **Svensk allmän preskription**: 10 år för fordringar mot konsument (preskriptionslagen 1981:130, 2 §).
- Voucher-villkor kan ange kortare giltighetstid; **konsumentskydd** begränsar dock orimligt korta giltighetstider (konsumentavtalsvillkorslagen 1994:1512).
- Vid preskription/förfall: skuld på 2421 vänds till intäkt → 3990 eller 3991 (utan moms, eftersom inlösen aldrig skedde och momsplikt inte triggades). Detta ska bevisas vara giltig preskription, inte unilateral beslutsfattande från företaget.

## Returer mot MPV-voucher

Om kund betalat med MPV-voucher och returnerar varan: voucher återställs ofta som ny voucher eller saldo. Bokföringsmässigt återförs intäkt + utgående moms, och 2421-skulden återställs.

## Cross-border-aspekter

- Voucher utgiven i SE för inlösen i annat EU-land → momsbedömning enligt landet där voucher löses in. Kan kräva OSS-hantering vid inlösen.
- Voucher från icke-EU-land använd i Sverige → momsplikt i Sverige vid inlösen.
