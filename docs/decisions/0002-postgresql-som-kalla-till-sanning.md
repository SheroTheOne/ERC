# ADR-0002: PostgreSQL 18 är källan till sanning

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Kontroller som bara görs i applikationen går att kringgå: med två samtidiga anrop, ett adminskript, en bugg i en ny endpoint eller en manuell ändring i databasen. För ett bokningssystem är en dubbelbokning det värsta felet som kan hända. Samtidigt är inte varje regel en integritetsregel. Hur lång framförhållning en kund måste ha är en policy som personalen ska kunna gå förbi.

## Beslut

**PostgreSQL 18.** Versionen ger `uuidv7()`, multiranges (finns sedan 14) och `btree_gist`. Allt ligger i schemat `erc`, och varje funktion har en fast `search_path`.

Reglerna delas in i två grupper:

| Typ | Var | Exempel |
| --- | --- | --- |
| **Invariant**: får aldrig brytas, oavsett vem som skriver | Databasen: constraint eller trigger | Ingen överlappning per personal (inklusive buffert). En aktiv bokning ligger inom personalens öppna tid. Personalen utför tjänsten. Personalen är aktiv. Giltiga intervall. Tidszonen finns. |
| **Policy**: gäller en viss kanal eller roll | Applikationen | Minsta framförhållning, hur långt fram man kan boka, gräns för avbokning, att kunder bara ser sina egna bokningar |

Invarianterna i triggern kontrolleras **när en aktiv bokning skapas eller flyttas**. En senare ändring av schemat, som ny frånvaro eller kortare arbetstid, underkänner inte befintliga bokningar. De visas i stället som konflikter som personalen får hantera (ringa kunden, flytta tiden).

Det här är ett medvetet val med samtidighet i åtanke. Om ny frånvaro och en ny bokning skrivs samtidigt kan båda gå igenom. Resultatet är då detsamma som om bokningen hade gjorts först och frånvaron lagts in efteråt, vilket redan är ett tillåtet tillstånd. Vi behöver alltså varken lås mellan schemaändringar och bokningar eller isoleringsnivån `SERIALIZABLE` för att kunna garantera invarianten. Om frånvaro i stället skulle få underkänna befintliga bokningar skulle det krävas ett lås på personalraden, och en sjukanmälan skulle misslyckas om det redan fanns bokningar, vilket är fel beteende i verkligheten.

**En installation motsvarar ett företag** (tabellen `business` har exakt en rad). Multi-tenancy ligger utanför första versionen.

## Konsekvenser

- Felkoder från databasen (`23P01`, `23514` med constraint-namn) är en del av kontraktet och översätts till RFC 9457-fel i ett enda lager (ADR-0007). Därför har alla viktiga constraints namn.
- Logiken för öppettider finns på ett ställe, i SQL-funktionen `staff_open_periods`, som används både av triggern och av tillgänglighetsmotorn (ADR-0005).
- Triggers körs i bokstavsordning efter namn. De numreras (`booking_10_…`, `booking_20_…`) eftersom ordningen spelar roll. Valideringen av schemautkastet hittade just den buggen.

## Alternativ som valdes bort

- **Kontroller bara i applikationen:** uppfyller inte grundkravet.
- **`SERIALIZABLE` överallt:** ger korrekthet men kräver att alla skrivningar görs om vid serialiseringsfel, och felen blir svårare att förklara för klienten. Det behövs inte när constraints kombineras med resonemanget ovan.
- **PostgreSQL 18:s `WITHOUT OVERLAPS`:** stöder inte delvillkor som `WHERE status <> 'cancelled'`, så `EXCLUDE` behövs ändå.
