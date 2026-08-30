# Running the Groups server on Oracle Cloud Always Free

Always Free gives you an Arm machine with real disk that never sleeps and never
expires — which is exactly what this app needs and what most free tiers don't
offer. Budget about 30 minutes, most of it waiting.

You end up with `https://something.duckdns.org` (or your own domain) that your
friendgroup's phones talk to, while the app itself stays on GitHub Pages.

> Oracle's terms have changed before and mine is second-hand knowledge. Check
> the current Always Free limits as you go rather than trusting this page.

---

## 1. The instance

**Sign up** at cloud.oracle.com. It asks for a card to prove you are a person;
Always Free resources are not billed. Pick a home region close to you — you
cannot change it later, and Always Free capacity is per-region.

**Create the instance** (Compute → Instances → Create):

| Setting | Value | Why |
| --- | --- | --- |
| Image | **Canonical Ubuntu 24.04** | best-trodden Docker path |
| Shape | **VM.Standard.A1.Flex** (Ampere, Arm) | the free Arm pool: 4 OCPU / 24 GB |
| OCPUs / memory | **2 OCPU, 12 GB** | plenty; leaves room for a second box |
| Boot volume | **200 GB** | your whole free storage allowance, in one disk |
| SSH keys | save the private key | it is the only way in |

Two things worth knowing before you click Create:

- **Take the boot volume up to 200 GB.** Always Free includes 200 GB of block
  storage total. Putting it all in the boot volume means no second disk to
  attach, partition and mount. 200 GB is years of clips for five people.
- **`VM.Standard.E2.1.Micro` is the other free shape** — 1 GB of RAM and an
  eighth of a core. It will technically run this, but stitching a day's reel
  will crawl. Take the Arm one.

**"Out of host capacity."** This is the one genuinely annoying part of Oracle
Always Free: the Arm pool is often full. If you hit it:

- Try each availability domain in your region (AD-1, AD-2, AD-3).
- Try again later — capacity frees up constantly, often overnight.
- Ask for fewer resources (1 OCPU / 6 GB is still fine for this).
- Upgrading to Pay As You Go makes Always Free capacity much easier to get,
  and Always Free resources stay free on that account.

---

## 2. Open the ports — both firewalls

This is where almost everyone gets stuck: Oracle instances sit behind **two**
firewalls, and you have to open both.

**The cloud one.** Networking → Virtual Cloud Networks → your VCN → Subnet →
Default Security List → Add Ingress Rules:

| Source | Protocol | Port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

**The one on the machine.** Oracle's Ubuntu images ship with a restrictive
iptables ruleset. SSH in and check whether traffic actually arrives:

```bash
ssh ubuntu@YOUR_PUBLIC_IP
sudo iptables -L INPUT -n --line-numbers
```

If you see a `REJECT` rule covering everything, open the two ports ahead of it
and make it stick across reboots:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Do not reach for `ufw` here — it fights with the rules Oracle already installed
and with the ones Docker manages.

---

## 3. Docker

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER
exec sudo su -l $USER          # pick up the new group without logging out
docker run --rm hello-world    # should print a welcome
```

Everything in this project builds natively on Arm — Node, Alpine and ffmpeg all
publish arm64 images, and the database is built into Node, so there is nothing
to compile.

---

## 4. A name to put a certificate on

Let's Encrypt will not issue a certificate for a bare IP address, so you need a
hostname. Either works:

- **Your own domain** — add an `A` record pointing at the instance's public IP.
- **DuckDNS** (free) — sign in at duckdns.org, claim a subdomain, and set its
  IP to your instance. You get `yourname.duckdns.org`.

Check it resolves before continuing:

```bash
dig +short yourname.duckdns.org      # should print your instance's IP
```

---

## 5. Start it

```bash
git clone https://github.com/YOUR_NAME/groups.git
cd groups
cp .env.example .env
```

Generate a Web Push key pair and put it, plus your domain, into `.env`:

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-alpine node scripts/vapid-keys.mjs
```

`.env` should end up looking like:

```
GROUPS_DOMAIN=yourname.duckdns.org
VAPID_PUBLIC_KEY=BJ7b...
VAPID_PRIVATE_KEY=q2hl...
VAPID_SUBJECT=mailto:you@example.com
```

Then:

```bash
docker compose up -d
docker compose logs -f caddy     # watch it obtain the certificate
```

Caddy talks to Let's Encrypt on first start, which takes a few seconds. When
the log goes quiet:

```bash
curl https://yourname.duckdns.org/api/health
# {"ok":true,"time":...,"push":true,"ffmpeg":true,"version":"1.0.0"}
```

`"ffmpeg":true` means "Save the whole day" as one file will work.

---

## 6. Point the app at it

In your repo: **Settings → Secrets and variables → Actions → Variables → New**

```
GROUPS_API_BASE = https://yourname.duckdns.org
```

Re-run the **Publish app to Pages** workflow. Now anyone who opens
`https://YOUR_NAME.github.io/groups/` is connected automatically — no address to
type, no connect screen.

If you would rather only your own site could call the server, add this to `.env`
and `docker compose up -d` again:

```
ALLOWED_ORIGINS=https://YOUR_NAME.github.io
```

---

## Living with it

**Updating.** `git pull && docker compose up -d --build`. Your data lives in a
named Docker volume, so it survives rebuilds.

**Backups.** Everything that matters is in one volume:

```bash
docker run --rm -v groups_groups-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/groups-backup-$(date +%F).tar.gz -C /data .
```

Copy that file off the machine. Restore by untarring it back into the volume.

**Watching disk.** 200 GB is a lot, but video is video:

```bash
docker system df -v | grep groups-data
```

**Reboots.** `restart: unless-stopped` brings everything back automatically.

**Idle reclamation.** Oracle has been known to reclaim Always Free compute that
sits genuinely idle. A server that friends are using all day is not idle, but it
is a reason to keep the backup above somewhere else.
