# Arkitekturbeslut (ADR)

Varje större tekniskt beslut dokumenteras som en kort ADR enligt mallen i [`0000-mall.md`](0000-mall.md). En ADR ändras inte i efterhand. Om ett beslut ändras skrivs en ny ADR som ersätter den gamla, och den gamla får status *Ersatt av ADR-NNNN*.

| ADR | Beslut | Status |
| --- | --- | --- |
| [0001](0001-monorepo-och-verktyg.md) | Monorepo med npm workspaces, Node.js 26, strikt TypeScript | Accepterad |
| [0002](0002-postgresql-som-kalla-till-sanning.md) | PostgreSQL 18 är källan till sanning, med en tydlig gräns mellan invarianter och policy | Accepterad |
| [0003](0003-dubbelbokning-och-samtidighet.md) | Dubbelbokning stoppas av `EXCLUDE` på blockerad tid inklusive buffert, plus idempotensnycklar | Accepterad |
| [0004](0004-tid-och-tidszoner.md) | Arbetstider i väggklocka, allt annat i `timestamptz`, en tidszon per företag | Accepterad |
| [0005](0005-tillganglighetsmotor.md) | Fria intervall räknas ut i SQL med multiranges, tidsluckor genereras i en ren TypeScript-funktion | Accepterad |
| [0006](0006-dataatkomst-och-migreringar.md) | Kysely och node-postgres, migreringar som rena SQL-filer | Accepterad |
| [0007](0007-api-kontrakt-och-fel.md) | TypeBox-scheman, OpenAPI genereras från koden, fel enligt RFC 9457 | Accepterad |
| [0008](0008-autentisering-och-behorighet.md) | Egna sessioner i PostgreSQL, `__Host-`-cookie, tre roller | Accepterad |
| [0009](0009-teststrategi.md) | Vitest mot riktig PostgreSQL via Testcontainers, Playwright för flöden | Accepterad |
| [0010](0010-personuppgifter.md) | Minimal insamling, export och anonymisering i stället för radering | Accepterad |
| [0011](0011-typescript-utan-byggsteg.md) | Node kör TypeScript direkt, TypeScript 6 för typkontroll | Accepterad |
| [0012](0012-deadlock-vid-exclude.md) | Deadlock vid samtidiga INSERT mot `EXCLUDE` hanteras med omförsök | Accepterad |

Öppna frågor som ännu inte har en ADR: driftsättning (Fas 5) och genomgången av liknande system.
