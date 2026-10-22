# TOTPNest

A **browser-only, single-administrator TOTP manager** built on Cloudflare Workers Free and Cloudflare D1. The Worker generates all codes. No Cloudflare Access, passkeys, MFA for the admin dashboard, guest accounts, or mobile apps are required.

## Features

- Sign in to the administration dashboard with **one admin password**.
- Add, edit, delete, and search TOTP entries.
- Supports SHA-1, SHA-256, and SHA-512; 6- or 8-digit codes; periods of 15 to 120 seconds.
- Import an `otpauth://totp/...` link or upload a QR code image. QR recognition runs in the browser; images are not uploaded.
- TOTP secrets are encrypted with AES-256-GCM by the Worker before being written to D1.
- Create multiple share links per TOTP entry, with separate expiration dates and revocation controls.
- Revoking a share permanently deletes its D1 record. Expired shares are denied immediately and physically purged by a five-minute Cron Trigger.
- Share URLs use a 22-character case-sensitive Base62 ID with approximately 131 bits of randomness, without a separate URL token.
- **Public links:** anyone holding the URL can view the shared code.
- **Password-protected links:** recipients must also enter a dedicated share password. No guest sign-up is required.
- The share page **never shows issuer, service, or account details**. It displays the code, copy control, status, countdown, and progress bar.
- The initial request fetches only the **current code**. The page requests the **next code** only during the **final five seconds** of the current period.
- The next code is visibly marked as **not yet active**, and the copy button always copies the currently valid code.
- The browser updates the countdown locally; no per-second API polling or WebSocket is required.
- Share-code and unlock endpoints have a Cloudflare-native rate limit to reduce abusive D1 reads without writing to D1 on each successful code view.
- After five incorrect admin or share-password attempts from a visitor IP within 30 minutes, block that visitor for 30 minutes. Successful share unlocks do not reset the visitor-wide failure budget.
- After ten unavailable share ID requests from a visitor IP within 24 hours, block that visitor from share access for 24 hours.

## Stack

- React 19, TypeScript, Vite, jsQR
- Cloudflare Workers with Hono and the Web Crypto API
- Cloudflare D1 (SQLite) with optional global read replication and Sessions API bookmarks
- Workers Static Assets for the SPA and security headers

## Dependency versions

Dependencies are pinned to the current stable releases as of October 23, 2026, including React 19.3.1, Hono 4.13.13, Vite 8.3.5, Vitest 5.0.5, TypeScript 7.0.2 and Wrangler 4.151.3. See `package.json` for the full version list.

## D1 read replication

TOTPNest uses the D1 **Sessions API** rather than querying the D1 binding directly. Enabling global read replication is an account/database setting in the Cloudflare dashboard; it does not require modifying the database schema.

- **Read-only admin lists** (`GET /api/admin/entries`, `GET /api/admin/shares`) start sessions with `first-unconstrained` so a nearby read replica may serve the query.
- The browser sends the most recent `X-D1-Bookmark` with subsequent admin API requests. Each response includes its session's latest bookmark, allowing reads after a write to observe at least that database version even if routed to a replica.
- **Share-code requests, share authorization, unlocks, and mutations** start with `first-primary`, so revocation and expiration checks are not performed against stale replicas. Later queries within that same session may use a replica while maintaining sequential consistency.
- **Admin session checks** explicitly query a fresh primary-first session, ensuring sign-out or session invalidation is not hidden by replication lag.
- All writes still execute against the primary database. The Sessions API does not make D1 writes faster or prevent cloud network outages.

Read replication may return an older list snapshot to a *new browser session without a bookmark*. The browser bookmark is scoped to the admin tab's session storage and is never sent from public share pages.

Cloudflare documentation: https://developers.cloudflare.com/d1/best-practices/read-replication/#use-sessions-api

## Requirements

- Node.js 22.12 or later
- A Cloudflare account with Workers and D1 enabled (the Free plan is supported)
- A domain managed through Cloudflare DNS for a Custom Domain
- Access to a terminal with Wrangler

## Deployment

### Cloudflare Workers Builds (Git-connected deployments)

Connect this repository in Cloudflare **Workers & Pages**, then configure **Settings > Builds**:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | Repository root (`/`) |
| Build command | `npm run check` |
| Deploy command | `npm run deploy:worker` |

