# Mobius deployment record

- Stack: `anglian-water-csv`, Portainer stack ID 207, environment Mobius (2).
- Image: `ghcr.io/devnulluk/anglian-water-csv:0.1.1` (public).
- Application release: `v0.1.1` (privacy hardening).
- Container: `anglian-water-csv`, non-root, read-only filesystem.
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

Do not configure auto-updates to `latest` for a login-handling service without reviewing changes. The existing stack pins `0.1.1`.

## Validation still needed

The owner should sign in to Anglian Water, complete MFA if prompted, and compare an exported date against the official usage page. The developer did not possess or request a real Anglian Water password. Unit tests simulate the upstream login and data API; they cannot prove that the current upstream service accepts a particular account.
