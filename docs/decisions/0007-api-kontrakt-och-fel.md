# ADR-0007: TypeBox-scheman, genererad OpenAPI och fel enligt RFC 9457

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Varje request ska valideras vid gränsen. Kontraktet ska delas med frontend och dokumenteras utan att det skrivs två gånger. Fel ska ha ett format som klienter kan hantera maskinellt.

## Beslut

- **TypeBox** i `packages/contracts`. Ett schema är samtidigt JSON Schema (som Fastify validerar med Ajv), en TypeScript-typ (`Static<typeof X>`) och underlag för OpenAPI.
- **OpenAPI 3.1 genereras** från route-schemana med `@fastify/swagger`. CI kontrollerar att den incheckade `docs/api/openapi.json` stämmer med koden.
- **Även svar valideras** (Fastifys serializer med svarsschema). Fält som inte finns i schemat skickas aldrig ut, vilket skyddar mot att till exempel `password_hash` läcker.
- **Fel enligt RFC 9457** (som ersätter RFC 7807, och formatet är kompatibelt) med `Content-Type: application/problem+json`:

```json
{
  "type": "https://erc.example/problems/slot-unavailable",
  "title": "Tiden är inte längre ledig",
  "status": 409,
  "detail": "Tiden 2026-03-30T07:00:00Z hos vald personal krockar med en annan bokning.",
  "instance": "/bookings",
  "requestId": "01J…"
}
```

- **Felen översätts på ett ställe:** domänfel (`SlotUnavailableError` med flera) och databasfel (`23P01`, `23514` med constraint-namn, `23505`) mappas av en enda felhanterare. Okända fel ger 500 utan intern information. Hela felet loggas med `requestId`.
- Katalogen över feltyper finns i [`docs/api/README.md`](../api/README.md#fel).

## Konsekvenser

- Ajv körs i strikt läge med `removeAdditional: false` och `additionalProperties: false` på alla scheman. Okända fält ger 400 i stället för att tyst ignoreras.
- Valideringsfel får en egen problemtyp med en lista över fält (`errors[]`).

## Alternativ som valdes bort

- **Zod:** bra utvecklarupplevelse, men kräver konvertering till JSON Schema för Fastify och OpenAPI, och valideringen är långsammare än Ajvs kompilerade validering.
- **Handskriven OpenAPI:** glider isär från koden.