Under **Build variables and secrets** for the production build, add both variables:

| Build variable | Value |
| --- | --- |
| `D1_DATABASE_NAME` | The exact name of your existing Cloudflare D1 database |
| `D1_DATABASE_ID` | The UUID of that same D1 database |

The committed `wrangler.jsonc` deliberately contains placeholders for both fields. `npm run prepare:wrangler` validates the build variables and writes `wrangler.generated.jsonc` at the repository root. Wrangler deploys using only this generated configuration, which is gitignored. Missing or invalid build variables stop deployment before Wrangler starts. `npm run check` uses the placeholder template solely for a dry-run build, so GitHub Actions does not require access to production database identifiers.

**Set the deploy command exactly as shown.** The `deploy:worker` script applies pending D1 migrations before deploying the Worker. Cloudflare's default `npx wrangler deploy` skips this project's generated configuration and migration step, so it must not be used for this setup. When Builds are enabled, each push to `main` triggers the configured build and deployment; GitHub Actions independently validates the code but does not deploy.

Build variables are not Worker runtime secrets. Configure `ADMIN_PASSWORD` and `DATA_ENCRYPTION_KEY` separately in **Worker Settings > Variables and Secrets**, as secret values. The application's D1 binding remains `DB`; do not put the D1 UUID in a Worker runtime `vars` binding.

The committed Wrangler template declares both runtime secrets under `secrets.required`. This declaration is preserved in `wrangler.generated.jsonc`, so Wrangler refuses a production deployment when either secret name is absent from the deployed Worker. It does **not** create secrets, validate their values, or inject build-only variables into the Worker. Add the required runtime secrets before retrying the deployment.

### First deployment and migrations

If the database does not already exist, create one first:

```sh
npm install
npx wrangler login
npx wrangler d1 create totpnest
```

Use the **same existing database name and UUID** in your Cloudflare build variables. For local CLI operations, export the two values in your shell (they are not read automatically from Cloudflare Builds or `.dev.vars`):

```sh
export D1_DATABASE_NAME="totpnest"
export D1_DATABASE_ID="your-existing-d1-database-uuid"
npm run db:migrate:remote
```

Automatic deployment applies pending remote migrations before updating the Worker. Review migrations before pushing to `main` and back up the production database first. The additive share-ID migration preserves existing entry secrets and share records, but rotates previous public links. If database migration fails, the Worker deployment stops.

Set two independent **Worker Secrets** in the Cloudflare dashboard or, when using the CLI, with the generated configuration:

```sh
npm run prepare:wrangler
npx wrangler secret put ADMIN_PASSWORD --config wrangler.generated.jsonc
npx wrangler secret put DATA_ENCRYPTION_KEY --config wrangler.generated.jsonc
```

- `ADMIN_PASSWORD`: use a unique, randomly generated password (20+ characters recommended; at least 16 are required by the Worker).
- `DATA_ENCRYPTION_KEY`: a **separate, randomly generated 32-byte key encoded as base64url**. This is not a password.

Generate a valid encryption key on your own machine:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

**Never commit real passwords, encryption keys, TOTP secrets, backup exports, or account data.**

If an API request returns `The service is missing required encryption secrets`, inspect **Workers & Pages > totpnest > Settings > Variables and Secrets**. Both secret names must exist on the deployed Worker, `ADMIN_PASSWORD` must contain at least 16 characters, and `DATA_ENCRYPTION_KEY` must decode from Base64URL to exactly 32 bytes (normally 43 unpadded characters). After adding or updating secrets in the dashboard, select **Deploy** to activate the new Worker version. Keep these values out of **Build variables and secrets**.

If you have already stored TOTP entries, **reuse the original `DATA_ENCRYPTION_KEY`**. Replacing it will make existing encrypted entries and share tokens undecryptable. A missing-secret deployment should not be repaired by generating a different encryption key if an original key exists.

Run the complete checks and deploy from a local shell with both D1 environment variables set:

```sh
npm run check
npm run deploy
```

In Cloudflare Dashboard, open **Workers & Pages > totpnest > Settings > Domains & Routes** and add your Custom Domain, such as `totp.example.com`. Visit `https://totp.example.com/admin`.

