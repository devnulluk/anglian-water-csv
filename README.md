# Water Ledger

A small self-hosted web app that signs in to Anglian Water and exports **available hourly smart-meter usage as CSV**. Runs as one Docker container, with a Portainer configuration for Mobius.

## Use

1. Open the app over HTTPS.
2. Enter your Anglian Water email, password and the numeric account number from your bill.
3. If requested, enter the email verification code from Anglian Water.
4. Choose inclusive UK dates, load the available readings and select a meter (or all meters).
5. Review the preview and download your CSV. Incomplete exports require an explicit acknowledgement.
6. Sign out to clear the server session and displayed data.

The sample-data button works without a water account. Sample downloads are clearly named `SAMPLE-...csv`.

**Status:** initial implementation. Automated checks cover session isolation, MFA, logout, error redaction, CSV integrity and clock changes. A real Anglian Water login/export still needs account-holder validation; no live credentials were used during development.

## What date ranges are available?

This app calls the hourly smart-meter endpoint used by `pyanglianwater` 3.3.2:

```
GET /myaccount/v1/accounts/{encrypted-account}/usage/smartmeter/frequency/10
```

The inspected library exposes **no start/end parameters or pagination for this usage endpoint**. Date selection filters the history actually returned; it does not promise unlimited historical retrieval. The date parameters on a different *cost* endpoint are not evidence that historical hourly *usage* can be fetched. The UI reports available history and counts missing meter-hours. Missing values are never fabricated as zero.

Only smart/enhanced smart meters are supported. New readings can be delayed. This app does not poll or retain history between sessions; download and keep exports if you need an archive.

## Privacy and authentication

This Docker version is **not browser-only**. Credentials travel browser → your server → Anglian Water and its Microsoft identity service. If you use Cloudflare Tunnel, Cloudflare also terminates HTTPS in that path. Use an HTTPS hostname and a trusted server; server administrators can technically inspect process memory.

- Each browser session gets a random, HttpOnly, SameSite=Strict cookie. It is Secure when `APP_ORIGIN` is HTTPS.
- Password references are discarded after the initial login attempt, including when MFA is pending. The app never writes passwords to disk or places them in URLs, configuration or browser storage. This is not a promise of forensic memory erasure.
- Cookies/tokens needed for Anglian Water are retained in server memory for up to 30 minutes of inactivity. Logout and container restart clear them. Expired sessions are removed by a 30-second cleanup task.
- Upstream diagnostic logging and HTTP access logs are disabled to prevent sensitive payload logging.
- Readings are returned to the user's page and converted into CSV locally. They are not saved on the server. Responses use `Cache-Control: no-store`; no analytics, remote scripts, fonts or tracking are included.
- The app uses same-origin POST checks, a custom request header, bounded request sizes, login/MFA rate limits and fixed upstream endpoints.
- There is **no app-level user directory**. Each visitor signs into their own Anglian Water account. Place the hostname behind your existing Cloudflare Access policy if access should be private.

The app runs one process. Do not add multiple workers/replicas without first implementing shared, protected session storage.

## Local Docker

```sh
docker compose up -d --build
```

Open [localhost:8080](http://localhost:8080). This development mapping is loopback-only. Sign-in and export use the real Anglian Water service; use the sample button for a no-login demo.

## Mobius / Portainer

Use [`compose.mobius.yml`](compose.mobius.yml) as a new stack called `anglian-water-csv`.

Set these Portainer variables:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | `https://water.devnull.co.uk` |
| `HOST_PORT` | `8011` proposed; verify the live port list before deploying |
| `IMAGE_TAG` | `0.1.0`, or an immutable `sha-...` image tag |
| `BIND_ADDRESS` | A Mobius interface reachable by the tunnel; default `0.0.0.0` |

The image is built by GitHub Actions and published to `ghcr.io/devnulluk/anglian-water-csv`. A private package requires the existing GHCR registry credentials in Portainer. Container port is `8080`; health check is `/health`.

Point the Cloudflare Tunnel hostname `water.devnull.co.uk` at `http://<verified-mobius-address>:8011`. Existing notes have conflicting host addresses, so verify the tunnel target in the live environment. `APP_ORIGIN` must match the browser's exact origin, with no path. A raw-IP browser login will deliberately fail same-origin validation when the HTTPS hostname is configured.

No persistent volume is required: this app intentionally stores no account credentials or readings. The container is non-root, has a read-only filesystem, drops Linux capabilities, and uses a dedicated bridge network. Preserve the Compose definition and chosen image tag; there is no application database to back up. Downloaded CSV files are the user's archive. Restarting the container signs everyone out.

## Development and checks

Python 3.12+ and Node 22+:

```sh
python -m venv .venv
# Activate your virtual environment, then:
pip install -r requirements.txt pytest pytest-asyncio
python -m pytest -q
npm run check
npm test
python server.py
```

No npm dependencies or frontend build are needed. Runtime Python dependencies are pinned in `requirements.txt`; update from `requirements.in` with `uv pip compile` and rerun tests.

## CSV details

UTF-8 with BOM, CRLF line endings and quoted fields:

| Column | Meaning |
| --- | --- |
| `meter_serial_number` | Meter reported by the service |
| `interval_start_utc` / `interval_end_utc` | Unambiguous hour boundaries |
| `interval_start_europe_london` | UK wall-clock label; use UTC columns to distinguish repeated autumn hours |
| `source_read_at` | Unmodified upstream reading timestamp |
| `consumption_litres` | Consumption for that hour |
| `cumulative_read_m3` | Meter's cumulative reading, in cubic metres |
| `quality` | `reported` or `negative_consumption` |

Like Home Assistant, the app treats `read_at` as the **end** of the usage hour and subtracts one actual hour. Date filters apply to the start in Europe/London. UK clock-change days have 23 or 25 hours. Offset-free timestamps are interpreted as Europe/London; an ambiguous autumn timestamp or nonexistent spring timestamp stops export instead of guessing. If that happens, the upstream response needs explicit offsets to export safely.

Duplicate identical readings are deduplicated by meter/UTC hour. Conflicting duplicates, malformed numbers, invalid times and non-hourly boundaries stop export. Negative readings remain visible and flagged. Text fields are escaped against spreadsheet formulas.

## Research and attribution

- [Home Assistant Anglian Water integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/anglian_water)
- [Home Assistant supported meters and limitations](https://www.home-assistant.io/integrations/anglian_water/)
- [pyanglianwater](https://github.com/pantherale0/pyanglianwater), used as a dependency, MIT licensed, copyright Justin Hammond.
- [Chrome cross-origin request rules](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests): an ordinary hosted webpage cannot freely call another origin. An unauthenticated OPTIONS probe against the API on 15 September 2026 returned no CORS allow-origin header for an arbitrary origin. A direct browser integration would need supported CORS and an appropriate login redirect arrangement.

Independent, unofficial software. Provider login flows and undocumented APIs may change.
