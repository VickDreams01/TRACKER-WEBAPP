# Stallionking Tracker

Parcel operations for a logistics team: staff login → book parcel → receive/process in warehouse → assign rider → deliver or report an exception → rebook if needed. Customers can look up progress using a tracking number. Clients, riders, staff, notifications, deletion requests and activity records persist in Supabase.

The app now starts in **setup mode**, not a pretend production session. Demo mode is opt-in and does not persist records or send messages. A new production database starts without sample customers, riders, parcels or a shared password.

## Run locally

Requires Node.js 22+ and npm. From this directory:

```sh
npm ci
npm start
```

Open http://localhost:8080. Edit `frontend/config.js` to connect your project. For a temporary UI demonstration only, set `demo: true`; the demo login is `SK-0001` / `admin123`. Leave `demo: false` for real use.

## Create the new Supabase backend

1. Create a project at https://supabase.com/dashboard. Keep its database password in your password manager.
2. In Authentication settings, disable public user signups. Staff accounts are created by administrators. The local CLI configuration also disables signup.
3. Install or run the Supabase CLI, sign in, link the project, apply **both migrations**, and deploy all five functions:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase functions deploy
```

Run these commands from `stallionking-backend/`. If using the dashboard SQL editor instead, run `0001_init.sql` and then `0002_workflows.sql`, once each, in order. Do not rerun the original migration after the second migration: it contains the original permissive policies which the second migration replaces.

The function configuration disables the gateway's legacy JWT check; each private handler independently verifies the bearer token with Supabase Auth and checks the account is an active staff member. `track` is the public GET endpoint. This supports publishable keys and newer signing keys. See the official [API-key migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys), [deployment guide](https://supabase.com/docs/guides/functions/deploy), and [database migration workflow](https://supabase.com/docs/guides/local-development/cli-workflows).

## Create the first administrator

There is deliberately no public bootstrap endpoint. Run the included script on your trusted machine using your project's URL and **legacy service-role key** from Project Settings → API. These values belong in your terminal environment, never in frontend files or Git.

In zsh, enter the key and password without putting their contents in shell history:

```sh
export SUPABASE_URL='https://YOUR_PROJECT_REF.supabase.co'
read -rs 'SUPABASE_SERVICE_ROLE_KEY?Service-role key: '
export SUPABASE_SERVICE_ROLE_KEY
export STAFF_ID='SK-0001'
export STAFF_NAME='System Administrator'
read -rs 'STAFF_PASSWORD?New password (12+ characters): '
export STAFF_PASSWORD
npm run bootstrap
unset SUPABASE_SERVICE_ROLE_KEY STAFF_PASSWORD
```

This creates a real Auth account and its linked superadmin profile. The script refuses to bootstrap when staff already exist. Subsequent accounts are created in **Admin Users**. If all accounts are inaccessible, use the Supabase dashboard's Auth administration and database tools on a trusted administrator account to recover access.

## Connect the frontend

Set these public values in `frontend/config.js`:

```js
window.TRACKER_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  supabaseAnonKey: 'YOUR_PUBLISHABLE_OR_ANON_KEY',
  demo: false,
};
```

Refresh the app and sign in with the administrator you created. Add riders from Dispatch, add frequent senders from Clients, and book the first parcel from Warehouse. The migration enables Realtime on operational tables; check Database → Replication if other tabs do not receive updates.

## Enable tracking messages

Create a Resend account with a verified sender domain and a Termii account with an approved sender ID. Configure their credentials as server secrets, using a local ignored file such as `.env.providers`:

```dotenv
RESEND_API_KEY=your_key
RESEND_FROM=Stallionking Tracker <tracking@your-domain.example>
TERMII_API_KEY=your_key
TERMII_SENDER_ID=YourSender
```

```sh
npx supabase secrets set --env-file .env.providers
```

**Save Parcel** saves without sending. **Save & Send Tracking ID** attempts messages to supplied sender/receiver contacts. The confirmation distinguishes provider acceptance from failure; acceptance is not proof of final delivery. Admin parcel details include a **Send tracking ID** button for sending later or retrying failed sends. Each click sends to all supplied contacts, so use it deliberately. Missing provider keys do not prevent booking.

## Host the frontend

Upload the contents of `frontend/` together to a static HTTPS host. There is no build step. Use `parcel-tracker.html` or the supplied `index.html` as the entry point. The old standalone filename redirects to the same maintained app. The page loads Supabase JS and fonts from external CDNs.

Do not upload `.env` files, service credentials, tests, or `node_modules`. Configure your actual HTTPS origin and Supabase project before sharing the site with staff.

## Verification

```sh
npm test                 # PostgreSQL integration tests in PGlite
npm run check            # Deno type checks for all edge functions
npm run test:edge        # Function authentication, validation and privacy tests
npx playwright install chromium
npm run test:browser     # Browser smoke tests and demo workflow
```

PGlite executes the schema and RLS/workflow functions with simulated Auth identities; it does not run hosted Supabase Auth, PostgREST or Realtime. Browser tests use local fixtures and demo data. After deployment, complete this real-service check:

1. Sign in and add a rider and client. Open a second staff tab and confirm new records appear.
2. Book a parcel, refresh, and confirm it persists. Process it in Warehouse, assign the rider in Dispatch, and mark it delivered.
3. Look up that number in a signed-out browser. Only route, service and progress should be visible.
4. Create a staff account, deactivate it, and confirm it can no longer read or change operational records.
5. Submit a deletion request as staff; approve it as admin. Test an exception and rebooking on a separate parcel.
6. Send a tracking message to a real test inbox/phone and confirm arrival. Review provider logs for any rejected messages.

## Operational behavior and limits

- Database rules enforce active staff membership. Parcel transitions and deletion approvals execute atomically, with current-state validation; direct parcel edits from a browser are denied.
- Staff creation and changes use private functions. Role/profile updates are transactional and the last active superadmin cannot be disabled, demoted or removed.
- Booking uses a unique request ID so retrying the same form submission does not create a second parcel. Refreshing the page creates a new request; search existing bookings before manually resubmitting after an uncertain network outcome.
- Logout clears operational records from browser memory and stops subscriptions. The adapter pages through records instead of silently truncating at Supabase's default row limit.
- Tracking responses omit names, contact details, delivery addresses, staff actors, internal notes and notification content. Tracking numbers use cryptographic randomness.
- Address suggestions are a local curated list, not live geocoding. There is no GPS tracking, billing, payment collection or automatic route optimization.
- Message sending is synchronous with timeouts. There is no background delivery queue, webhook delivery confirmation, automatic retry scheduler or application-level rate limiter. Use provider logs and the manual send action for recovery.
- Activity history records operational events, but is not a certified tamper-proof audit archive. Configure backups/retention in your Supabase project and verify restore procedures for your business.

See `IMPLEMENTATION.md` for the changes and verification scope.
