# Water Ledger

A small self-hosted web app that signs in to Anglian Water and exports **available hourly smart-meter usage as CSV**. Runs as one Docker container with Docker Compose.

## Use

1. Open the app over HTTPS.
2. Enter your Anglian Water email, password and the numeric account number from your bill.
3. If requested, enter the email verification code from Anglian Water.
4. Choose inclusive UK dates, load the available readings and select a meter (or all meters).
5. Review the preview and download your CSV. Incomplete exports require an explicit acknowledgement.
6. Sign out to clear the server session and displayed data.

The sample-data button works without a water account. Sample downloads are clearly named `SAMPLE-...csv`.

**Status:** version 0.1.1 includes a privacy audit and hardening. Twenty-four automated checks pass, covering session isolation, MFA, logout, error redaction, CSV integrity and clock changes. Browser checks verified the sample CSV and the incomplete-export acknowledgement. A real Anglian Water login/export still needs account-holder validation; no live credentials were used during development.

## What date ranges are available?

This app calls the hourly smart-meter endpoint used by `pyanglianwater` 3.3.2:

```
GET /myaccount/v1/accounts/{encrypted-account}/usage/smartmeter/frequency/10
```

The inspected library exposes **no start/end parameters or pagination for this usage endpoint**. Date selection filters the history actually returned; it does not promise unlimited historical retrieval. The date parameters on a different *cost* endpoint are not evidence that historical hourly *usage* can be fetched. The UI reports available history and counts missing meter-hours. Missing values are never fabricated as zero.

Only smart/enhanced smart meters are supported. New readings can be delayed. This app does not poll or retain history between sessions; download and keep exports if you need an archive.

## Privacy and authentication

This Docker version is **not browser-only**. Credentials travel browser → your server → Anglian Water and its Microsoft identity service. Any reverse proxy that terminates HTTPS also handles traffic in that path. Use an HTTPS hostname and a trusted server; server administrators can technically inspect process memory.

- Each browser session gets a random, HttpOnly, SameSite=Strict session cookie with no persistent expiry. It is Secure when `APP_ORIGIN` is HTTPS.
- Password references are discarded after the initial login attempt, including when MFA is pending. The app never writes passwords to disk or places them in URLs, configuration or browser storage. This is not a promise of forensic memory erasure.
- Cookies/tokens needed for Anglian Water are retained in server memory for up to 30 minutes of inactivity. Logout and container restart clear them. Expired sessions are removed by a 30-second cleanup task.
- Production Python logging and Docker log storage are disabled. Compose disables process swap and core dumps.
- The server allowlists timestamps, numeric volumes and anonymous meter labels. Extra API metadata and real meter serial numbers never reach the page or CSV. Email/account/password inputs clear on submission.
- Identity claims and login cookies are discarded after authentication; only tokens and the identifiers needed for usage requests remain in memory until logout/expiry.
- See [the privacy audit](docs/PRIVACY.md) for scope, tests and limits, including browser-managed password storage, proxy providers and host-level snapshots.
- Readings are returned to the user's page and converted into CSV locally. They are not saved on the server. Responses use `Cache-Control: no-store`; no analytics, remote scripts, fonts or tracking are included.
- The app uses same-origin POST checks, a custom request header, bounded request sizes, login/MFA rate limits and fixed upstream endpoints.
- There is **no app-level user directory**. Each visitor signs into their own Anglian Water account. Use an authentication gateway or private network if access should be restricted.

The app runs one process. Do not add multiple workers/replicas without first implementing shared, protected session storage.

## Install with Docker Compose

Install Docker with the Compose plugin, then clone the repository:

```sh
git clone https://github.com/devnulluk/anglian-water-csv.git
cd anglian-water-csv
docker compose up -d --build
```

Open [localhost:8080](http://localhost:8080). The supplied configuration binds to the local machine only. Use the sample button to try the app without signing in.

To stop the app:

```sh
docker compose down
```

## Host over HTTPS

For access from other devices, place the app behind an HTTPS reverse proxy. Set `APP_ORIGIN` to the exact address visitors will use, such as `https://water.example.com`, with no trailing path. The app validates sign-in requests against this origin.

You can use the prebuilt public image instead of building from source. Save this as `compose.yml` in a new directory:

```yaml
services:
  water-ledger:
    image: ghcr.io/devnulluk/anglian-water-csv:0.1.1
    restart: unless-stopped
    environment:
      APP_ORIGIN: https://water.example.com
      TZ: Europe/London
    ports:
      - "127.0.0.1:8080:8080"
    read_only: true
    tmpfs: ["/tmp:size=16m,mode=700,uid=10001,gid=10001"]
    ulimits:
      core: 0
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 256m
    memswap_limit: 256m
    logging:
      driver: none
```

Replace `https://water.example.com` with your hostname, then run:

```sh
docker compose pull
docker compose up -d
```

Configure a reverse proxy running on the same host to forward that hostname to `http://127.0.0.1:8080`. If your proxy runs in another container, connect both containers to a shared Docker network and forward to `http://water-ledger:8080`; the proxy container's own loopback address will not reach this app. The health endpoint is `/health`.

No registry login or persistent volume is required. The container runs as a non-root user with a read-only filesystem. There is no application database to back up; downloaded CSV files are your archive. Restarting or updating signs everyone out.

### Updates

Choose a tested release tag and change the `image` version in your Compose file, then run `docker compose pull` and `docker compose up -d`. Keep the previous tag to roll back if needed. For a source installation, pull the latest source and run `docker compose up -d --build`.

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
| `meter_label` | Anonymous label such as Meter 1; real serial numbers are excluded. Labels apply to the current response and may change between exports. |
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
