# Consultant vs employee classification (uppdragstagare vs arbetstagare)

## Lagbas: IL 13 kap 1§

Efter prop. 2008/09:62 (ikraft 2009-01-01) ska tre faktorer **särskilt beaktas** vid bedömningen om en person bedriver näringsverksamhet eller står i ett anställningsförhållande:

1. **Partsavsikten**: vad parterna avsett enligt avtal
2. **Beroendet**: uppdragstagarens beroende av uppdragsgivaren
3. **Integrationen**: i vilken grad uppdragstagaren är inordnad i uppdragsgivarens verksamhet

Reformen 2009 syftade till att underlätta starta-eget: F-skatt + flera uppdragsgivare ska normalt räcka.

## F-skattens rättsverkningar: HFD 2019:60

**Mål 3978-3979-18 m.fl.** Uppdragsavtal med F-skattegodkänd uppdragstagare kan inte åsidosättas annat än vid **skenavtal** (avtalet återspeglar inte verkligheten).

**Praktisk konsekvens:** dominerande prejudikat för IT-konsult via eget AB. Skatteverket kan inte påföra arbetsgivaravgifter på uppdragsgivaren även om uppdraget liknar anställning, så länge:
- F-skatt är registrerad och anges skriftligt i avtalet/fakturan (SFL 10 kap 11§)
- Avtalet är inte fingerat
- Det finns reellt företagande på uppdragstagarens sida

Backas av SKV ställningstagande **dnr 8-2386895** (2023-05-25) om F-skattsedelns rättsverkningar.

## 3:12-mening: verksam i betydande omfattning

**HFD 2018 ref. 31** (mål 3936-3939-17): IT-konsult som via eget AB arbetar för kundföretag kan ändå klassas som "verksam i betydande omfattning" hos kundföretaget i **3:12-mening** (IL 57 kap 4§). Detta är inte samma fråga som arbetsgivaravgifter: skenavtalströskeln gäller där, men 3:12 har lägre tröskel.

Konsekvens: aktierna i kundföretaget kan bli kvalificerade för konsulten även om konsulten formellt är extern. Sällan praktiskt problem för dagliga konsultupplägg, men relevant vid:
- Equity/options i kundbolaget som ersättning
- Långa eller exklusiva uppdrag med ledningsuppgifter

## Styrelsearvoden: HFD 2017 ref. 41

Styrelsearvode ska normalt beskattas som **inkomst av tjänst** även om fakturering sker via eget AB. Endast vid undantagsfall (få och tidsbegränsade uppdrag, styrelseuppdrag som integrerad del av annan konsultroll) accepteras AB-fakturering.

Skatteverket har följt upp med **ställningstagande dnr 8-1503440** (2022-02-22). Två villkor måste uppfyllas för AB-fakturering:
1. Uppdraget är begränsat i tid (≤2 år, undantagsvis)
2. Det är en specifik uppgift (omstrukturering, kris-management, M&A-stöd)

Permanent ordförandeskap eller långsiktig styrelseplats → tjänst, inte näringsverksamhet, oavsett struktur.

## SFL 10 kap: skatteavdrag och F-skatt

**SFL 10 kap 11§.** Utbetalaren får lita på F-skatt-status endast om den anges **skriftligt** i handling upprättad i samband med uppdraget. "F-skatt" på fakturafoten räcker; muntliga uppgifter räcker inte.

**SFL 10 kap 24§.** Betalning till icke-F-skattegodkänd juridisk person utlöser skatteavdrag **30 %** + arbetsgivaravgifter. Praktiskt: kontrollera leverantörens F-skatt vid första fakturan och dokumentera kontrollen.

**Verifiering:** Skatteverkets e-tjänst "Kontrollera F-skatt" eller affärspartner-API. Lagra resultatet i klientmappen.

## 24-månadersregeln för uthyrning (LUA)

Lag (2012:854) om uthyrning av arbetstagare (LUA), uthyrningsdirektivet 2008/104/EG. Gäller bemanningsföretag, inte enmansbolag. **Klargörande:** ren konsultverksamhet (uppdrag mot resultat, ej tidsuthyrning) faller utanför LUA.

## Dokumentationschecklista för en-mans-IT-AB

För att stärka konsultupplägget och minimera reklassificeringsrisk:

- [ ] **Flera uppdragsgivare** under året (eller åtminstone aktiv marknadsföring/sökande)
- [ ] **Fastpriselement** i avtal (resultatbaserat, ej rent timpris) där möjligt
- [ ] **Egen utrustning** (laptop, programvarulicenser, hemmakontor)
- [ ] **Egen lokal eller arbetsplats**, inte permanent skrivbord hos kund
- [ ] **Ansvarsförsäkring** (företagarförsäkring + konsultansvar)
- [ ] **F-skattregistrering** + momsregistrering (verifierad)
- [ ] **Eget aktiekapital** (minimum 25 000 SEK för AB sedan 2020)
- [ ] **Marknadsföring**: webbplats, LinkedIn-företagsprofil, visitkort
- [ ] **Avtal** med uppdragsgivare som inte ser ut som anställningsavtal (inga semesterdagar, ingen lönerevision, ingen rapporteringshierarki)
- [ ] **Tidsbegränsade uppdrag** med tydlig avgränsning
- [ ] **Fakturering med specifikation** av prestation, inte bara timmar

## Risk-ranking

| Mönster | Reklassificeringsrisk |
|---|---|
| 1 kund, 100 % av omsättningen, 36+ månader | **Mycket hög** |
| 1 kund, 100 %, 12-36 mån, F-skatt + dokumenterat | Medium: HFD 2019:60 skydd om inte skenavtal |
| 2-3 kunder, växlande, eget kontor | Låg |
| 5+ kunder, egen produktutveckling | Mycket låg |
| Konsult med equity/options i kundbolag | Hög (3:12-smitta) |
| Styrelseuppdrag fakturerat via AB | Mycket hög för tjänsteklassificering |

## Lagreferenser

- IL (1999:1229) 13 kap 1§: näringsverksamhet vs anställning
- IL 57 kap 4§: verksam i betydande omfattning (3:12)
- SFL (2011:1244) 10 kap 11§: F-skatt-anteckning
- SFL 10 kap 24§: skatteavdrag vid icke-F-skatt
- Prop. 2008/09:62: F-skattereformen
- Lag (2012:854) om uthyrning av arbetstagare (LUA)
- HFD 2019:60: F-skatt-skydd
- HFD 2018 ref. 31: verksam i betydande omfattning genom AB
- HFD 2017 ref. 41: styrelsearvoden
- SKV ställningstagande dnr 8-2386895 (2023-05-25): F-skattsedelns rättsverkningar
- SKV ställningstagande dnr 8-1503440 (2022-02-22): styrelsearvoden via AB
