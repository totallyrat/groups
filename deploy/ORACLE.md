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

If the Arm pool will not give you a machine, take **VM.Standard.E2.1.Micro**
instead — it runs this perfectly well with a few adjustments, and there is a
[section for it below](#running-on-the-e21micro).

Two things worth knowing before you click Create:

- **Take the boot volume up to 200 GB.** Always Free includes 200 GB of block
  storage total. Putting it all in the boot volume means no second disk to
  attach, partition and mount. 200 GB is years of clips for five people.
- **`VM.Standard.E2.1.Micro` is the other free shape** — 1 GB of RAM and an
  eighth of a core, x86 rather than Arm. Take the Arm one if you can get it,
  but the Micro is a fine fallback and there is a section below for it. You
  still get the full 200 GB of disk either way, which is the part that matters
  most for an app full of video.

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

## Running on the E2.1.Micro

1 GB of RAM and an eighth of a core is genuinely small, but this app suits it:
there are no dependencies to install, the database is a file, and uploads are
streamed straight to disk rather than held in memory. Three adjustments make it
comfortable.

### Add swap first

The Micro ships with none, and 1 GB with no swap is where things get killed at
the worst moment.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                      # should now show 2.0Gi of swap
```

### Skip Docker, run it directly

Docker's daemon wants a couple of hundred megabytes before your app gets any,
and building the image on an eighth of a core takes a while. Since Groups has
**no npm dependencies**, a plain install is both lighter and faster to update.

```bash
# Node 22 (Ubuntu's own packages are older than node:sqlite needs)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg git

# Caddy, for TLS
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

Put the app in place and give it its own user:

```bash
sudo git clone https://github.com/YOUR_NAME/groups.git /opt/groups
cd /opt/groups
sudo node scripts/make-icons.mjs          # ~30s on this machine, once
sudo useradd --system --home /var/lib/groups --create-home groups
sudo chown -R groups:groups /var/lib/groups
```

Write `/etc/groups.env` — note **`REEL_MODE=copy`**, explained below:

```bash
sudo node scripts/vapid-keys.mjs | sudo tee /etc/groups.env
echo 'REEL_MODE=copy' | sudo tee -a /etc/groups.env
sudo chmod 600 /etc/groups.env
```

Then start it:

```bash
sudo cp deploy/groups.service /etc/systemd/system/
sudo systemctl enable --now groups
systemctl status groups
```

The unit caps the service at 600 MB and de-prioritises its CPU, so a runaway
ffmpeg cannot take the machine down with it.

Finally point Caddy at it — `/etc/caddy/Caddyfile`:

```
yourname.duckdns.org {
	encode zstd gzip
	request_body {
		max_size 256MB
	}
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
```

```bash
sudo systemctl reload caddy
curl https://yourname.duckdns.org/api/health
```

Updates are then `cd /opt/groups && sudo git pull && sudo systemctl restart groups`
— a second, rather than an image rebuild.

### Tell the stitcher to take it easy

"Save the whole day" normally joins everyone's clips into one file. When the
clips already match — which they do when everyone is on an iPhone — that is a
stream copy: no re-encoding, near-instant, and fine on this machine. When they
*don't* match, the server would otherwise re-encode everything, which on an
eighth of a core means minutes of pegged CPU.

`REEL_MODE` decides how far it will go:

| Value | Behaviour |
| --- | --- |
| `full` | re-encode when needed (the default; right for the Arm box) |
| `copy` | stream-copy only — **use this on the Micro** |
| `off` | no server-side stitching at all |

On `copy`, a day whose clips disagree simply falls back to saving them one at a
time, which the app already does gracefully and which costs the server nothing.
Nobody loses a memory; they just get several files instead of one.

### What to expect

Comfortable: recording, uploading, playback, hangouts, notifications, the 20:00
drop, Memory Lane. The server is doing I/O, not computation.

Slower: the first `make-icons` run, and stream-copy stitching of a long day
(still seconds, not minutes). Uploads are limited by your friends' phones far
more than by this machine.

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
