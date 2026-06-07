# whatsapp-sender

A web-based WhatsApp bulk messaging tool for testing and education — features QR
login, CSV / manual contact import, personalised message templates with
`{{variables}}`, rich text formatting (bold, italic, strikethrough), configurable
send delay, and real-time progress tracking.

> ⚠️ **Educational / testing use only.** Only message people who have given
> explicit consent. Spamming via WhatsApp violates WhatsApp's Terms of Service
> and may get your number banned.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

The app auto-detects the Chrome/Chromium binary on macOS and Linux. To force a
specific binary set `PUPPETEER_EXECUTABLE_PATH`.

## Deploy to Railway

This repo ships with a `Dockerfile` and `railway.toml`. Deployment steps:

1. Push your branch to GitHub (the repo is already wired to
   `github.com/aadityamohan/whatsapp-sender`).
2. In [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**
   → select `aadityamohan/whatsapp-sender`.
3. Railway will detect `railway.toml` and build via Docker (Node 20 +
   system Chromium).
4. **Add a Volume** (Service → Settings → Volumes):
   - Mount path: `/data`
   - This is where the WhatsApp Web session is persisted across redeploys.
5. Wait for the build to finish, open the generated URL, and scan the QR with
   WhatsApp → **Linked Devices → Link a Device**.

### Environment variables (all optional)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` (in Docker) | Chrome binary |
| `WA_AUTH_DIR` | `/data/.wwebjs_auth` (in Docker) | Where WhatsApp Web session is stored |

### Health check

`GET /healthz` returns `{ ok: true, wa: <status> }` — Railway uses this to
decide if the deployment is healthy.

## Run via Docker locally

```bash
npm run docker:build
npm run docker:run
# open http://localhost:3000
```

The session is stored in a named volume `wa_auth`, so subsequent runs skip the
QR scan.

## Important caveats for hosted deployments

- WhatsApp may flag/ban your number for logging in from a datacenter IP,
  especially if your number is usually used from a different country. Test with
  a throwaway number first.
- The first deploy will require you to scan a fresh QR. After that the volume
  preserves the session.
- `contacts.csv` is gitignored by default — keep PII off of public repos.
