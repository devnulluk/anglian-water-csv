# Privacy audit — 15 September 2026

Scope: application source, all 23 committed file versions in the three existing Git commits, pinned authentication library source, Docker build inputs, Compose configuration, frontend storage and CSV output. No real customer credentials were supplied to the audit. Usage is treated as non-private; credentials, account identifiers, tokens and other account information are private.

## Findings and fixes in 0.1.1

- The old readings handler returned the complete upstream usage payload. It now builds a new response using only numeric consumption/cumulative readings, timestamps and anonymous meter labels. Unknown fields at every level are discarded. Invalid usage values fail closed with a generic error. Real meter serial numbers are not exported.
- Email and account inputs previously remained in the DOM after login. All login fields now clear at submission; verification codes clear on every attempt. Autocomplete is disabled as a hint to the browser.
- The library kept decoded identity claims and login cookies in memory. A small adapter now removes unnecessary claims and login artifacts after login, MFA and token refresh. Logout/expiry clears all authentication-object attributes and the HTTP cookie jar before closing the connection.
- The app's session cookie now has no persistent expiration. The server still expires sessions after 30 minutes without login, verification or a readings request; checking connection status does not extend that period. Background cleanup runs every 30 seconds.
- Production Python logging is disabled, and Compose uses Docker's `none` log driver, disables core dumps and sets memory-plus-swap equal to the memory limit. The filesystem remains read-only, with no persistent volumes. The app has no database or filesystem writes containing customer data.

## Data lifecycle

| Data | Where and for how long |
| --- | --- |
| Password | Browser/request/authentication memory during the login attempt; application references discarded afterward, including pending MFA. |
| Email | Login request memory; the provider's MFA email remains in memory while verification is pending, then is discarded. |
| Account number, partner identifier, access/refresh tokens | Server session memory while needed to fetch usage, until logout, expiry or restart. Tokens can themselves contain identity claims and must be treated as private. |
| Other identity information returned during login | Transient library response memory; unnecessary decoded claims and ID tokens are removed from retained auth state. |
| Usage response | Transient server memory, then an allowlisted response in browser memory. No server archive. |
| CSV | Saved on the user's device at their request; usage and anonymous meter labels only. |
| Application session cookie | Opaque credential in the browser, HttpOnly, SameSite Strict and Secure on HTTPS. No email, account number or upstream token is included. Server revokes it on logout/expiry. |

There is no localStorage, sessionStorage, IndexedDB, analytics or external frontend script. Responses send `Cache-Control: no-store`. No bill, payment, address, profile or associated-account endpoint is requested by this app. The provider's login/token responses may inherently include identity information, which is processed transiently.

## Verification

- 24 automated tests: 16 Python and 8 JavaScript. Includes authenticated response filtering with planted private metadata, rejection of private/non-numeric values in usage fields, auth cleanup, session isolation, logout, expiry, error redaction, MFA and CSV/DST correctness.
- Git history scan found no non-fixture email addresses, private keys, GitHub/AWS credentials or JWTs in committed file contents. Manual review found only synthetic account/password fixtures. This is a scoped review, not proof that every possible secret format can be detected.
- Docker build uses explicit application/dependency/static copies and an allowlist `.dockerignore`; Git metadata, tests, local work and configuration files are excluded from the image.
- Live Mobius inspection confirmed the 0.1.1 image, log driver `none`, empty log path, no persistent mounts, read-only root, core limit 0 and matching memory/swap limits. Public HTTPS health and release assets were verified; the sample preview still worked.
- Public source includes deployment hostnames, private-network IP addresses and normal Git commit attribution. These are infrastructure documentation, not Anglian Water customer identifiers.

## Limits: what “not saved” does not guarantee

The application does not intentionally persist customer identity or credentials. It cannot guarantee that nothing private is ever saved anywhere in the full chain:

- Browser password managers can ignore autocomplete hints; session restore, developer tools, extensions and OS crash/swap facilities are outside the app's control. Session cookies are credentials too. The app cannot delete previously saved passwords.
- Cloudflare terminates HTTPS before forwarding through the tunnel. Cloudflare and Anglian Water/Microsoft can process the submitted information. Their internal logging, retention, backups and account-wide rules were not audited. The upstream library sends an email login hint in its authentication URL to the provider; the app never puts credentials in its own page URLs.
- Host administrators can inspect memory. Host snapshots, existing backups, hypervisor dumps and prior logs are outside this source review. Disabling container logs does not retroactively erase external logs. No historical private logs were inspected or deleted.
- Python and JavaScript strings are garbage-collected, not securely overwritten. Clearing references reduces retention but is not forensic erasure. Memory-only also does not mean the server never receives credentials.

A real-account end-to-end export still requires account-holder validation. No guarantee is made about how much usage history the upstream service returns.
