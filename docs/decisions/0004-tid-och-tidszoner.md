# ADR-0004: Arbetstider i väggklocka, allt annat i absolut tid

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

"Anna jobbar måndagar 09–17" är en regel i lokal tid. Den ska betyda 09:00 lokal tid både i januari (08:00Z) och i juli (07:00Z). En bokning däremot är ett bestämt ögonblick. Om de två sorterna blandas ihop förskjuts schemat en timme vid sommartid, eller så räknas en bokning som korsar en omställning fel.

## Beslut

| Data | Typ | Varför |
| --- | --- | --- |
| `working_hours` | `weekday` (ISO, 1 = måndag), `time`, `time`, giltighet som `date`-intervall | Regel i väggklocka. Räknas om till absolut tid för varje lokal kalenderdag. |
| `booking`, `time_off`, sessioner | `timestamptz` / `tstzrange` | Absoluta ögonblick |
| Företagets tidszon | `business.timezone` (IANA, valideras mot `pg_timezone_names`) | En plats per installation |

- **Omräkningen görs i en enda funktion,** `staff_working_periods`: `(dag + tid) AT TIME ZONE business.timezone`. Den är oberoende av sessionens `TimeZone`, vilket valideringen testar.
- **Arbetspass över midnatt stöds inte.** De delas upp i två rader. `end_time = '24:00'` är tillåtet och betyder slutet av dygnet. Det gör att `end_time > start_time` alltid gäller och att uträkningen blir enkel.
- **Längd är absolut tid.** En behandling på 60 minuter som korsar omställningen tar 60 verkliga minuter.
- **Tidsrutnätet förankras i lokal tid.** Med steget 15 minuter börjar luckor 09:00, 09:15 och så vidare i lokal tid, oavsett UTC-offset.
- **Lokala tider som inte finns eller finns två gånger** (02:00–03:00 vid omställningarna i Sverige) löser PostgreSQL deterministiskt. En regel som börjar 02:30 en vårnatt blir 03:30 sommartid. Ingen salong arbetar då, men beteendet är definierat och testat.
- **API:** tidpunkter skickas och tas emot som ISO 8601 med offset och normaliseras till UTC (`Z`) i svaren. Datumparametrar (`?date=2026-03-29`) tolkas som lokala dagar i företagets tidszon. Svaren innehåller `timezone` så att klienten kan visa rätt lokal tid.
- **Heldagsfrånvaro** ("ledig 24 december") anges som lokala datum i API:t och räknas om till `tstzrange` när den skrivs. Om företaget senare byter tidszon ligger redan sparad frånvaro kvar på samma absoluta tid. Det är rätt för frånvaro som redan har skett, och ett tidszonsbyte är en sällsynt administrativ händelse som får visa en varning.

## Konsekvenser

- Valideringen täcker vårens och höstens omställning (3 respektive 5 verkliga timmar för passet 01–05), att 09:00 lokal tid hamnar på olika UTC-tid före och efter omställningen, och att resultatet inte beror på sessionens tidszon.
- Frontend använder `Intl.DateTimeFormat` med `timeZone` från API:t och räknar aldrig med webbläsarens tidszon. `Temporal` används där det finns stöd.

## Alternativ som valdes bort

- **Arbetstider som `timestamptz`:** förskjuts vid omställningen.
- **Spara allt som lokal `timestamp`:** omställningsnatten blir tvetydig och det går inte att jämföra tider korrekt.
- **Tidszon per personal:** behövs inte så länge företaget har en plats.
