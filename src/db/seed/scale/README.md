# Scale seed (`pnpm db:seed:scale --profile small|mid|large`)

Seeds one profile as its own company in a **scratch** database. Entry point `index.ts`; the guard
(`guard.ts`) refuses any database not named `invai_scale_*`, a Valkey DB outside 10-13 and a
blank `SEED_OUTPUT_FILE`. `pnpm db:seed` and `seed/index.ts` never import this folder.

## What a profile writes
Company, staff (login per member), stations, vendors, channels, designs, SKUs and `historyDays` of
orders with items, transitions, gang sheets, transfers, reprints and profit lines, plus (T-55-3):

- **Floor logins.** One 6-digit PIN per presser, packer and receiver member (`setPin`) and one
  live token per station (`issueStationToken`), created by the app's own functions, so the
  database holds hashes only. Plaintext goes to `SEED_OUTPUT_FILE` (mode 0600) under `floor`:
  `stations[{id,kind,token}]`, `members[{email,role,pin}]`, `scanTargets` (up to 400 transfer ids
  of open units, press-ready first). Nothing is printed or logged.
- **Shipments.** One per order with a shipped or delivered unit: carrier `usps`, mock id
  `shp_mock_<n>`, unique `9400 1000 0000 ...` tracking, `delivered` only when every shipped unit
  is delivered. `label_key` and `label_format` are NULL on purpose (no `files` rows exist; a key
  would name a missing object, B-403). No `labels` rows (`labels.label_key` is NOT NULL).
- **Fake buyer data** in `buyer_pii` through the drizzle table (`encryptedText`, so AES-GCM at
  rest) for every undelivered order and for delivered ones inside the 30-day retention window
  (`purge_after = delivered_at + 30 d`). Names from the demo lists, `@example.com`, `602-555-01NN`.

None of this draws from the order rng, so the order, sheet and transfer rows are unchanged.

## Scratch run (no `.env`)
Set `INVAI_SKIP_DOTENV=1` and by name: `DATABASE_URL` (app role) and `MIGRATION_DATABASE_URL`
(owner) on `invai_scale_<tag>`, `REDIS_URL=redis://localhost:6379/10`, `S3_*` (bucket
`invai-test`), `IMAGING_URL` on a closed port, fake `BETTER_AUTH_SECRET` and `FLOOR_TOKEN_SECRET`
(32+ chars; the API that reads the credentials needs the same values), `FIELD_ENCRYPTION_KEY`
(`k1:` + base64 of exactly 32 bytes) and `SEED_OUTPUT_FILE=/tmp/<dir>/creds.json`. Then
`createdb`, `pnpm db:migrate`, `pnpm db:seed:scale --profile <name>`. A failed run leaves a
half-seeded company: drop the database and start again.

## Row-count snapshot (`../row-counts.snapshot.json`)
It counts a **plain** `pnpm db:seed`, which this folder never touches, so a scale change does not
re-record it. To check it: seed a fresh scratch database with plain `db:seed` (imaging up for real
art), then `MIGRATION_DATABASE_URL=<that db> tsx src/db/seed/scale/row-counts.ts --check
src/db/seed/row-counts.snapshot.json` (exit 0 = unchanged, 1 = differences listed). Re-record only
when the **plain seed** changes on purpose and `--check` fails for that reason: run the same
command with `--write` on that scratch database and commit the file with the seed change, as its
own commit that states the reason.
