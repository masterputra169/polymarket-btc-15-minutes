# Custom domain for the dashboard (DigitalPlat FreeDomain + Cloudflare Tunnel)

## Why this path

The public dashboard currently uses a **Cloudflare Quick Tunnel** (`*.trycloudflare.com`). That works over HTTPS/WSS but the hostname is not designed to be permanent: a connector restart can produce a new URL.

The stable path is:

```text
DigitalPlat free domain
        │  delegation (NS records)
        ▼
Cloudflare DNS zone
        │  named Cloudflare Tunnel
        ▼
nginx 127.0.0.1:8080  ←  bot status/report services
```

DigitalPlat **registers** the domain and delegates it. It does **not** host ordinary DNS records and does not issue a certificate. Cloudflare hosts the DNS zone, terminates TLS and runs the named tunnel.

## Before you start

- A DigitalPlat account with accurate contact data (the service requires a real email, name, phone and address; the operator must register it personally).
- One available name from a supported suffix (`.dpdns.org`, `.us.kg`, `.qzz.io`, `.xx.kg`, `.qd.je`). Limits and availability can change; check the dashboard notice board.
- A free Cloudflare account.
- The VPS already running `polybtc15-bot` and nginx on `127.0.0.1:8080`.

> One free domain per DigitalPlat account at the time of writing. Do not use a name that infringes a trademark or impersonates another service. Suggested neutral labels: `poly15`, `btc15`, `polybtc15`.

## Step 1 — Register the domain

1. Open <https://dash.domain.digitalplat.org/> and create an account. Use contact data that the operator can actually maintain; recovery email matters.
2. In the dashboard, open **Register**, choose a label and suffix, and check availability.
3. Do **not** expect an A/CNAME editor there. The registration form will ask for **external authoritative nameservers**. We will fill those after Cloudflare gives us the zone.
4. Complete the policy acknowledgement and submit.

## Step 2 — Add the domain to Cloudflare

1. In Cloudflare, **Add a site** and enter the complete registered domain (for example `poly15.dpdns.org`).
2. Choose the Free plan.
3. Cloudflare assigns two nameservers, for example `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`. Copy **both hostnames exactly**.
4. Do not add an A record yet; the tunnel will create the public hostname.

## Step 3 — Delegate the domain to Cloudflare

1. Go back to the DigitalPlat dashboard for the domain.
2. Open its nameserver settings.
3. Enter the two Cloudflare nameservers. They are hostnames, not IP addresses.
4. Save and wait for delegation. This can take minutes to a few hours.

Verify from a machine with normal DNS:

```bash
dig NS poly15.dpdns.org +short
# expected: the two Cloudflare nameservers
```

Do not continue until the NS answer matches. If Cloudflare still says "pending", the delegation is not active yet.

## Step 4 — Create the named tunnel

Two equivalent options:

### A. Cloudflare dashboard (recommended for a one-off setup)

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel**.
2. Select **Cloudflared**, name it `polybtc15`.
3. Copy the connector token.
4. Install the connector on the VPS:

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared
```

5. In the tunnel, add a **Public Hostname**:
   - subdomain: `dashboard` (or `poly15` / `@`)
   - domain: your registered domain
   - service: `http://127.0.0.1:8080`
6. Cloudflare creates the DNS CNAME automatically.

### B. Local CLI (requires a browser login once)

```bash
cloudflared tunnel login
cloudflared tunnel create polybtc15
cloudflared tunnel route dns polybtc15 dashboard.poly15.dpdns.org
```

Then create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /home/ubuntu/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: dashboard.poly15.dpdns.org
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Install a systemd unit that runs:

```bash
cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
```

## Step 5 — Protect the new hostname

The page already has nginx **HTTP Basic Auth**. Two stronger options:

- **Cloudflare Access** (Zero Trust → Access → Applications): require email OTP or a service token for `dashboard.<domain>`. Recommended if the URL is public.
- Restrict the hostname to the operator’s email or a VPN. Do not expose the raw `:8080` port.

Keep `/ws` behind Basic Auth as it is now; the browser sends the cached Basic credentials on the WebSocket handshake. Do not remove nginx auth just to make WS work.

## Step 6 — Switch over

1. Verify the named tunnel first while the quick tunnel is still running:

```bash
curl -I https://dashboard.poly15.dpdns.org/
dig dashboard.poly15.dpdns.org +short
```

2. Open the new URL in a browser, log in, confirm 16 widgets and live data.
3. Stop the quick tunnel:

```bash
sudo systemctl disable --now cloudflared-quick
```
4. Update the dashboard URL used by alerts:

```bash
sudo sed -i "s|^DASHBOARD_URL=.*|DASHBOARD_URL=https://dashboard.poly15.dpdns.org/|" /opt/polybtc15/bot/.env
sudo systemctl restart polybtc15-bot
```
5. Update `docs/VPS.md`, README and the Telegram alert link. Keep the old quick-tunnel URL in `.tunnel-url` as a temporary fallback only.

## Step 7 — Verify WebSocket and access

From the VPS:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://dashboard.poly15.dpdns.org/
# 401 is expected without Basic Auth; 200 with credentials
```

From a browser: open the URL, confirm `Bot connected`, 16 widgets, live BTC/PTB and no `Linking to the bot stream…` loop.

If the page loads but data never arrives, check for `/ws` returning 401; run:

```bash
sudo systemctl start polybot-dashboard-auth-sync.service
```

## Rollback

Re-enable the quick tunnel if the named tunnel is not ready:

```bash
sudo systemctl enable --now cloudflared-quick
cat /opt/polybtc15/.tunnel-url
```

The nginx dashboard is unchanged; only the public hostname changes.

## Caveats of a free domain

- One free domain per account at the time of writing.
- Registration can be paused or require approval; suffixes and policies can change.
- The domain is not owned by the operator and can be suspended under the provider’s acceptable-use policy.
- No SLA. Do not make it the only access path for a funded live trading system.

For a long-lived trading console, a low-cost paid `.com`/`.io` domain with Cloudflare DNS is the lower-risk option; the tunnel setup is identical.