The repository deploys automatically only when **Cloudflare Workers Builds** has been enabled and configured as described above. GitHub Actions remains validation-only. No production D1 identifiers or runtime secrets are committed. Disable unneeded preview endpoints and apply appropriate Cloudflare security rules before using real TOTP secrets.

## Local development

Provide `D1_DATABASE_NAME` and `D1_DATABASE_ID` in your **shell environment**, even when working with the local D1 emulator. Both local commands use the generated Wrangler configuration but keep database operations local by default:

```sh
export D1_DATABASE_NAME="totpnest"
export D1_DATABASE_ID="your-existing-d1-database-uuid"
cp .dev.vars.example .dev.vars
# Replace both placeholders in .dev.vars with test-only credentials.
npm run db:migrate:local
npm run dev
```

Wrangler serves the built application at `http://127.0.0.1:8787` by default. Re-run `npm run dev` after changing the frontend, or run `npm run dev:ui` for the Vite frontend server against a separately running Worker. The development secrets file is ignored by Git.

## Sharing behavior

1. Sign in as the administrator and select a TOTP entry.
2. Choose **Share**, optionally require an access password, choose an expiration period, and add a private admin note.
3. Send the generated link to the recipient. Its path contains a case-sensitive, cryptographically random 22-character Base62 share ID; no URL token is needed.
4. The recipient opens the link. A password prompt is shown only for password-protected shares.
5. The page receives the current code from the Worker. Only in the final five seconds of the period does it request the next code.
6. Revoking a link immediately deletes its record. Expired links stop working at their expiration time and their records are removed automatically.

The Worker checks share-ID existence, password-unlock tickets (when applicable), expiration, revocation, and visitor lockouts **on every code request**. Expiration never depends on whether background cleanup has run. Share pages and visitor APIs do not return issuer, account, or TOTP secret.

A next code preview may **not be accepted** by the target service before its time window starts. The copy button continues to copy the current valid code.

## Security model and limitations

- The Worker **can decrypt TOTP secrets**, so this is **not an end-to-end encrypted or zero-knowledge vault**. Compromise of the Worker, its deployment access, or its encryption secret may expose TOTP secrets.
- `ADMIN_PASSWORD` is held as a Worker Secret, not in D1. Administrator sessions use random 256-bit tokens; D1 contains only session hashes. Session cookies use `HttpOnly; Secure; SameSite=Strict` on HTTPS.
- Updating `ADMIN_PASSWORD` invalidates prior admin sessions because the stored session verifier is bound to the configured password.
- Share IDs are 22 random Base62 characters (approximately 131 bits of entropy). Possession of the ID grants access to an unprotected share, so keep complete URLs private. The ID is stored in D1; a D1 data breach can expose active share links. There is no independent URL token.
- Protected-share passwords use a purpose-separated, keyed HMAC verifier derived from the Worker encryption secret. Each share has a distinct identifier. Worker and D1 rate limits discourage online guessing; **use a strong share password**.
- Successful password unlocks issue a short-lived 15-minute HMAC-signed ticket bound to the share ID. The browser keeps the ticket in session storage only.
- APIs check request origin, avoid cross-origin access, stream and cap JSON request bodies at 8 KiB, and disable caching.
- The Cloudflare rate-limiting binding caps share-code and unlock traffic together, and admin login separately, at approximately 120 requests per minute per visitor IP, per Cloudflare location. Limits are approximate rather than globally strict. D1-backed failure counters use primary-first sessions and enforce 5 incorrect admin/share-password attempts per 30-minute window (30-minute lockout) and 10 unavailable share ID requests per 24-hour window (24-hour lockout). Locks are scoped to the visitor IP, not the whole account or share; users behind shared IPs may still be affected, and attackers using many IPs can spread attempts across visitors. Configure edge security rules for additional protection.
- QR imports are limited to 10 MiB files and 20-megapixel images. TOTP imports require canonical Base32 lengths and padding bits. Static assets include a content security policy, no-referrer policy, and search-indexing restrictions.
- **Revocation cannot invalidate codes already delivered.** Replacing a compromised TOTP secret requires reconfiguring 2FA at the underlying service.
- There is no offline code generation; if the Worker or its dependencies are unavailable, fresh codes cannot be retrieved.
- The Free plan has resource and CPU limits. For significant public-sharing traffic, apply additional edge-level access rules.

## Share ID migration and compatibility

