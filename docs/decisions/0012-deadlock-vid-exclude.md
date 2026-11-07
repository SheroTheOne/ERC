# ADR-0012: Deadlock vid samtidiga INSERT mot EXCLUDE förhindras med ordnade lås

- **Status:** Accepterad
- **Datum:** 2026-11-07
- **Kompletterar:** ADR-0003

## Kontext

ADR-0003 utgick från att en transaktion som krockar med en annan, ännu inte committad bokning väntar på den och sedan får `23P01`. Samtidighetstestet i Fas 2 (20 bokningar av samma tid, släppta samtidigt bakom en spärr) visade att det inte alltid stämmer i PostgreSQL 18.

Exakt en bokning vann i alla körningar, så constraintet höll. Förlorarna fick däremot ofta detta fel i stället för `23P01`:

```
40P01 deadlock detected
Process 487 waits for ShareLock on transaction 947; blocked by process 364.
Process 364 waits for ShareLock on transaction 948; blocked by process 487.
while checking exclusion constraint on tuple (12,2) in relation "booking"
```

Varje INSERT lägger först in sin indexpost och letar sedan efter krockar. Två transaktioner som gör det samtidigt hittar varandras poster och väntar på varandra. Deadlock-detektorn avbryter den ena efter `deadlock_timeout`, som är 1 sekund som standard. Unika B-tree-index har specialhantering för det här fallet, men exclusion constraints har det inte.

Konsekvenserna var två:

1. **Första försöket:** förlorarna fick 500 i stället för 409, och vid "valfri personal" prövades aldrig nästa person.
2. **Andra försöket, med enbart omförsök:** deadlocks uppstod i flera vågor bland 20 samtidiga transaktioner, med en sekunds väntan per våg. Svarstiden blev tiotals sekunder.

## Beslut

1. **Rådgivande lås per personal före INSERT.** Bokningsflödet tar `pg_advisory_xact_lock` för varje kandidat i personalen, i id-ordning och ett i taget, innan det skriver. Konkurrerande bokningar för samma person köas därför. Den som kommer efter får `23P01` direkt i stället för att hamna i en deadlock. Eftersom låsen alltid tas i samma ordning kan två transaktioner inte vänta på varandra i cirkel. Låsen gäller transaktionen, så de släpps vid commit eller rollback.
2. **Omförsök som andra skydd.** Om en annan skrivväg som inte tar låset ändå orsakar `40P01` (till exempel personalens administration i Fas 3), görs försöket om i samma savepoint, högst 5 gånger.
3. **Säkerhetsnät.** `40P01` som når felhanteraren blir `503 service-unavailable`, aldrig 500.
4. **Testet på SQL-nivå** körs utan appens lås, med kort `deadlock_timeout`. Det kräver exakt en vinnare och tillåter bara `23P01` och `40P01` för förlorarna, och dokumenterar på så sätt databasens faktiska beteende. Testet över HTTP kräver exakt en 201 och 409 för alla andra.

## Konsekvenser

- Integriteten vilar fortfarande enbart på `booking_no_overlap`. Låsen påverkar bara vilket svar förlorarna får och hur snabbt det kommer. En skrivväg som glömmer låset kan aldrig skapa en dubbelbokning, bara en långsammare förlorare.
- Bokningar för samma person köas även när de gäller olika tider. Varje bokningstransaktion tar några millisekunder, så det spelar ingen roll i en salongs skala.

## Alternativ som valdes bort

- **Enbart omförsök:** korrekt, men med 20 samtidiga transaktioner blev svarstiden tiotals sekunder (se ovan).
- **Lägre `deadlock_timeout` för appen:** en serverinställning som påverkar alla transaktioner, och som ändå inte tar bort vågorna av deadlocks.
- **Att mappa `40P01` direkt till 409:** fel om den överlevande transaktionen senare rullas tillbaka av andra skäl. Då skulle tiden vara ledig trots att klienten fått svaret att den är upptagen.
- **`SERIALIZABLE`:** ger serialiseringsfel i stället för deadlocks, vilket är samma problem med ett annat namn.
