# ADR-0012: Deadlock vid samtidiga INSERT mot EXCLUDE hanteras med omförsök

- **Status:** Accepterad
- **Datum:** 2026-11-07
- **Kompletterar:** ADR-0003

## Kontext

ADR-0003 utgick från att en transaktion som krockar med en annan, ännu inte committad bokning väntar på den och sedan får `23P01`. Samtidighetstestet i Fas 2 (20 bokningar av samma tid, släppta samtidigt bakom en spärr) visade att det inte alltid stämmer i PostgreSQL 18.

Exakt en bokning vann i alla körningar, så constraintet höll. Förlorarna fick däremot ofta `40P01 deadlock detected` i stället för `23P01`. Varje INSERT lägger först in sin indexpost och letar sedan efter krockar. Två transaktioner som gör det samtidigt hittar varandras poster och väntar på varandra. Deadlock-detektorn avbryter då den ena efter `deadlock_timeout`, som är 1 sekund som standard. Unika B-tree-index har specialhantering för det här fallet, men exclusion constraints har det inte.

Utan hantering blev förlorarna 500 i stället för 409. Vid "valfri personal" prövades dessutom aldrig nästa person.

## Beslut

- **Omförsök i samma savepoint:** när ett bokningsförsök avbryts med `40P01` rullas savepointen tillbaka och samma försök görs om, högst 5 gånger per person. Det nya försöket väntar på den transaktion som överlevde och får ett definitivt svar: lyckat, `23P01` (409, eller nästa person vid valfri personal) eller `booking_within_open_hours`.
- **Säkerhetsnät:** om omförsöken tar slut mappas `40P01` till `503 service-unavailable`, aldrig 500. Klienten kan försöka igen med samma `Idempotency-Key`.
- **Testet på SQL-nivå** kräver exakt en vinnare och tillåter bara `23P01` och `40P01` för förlorarna. Det dokumenterar databasens faktiska beteende. Testet över HTTP kräver exakt en 201 och 409 för alla andra.

## Konsekvenser

- Integriteten vilar fortfarande enbart på constraintet. Omförsöken påverkar bara vilket svar förlorarna får.
- Vid verklig samtidig konkurrens om samma tid kan en förlorare få upp till några sekunders extra svarstid (en `deadlock_timeout` per deadlock). Det händer bara när flera bokar exakt samma tid inom millisekunder, vilket är sällsynt för en salong.

## Alternativ som valdes bort

- **Rådgivande lås per personal före INSERT:** förhindrar deadlocks, men serialiserar alla bokningar för samma person, även på olika tider. Vid valfri personal måste dessutom låsen tas i en fast ordning för alla kandidater i förväg. Låsen skulle inte heller vara knutna till savepointen. Det är mer komplicerat än omförsök och behövs inte i den här skalan.
- **Lägre `deadlock_timeout`:** en serverinställning som påverkar alla transaktioner, för att lösa ett problem i en enda kodväg.
- **Att mappa `40P01` direkt till 409:** fel om den överlevande transaktionen senare rullas tillbaka av andra skäl. Då skulle tiden vara ledig trots att klienten fått svaret att den är upptagen.
