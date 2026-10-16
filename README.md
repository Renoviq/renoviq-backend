# Renoviq AI: backend

The API behind Renoviq AI, a web app that redesigns a room from a photo. Users sign up, verify their email, upload a photo, choose a room type and style, and the AI returns a redesigned version that is saved to a personal gallery.

The web app lives in its own repository, [renoviq-frontend](https://github.com/Renoviq/renoviq-frontend). In production both run on one EC2 server behind nginx.

```
                         EC2 server
browser ──https──▶ nginx ─┬─ /            static files (renoviq-frontend build)
                          ├─ /api, /auth ─▶ backend container :3000 ─▶ MongoDB container
                          │                          │
                          │                          ├─▶ Gemini (redesign the photo)
                          │                          └─▶ Firebase Storage (save the result)
browser ──upload photo──▶ Firebase Storage
```

| Part | What it uses |
| --- | --- |
| API | Node.js 20, Express, TypeScript, all routes under `/api` |
| Auth | Passport (username and password, Google OAuth), `express-session`, bcrypt |
| Email | Nodemailer over SMTP: 6-digit verification codes (valid 10 minutes), contact form |
| Database | MongoDB: `users`, `renovations`, `contactForm` |
| AI | Google Gemini image model (`gemini-nano-banana-2.1`, change with `GEMINI_IMAGE_MODEL`) |
| Photos | Firebase Storage: the browser uploads `uploads/…`, the server writes `generated/…` with firebase-admin |
| Delivery | Docker image on Docker Hub, GitHub Actions (manual), nginx, Let's Encrypt |

## How a redesign is made

`POST /api/renovations` takes the room type, style, notes and the Firebase URL of the uploaded photo. The server:

1. checks the session, the input, and that the URL points to **this app's own bucket under `uploads/`** (nothing else is ever fetched);
2. allows one design at a time per user and at most **10 per rolling hour** (the 429 answers say which limit was hit);
3. downloads the photo (JPG or PNG, up to 5 MB), asks Gemini to redesign it while keeping the layout, saves the result to `generated/<user>/…` in Firebase Storage and stores the gallery entry;
4. answers `201` with the saved design. The client cannot set `generatedImage`.

If `GEMINI_API_KEY`, `FIREBASE_STORAGE_BUCKET` or `FIREBASE_SERVICE_ACCOUNT` is missing the route answers `503`. Gemini failures become `429` (quota), `504` (timeout) or `502` (error or no image returned, for example blocked by a safety filter).

## Run it locally

Needs Node 20+, MongoDB, and the accounts below (a Firebase project, a Gemini API key, an SMTP login and a Google OAuth client).

```bash
npm install
cp .env.example .env      # fill it in
npm run dev               # http://localhost:3000, restarts on change
```

Run the web app next to it (`renoviq-frontend`, `npm run dev`); its dev server proxies `/api` and `/auth` to port 3000.

| Command | What it does |
| --- | --- |
| `npm run dev` | API with automatic restart |
| `npm run build` / `npm start` | Bundle to `dist/index.js` and run it |
| `npm run check` | Type-check |
| `npm test` | Unit tests (fake Gemini and photo servers). Set `TEST_MONGODB_URI=mongodb://localhost:27017` to also run the route tests against a throw-away database |

### Environment variables

See `.env.example` for local development; on the server the same settings live in `/opt/renoviq/.env` (see below). `SESSION_SECRET` and the Google OAuth settings are required, the app does not start without them. The SMTP settings are needed for sign-up codes and contact emails.

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs session cookies |
| `MONGODB_URI`, `MONGODB_DB_NAME` | Database (default `mongodb://localhost:27017`, `renoviqai`) |
| `CLIENT_ORIGIN` | Public address of the site, used for the redirect after Google sign-in (default `http://localhost:5173`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google sign-in. The callback is `https://<domain>/auth/google/callback` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email sending |
| `CONTACT_FORM_RECEIVER_EMAIL` | Where contact messages go |
| `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL` | AI access and model name |
| `FIREBASE_STORAGE_BUCKET`, `FIREBASE_SERVICE_ACCOUNT` | Storage bucket and the service-account JSON (one line, in single quotes) |
| `PORT` | Listen port (default 3000) |
| `COOKIE_SECURE` | Defaults to `true` in production (needs HTTPS). Set `false` only to try the production build over plain http |

Firebase: the browser uploads photos to `uploads/`, so your Storage rules must allow writes there. The server uses firebase-admin, which ignores the rules, to write `generated/`.

## API

| Method and path | Auth | Description |
| --- | --- | --- |
| `GET /api/health` | no | `{ "status": "ok" }`, used by Docker and monitoring |
| `POST /api/register`, `POST /api/verify-otp`, `POST /api/resend-otp` | no | Sign up and verify the email |
| `POST /api/login`, `POST /api/logout` | no / yes | Session login and logout |
| `GET /auth/google`, `GET /auth/google/callback` | no | Google sign-in |
| `GET /api/user` | yes | Current user |
| `GET /api/renovations` | yes | Your designs, newest first |
| `POST /api/renovations` | yes | Create a design (see above) |
| `DELETE /api/renovations/:id` | yes | Delete one of your own designs |
| `POST /api/contactForm` | no | Store a contact message and email it |

## Docker

```bash
docker build -t renoviq-backend .
```

Multi-stage build on `node:20-alpine`, runs as the unprivileged `node` user and has a health check on `/api/health`.

## Deploy to EC2 (GitHub Actions + Docker + nginx)

Actions tab → **Deploy backend** → Run workflow. It is manual only and never runs on a push. The backend and MongoDB run as containers (`deploy/docker-compose.yml`); the API is published on `127.0.0.1:3000` only and MongoDB has no published port.

### What you prepare on the server (Ubuntu, once)

1. **Docker Engine with the Compose plugin** ([install guide](https://docs.docker.com/engine/install/ubuntu/)), and let the SSH user run it: `sudo usermod -aG docker <user>` (log in again afterwards).
2. **Passwordless sudo for that user** (the default on EC2 Ubuntu images). The first run uses it only to create `/opt/renoviq`.
3. **The application settings, written by you:** `/opt/renoviq/.env`, see below. The workflow never writes it.
4. **nginx, DNS and HTTPS, configured by you.** The workflow never touches nginx. `deploy/nginx/renoviq.conf` is a ready config to start from: it serves `/var/www/renoviq/current` (the frontend), proxies `/api` and `/auth` to `127.0.0.1:3000`, waits up to 120 s for the AI and rate-limits sign-in. Install steps are at the top of the file; `sudo certbot --nginx -d <domain>` adds HTTPS.
5. **An SSH key pair** for the workflow: the public key goes into the server's `~/.ssh/authorized_keys`.
6. **Google sign-in:** add `https://<domain>/auth/google/callback` to the OAuth client's redirect URIs.

### The server `.env` (you write it)

Create it with `sudo install -d -o <user> /opt/renoviq` (once) and then `nano /opt/renoviq/.env`, starting from `deploy/server.env.example`. Run `chmod 600 /opt/renoviq/.env`. It holds the MongoDB login (`MONGO_USER`, `MONGO_PASSWORD`, letters and digits only), `SESSION_SECRET`, `CLIENT_ORIGIN`, the Google and SMTP settings, `GEMINI_API_KEY`, `FIREBASE_STORAGE_BUCKET` and `FIREBASE_SERVICE_ACCOUNT` (the key file as one line in single quotes).

The first step of every run checks that the file exists and that each of those names has a value, and stops in seconds if not, before anything is built. If you run the workflow before the file exists, it creates `/opt/renoviq`, tells you to write the file, and stops; write it and run again. Changes to the file take effect at the next run.

### GitHub secrets (Settings → Secrets and variables → Actions → Repository secrets)

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | Docker Hub user and an access token with read and write rights. The same token pushes the image from the runner and pulls it on the server |
| `EC2_HOST`, `EC2_USER` | Server address and SSH user |
| `EC2_SSH_KEY` | Private key of the key pair |
| `EC2_FINGERPRINT` | The server's host-key fingerprint, from `ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub \| cut -d ' ' -f2` run on the server (`SHA256:…`) |

### What one run does

1. Checks Docker, `/opt/renoviq` (created on the first run) and the `.env` file on the server.
2. Runs the type-check and the tests (with a MongoDB service).
3. Builds the Docker image on the GitHub runner and pushes `<user>/renoviq-backend:<commit>` and `:latest` to Docker Hub. Untick *deploy* to stop here.
4. Copies `docker-compose.yml` to the server, logs in to Docker Hub there with the same token, pulls the image and starts the API container, waiting for its health check.
5. **MongoDB** is started on the first run and then left alone (`--no-recreate`): later runs never restart or recreate it, and its data stays in the `mongo-data` volume.
6. If the new API never becomes healthy, the workflow fails and the previous image is started again.

Deploy the web app with the **Deploy frontend** workflow in the frontend repository. The SSH action and the copy action come from `appleboy` and are pinned to a commit; they receive the SSH key, so update the pin deliberately.

### Operating it

```bash
cd /opt/renoviq
docker compose ps                    # state and health
docker compose logs -f api           # API log
IMAGE=<user>/renoviq-backend:<older-commit> docker compose up -d --no-deps api    # go back by hand
docker compose exec -T mongo sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' > backup.archive.gz   # database backup
```

The database lives on the same machine as the app: run the backup from cron and copy it off the server. `MONGO_USER` and `MONGO_PASSWORD` only take effect when the database is first created; changing them in `.env` later does not change the existing database login (change it inside MongoDB first, or the API cannot connect).

## Known limits

- Sessions are kept in memory, so everyone is signed out whenever the API restarts or is deployed. A shared session store (for example `connect-mongo`) fixes this.
- One server, one database container: no failover. The generation limits (one at a time, 10 per hour) are counted per process and in the database, which is correct for one API container.
- The gallery keeps the original photo and the result in Firebase Storage forever; deleting a design removes only its database entry.
- The AI result depends on the Gemini model; the prompt asks for the same layout but it is not guaranteed.
- Not tested against the real Gemini, Firebase, Docker Hub and EC2: those need your keys and server. The tests use fakes for them, and the workflow's server commands were run against a local registry and local Docker. The GitHub Actions run itself has not happened yet.
