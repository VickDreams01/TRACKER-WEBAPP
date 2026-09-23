# Implementation review

The supplied project contained a static application, a Supabase compatibility adapter, one migration and four edge functions. The original README described a seeded administrator and sample database records that the migration did not create. Startup attempted protected writes before authentication, preventing a fresh deployment from initializing.

## Changes

- Explicit public runtime configuration and setup mode; production no longer silently uses in-memory demo data.
- Removed unauthenticated startup seeding and public first-account creation. Added a trusted-machine bootstrap script and empty operational database initialization.
- Staff subscriptions start after login, restore after reload and stop on logout; logout clears cached operational data. Existing standalone URL redirects to the maintained app.
- Added active-membership RLS, private staff-provisioning functions, transactional profile/role changes, last-superadmin protection and real Auth deletion.
- Moved warehouse processing, dispatch, delivery, exceptions and rebooking to locked, state-validated database operations. Deletion approval and parcel removal are one transaction.
- Replaced read/replace document updates with atomic JSON patches. Added paginated collection loading so older records do not disappear after 300/1000 bookings.
- Booking input validation, cryptographic tracking IDs and unique booking request IDs prevent accidental duplicate retry bookings. Notification updates cannot overwrite concurrently changed parcel status.
- Public tracking returns route/service/history only. Customer contacts, addresses, staff actors and internal notes stay private.
- Notifications report provider acceptance/failure honestly, time out external calls and can be sent later from parcel details. Results are retained on the parcel and notification table.
- Activity rows use the correct UI field names. Client activity is stamped with the authenticated identity; ordinary staff cannot read the superadmin activity feed or edit existing logs.
- Preserved typed form values during live updates, surfaced asynchronous operation errors, and replaced the misleading “Returned to sender” text for general exceptions.
- Added local serving, dependency lockfile, CLI function configuration, database/adapter/function/browser tests and new-project deployment instructions.

## Verification boundaries

The automated suite exercises PostgreSQL/RLS functions using PGlite, real edge handlers with HTTP fixtures, adapter behavior, and Chromium UI flows. It does not replace a deployed Supabase integration test. No production project or messaging credentials were supplied; no real accounts, hosted database, external messages or public deployment were created.

Before live use, follow README setup and run its real-service acceptance checklist. A background notification queue, delivery webhooks, live maps/GPS, payments and route optimization are outside the current system. Provider acceptance is not confirmed delivery. Use backups and provider monitoring suitable for your operation.

## Verified in this workspace

- `npm test`: 10 database and adapter tests passed.
- `npm run test:edge`: 7 function tests passed.
- `npm run test:browser`: 3 Chromium tests passed.
- `npm run check`: all five edge functions passed Deno type checking.

The browser runs cover setup mode, demo booking → warehouse → dispatch → delivery, and configured login → protected data load → logout/cache clearing. The configured backend is an HTTP fixture, not a deployed Supabase project.
