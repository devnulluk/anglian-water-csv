# Mobius deployment record

- Stack: `anglian-water-csv`, Portainer stack ID 207, environment Mobius (2).
- Image: `ghcr.io/devnulluk/anglian-water-csv:0.2.0` (public).
- Application release: `v0.2.0` (all-history ZIP export).
- Container: `anglian-water-csv`, non-root, read-only filesystem.
- Privacy release verified on Mobius: image `0.1.2`, Docker log driver `none`, empty `LogPath`, no persistent mounts, core limit 0, and both memory/memory-plus-swap limits 268435456 bytes.
- Public HTTPS health check passed after redeployment; served HTML and JavaScript matched the release. Sample preview showed 168 readings and 1,057 litres.
- Release 0.1.2 fixes provider cookie quoting. A synthetic invalid login through the public hostname returned HTTP 401 with the expected safe JSON message, replacing the previous plain-text HTTP 502 failure. All 29 automated tests and the image build passed. Real-account login/export still requires account-holder validation.
- Published port: `8011` → `8080`. Verified unused before deployment.
- Private bridge network: `anglian-water-csv_water-ledger`.
- Health: container healthy; `http://10.30.30.2:8011/health` returned `{"status":"ok"}`.
- Public HTTPS origin: `https://water.devnull.co.uk`, published with owner approval on 15 September 2026.
- Tunnel: existing `mobius` Cloudflare Tunnel, routing to `http://10.30.30.2:8011`.
- Public verification: Cloudflare DNS resolves; HTTPS health endpoint returned `{"status":"ok"}`. Local DNS caches may take time to refresh.
- Persistent storage: none. Sessions live in memory and expire; CSV files are downloaded by the user.
- GitHub repository and container package: public with owner approval.

## Update or rollback

1. Tag a tested release (`v0.x.y`) to build the corresponding image tag (`0.x.y`).
2. Confirm the GitHub Actions test and image jobs succeed.
3. Update the image tag in this stack's Portainer editor and redeploy with image pulling enabled.
4. Check container health and the HTTPS page; sign in again after a restart.
5. To roll back, restore the previous version tag and redeploy. No database migration is involved.

Do not configure auto-updates to `latest` for a login-handling service without reviewing changes. The existing stack pins `0.2.0`.

## Validation still needed

The owner should sign in to Anglian Water, complete MFA if prompted, and compare an exported date against the official usage page. The developer did not possess or request a real Anglian Water password. Unit tests simulate the upstream login and data API; they cannot prove that the current upstream service accepts a particular account.


## All-history release verification

Version 0.2.0 is deployed. The public HTTPS health endpoint passed and the served HTML, app, data and archive modules matched the release. The live UI shows all-history loading with no date filters. All 36 automated tests passed, including independent frequency requests, anonymous labels across resolutions, partial failures and ZIP/CSV checks. A sample archive was CRC-checked and parsed using Python's ZIP/CSV readers; browser preview switching and the ZIP download action were checked locally.

Account-holder validation remains necessary to compare actual hourly/daily/monthly ranges with the provider website. No live account credentials were collected or saved during development.