Migration `0002_share_ids.sql` adds a unique public ID to every share without deleting existing entries, shares, or their password verifiers. Existing shares receive a new 32-character, 128-bit random hexadecimal ID; new shares use the shorter 22-character Base62 format.

**All URLs created before this change are invalidated.** Previously shared UUID + fragment-token links must be replaced using the admin dashboard's **Copy link** action. Revocation and expiration metadata are preserved. The legacy token columns remain in D1 temporarily for a backward-compatible database rollout; the new application never uses these token values to authorize visitors. Do not share a URL containing an obsolete `#token=` fragment.

The new URL is a bearer capability: anyone knowing the share ID can access an unprotected share. Password-protect sensitive shares, use short expirations, and rotate or revoke compromised links.

## Share deletion and automatic expiration

- **Revoke:** `DELETE /api/admin/shares/:id` physically removes the share row in D1. The underlying TOTP entry is never deleted by share revocation. The deleted link cannot be recovered through the dashboard.
- **Expire:** requests are denied as soon as `expires_at` passes, independently of database cleanup. Admin lists exclude expired records even before they are physically removed.
- **Cleanup:** Cloudflare Cron Triggers run the Worker's `scheduled()` handler every five minutes (`*/5 * * * *`) and delete expired shares. Cron delivery can be delayed, so physical deletion is asynchronous rather than guaranteed at the exact expiration instant. Shares without expiration remain until manually revoked.
- **Existing data:** migration `0003_share_cleanup.sql` adds an expiration index and permanently removes previously revoked or expired records. Active shares, their passwords, and all TOTP entries are preserved. Back up the database before production migration if historical records matter.

Cloudflare Workers KV was intentionally not added: KV provides eventual consistency, and cached values may remain visible in some regions after deletion. Public share-code authorization continues to use primary-first D1 sessions so a revoked link stops authorizing new code requests immediately. As with any TOTP system, codes already delivered before revocation cannot be invalidated by deleting the share.

References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

## Backup and recovery

**Back up both the D1 database and the original `DATA_ENCRYPTION_KEY` separately.** Losing the encryption key makes the encrypted secrets unrecoverable.

For example, export D1 from a trusted machine:

```sh
npm run prepare:wrangler
npx wrangler d1 export DB --remote --config wrangler.generated.jsonc --output backup.sql
```

Keep exports in encrypted offline storage, **outside the repository**. Practice restoration with a separate test database before attempting a production recovery. Also retain the backup/recovery codes for important external accounts.

Do not replace `DATA_ENCRYPTION_KEY` without a deliberate migration: existing entry secrets and saved share tokens would otherwise become undecryptable. The repository does not automatically back up Cloudflare Secrets.

## Validation

```sh
npm run check
```

The CI pipeline validates code: TypeScript type checking, RFC 6238 and Base32 canonicalization tests, bounded JSON parsing, otpauth URI parsing, cryptography, D1 Sessions API routing/bookmark tests, random share ID generation, lockout behavior, share deletion and expiration cleanup, migration compatibility, build-time D1 configuration generation tests, Vite production bundling, and a Wrangler Worker dry-run build. No copywriting or language audit runs in CI. GitHub Actions runs the checks on commits to `main` and on pull requests.

## API overview

| Method | Route | Access |
| --- | --- | --- |
| POST | `/api/admin/login` | Admin password |
| POST | `/api/admin/logout` | Authenticated admin |
| GET | `/api/admin/session` | Session status |
| GET / POST | `/api/admin/entries` | Authenticated admin |
| PUT / DELETE | `/api/admin/entries/:id` | Authenticated admin |
| POST | `/api/admin/entries/:id/code` | Authenticated admin |
| POST | `/api/admin/entries/:id/next` | Authenticated admin; final 5 seconds |
| GET / POST | `/api/admin/shares` | Authenticated admin |
| GET | `/api/admin/shares/:id/link` | Authenticated admin |
| DELETE | `/api/admin/shares/:id` | Authenticated admin |
| POST | `/api/share/:id/unlock` | Valid share ID and share password |
| POST | `/api/share/:id/code` | Valid share ID; unlock ticket when protected |
| POST | `/api/share/:id/next` | Valid share ID and unlock ticket when protected; final 5 seconds |

Clients cannot select arbitrary timestamps to retrieve unlimited future codes.

## License

The repository retains its original `LICENSE` file.
