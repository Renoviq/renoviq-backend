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

See `.env.example` (local) and `deploy/server.env.example` (server). `SESSION_SECRET` and the Google OAuth settings are required, the app does not start without them. The SMTP settings are needed for sign-up codes and contact emails.

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

## Deploy to EC2 (nginx + Docker)

The server runs nginx directly on the host. The backend and MongoDB run as containers started with `deploy/docker-compose.yml`. The API is published on `127.0.0.1:3000` only, MongoDB has no published port.

### One-time server setup (Ubuntu)

1. **DNS:** point your domain at the server's public IP. Open ports 80 and 443 in the security group.
2. **Install:** Docker Engine with the Compose plugin, nginx and certbot.
   ```bash
   sudo apt-get install -y nginx certbot python3-certbot-nginx   # Docker: https://docs.docker.com/engine/install/ubuntu/
   sudo usermod -aG docker "$USER"                               # log out and in again
   ```
3. **Folders** (the deploy user must own them, the workflows write there as that user):
   ```bash
   sudo install -d -o "$USER" -g "$USER" /opt/renoviq /var/www/renoviq
   cp deploy/server.env.example /opt/renoviq/.env && chmod 600 /opt/renoviq/.env   # then fill it in
   ```
4. **nginx:** follow the steps at the top of `deploy/nginx/renoviq.conf` (copy, set your domain, enable, `nginx -t`, reload, then `sudo certbot --nginx -d <domain>`). The config serves `/var/www/renoviq/current`, proxies `/api` and `/auth`, waits up to 120 s for the AI and rate-limits the sign-in endpoints.
5. **Google sign-in:** add `https://<domain>/auth/google/callback` to the OAuth client's redirect URIs.
6. **GitHub (Settings → Secrets and variables → Actions):**

   | Name | Type | Value |
   | --- | --- | --- |
   | `DOCKERHUB_USERNAME` | variable | Docker Hub user or organisation |
   | `DOCKERHUB_TOKEN` | secret | Docker Hub access token with read and write rights |
   | `EC2_HOST` | variable | Server address |
   | `EC2_USER` | variable | SSH user (for example `ubuntu`) |
   | `EC2_SSH_KEY` | secret | Private key of a key pair whose public key is in the server's `~/.ssh/authorized_keys` |
   | `EC2_KNOWN_HOSTS` | secret | Output of `ssh-keyscan -t ed25519 <EC2_HOST>`, taken from a network you trust |

   Optionally create an environment named `production` with required reviewers to get an approval step before each deploy.

### Deploying

Actions tab → **Deploy backend** → Run workflow. It is manual only (it never runs on a push). It runs the type-check and tests (with a MongoDB service), builds the image, pushes `<user>/renoviq-backend:<commit>` and `:latest` to Docker Hub, copies `deploy/` to `/opt/renoviq`, logs in to Docker Hub on the server and runs `deploy.sh`, which starts the new container and waits for its health check. If the new version never becomes healthy, the previous image is started again and the workflow fails. Untick *deploy* to only build and push.

Deploy the web app with the **Deploy frontend** workflow in the frontend repository.

### Operating it

```bash
cd /opt/renoviq
docker compose ps                    # state and health
docker compose logs -f api           # API log
./deploy.sh <user>/renoviq-backend:<older-commit>    # roll back by hand
./backup-mongo.sh                    # database dump into backups/, keeps 14 days
```

Add the backup to cron, for example `0 3 * * * /opt/renoviq/backup-mongo.sh`, and copy `backups/` off the server: the database lives on the same machine as the app. The restore command is in the script's header.

## Known limits

- Sessions are kept in memory, so everyone is signed out whenever the API restarts or is deployed. A shared session store (for example `connect-mongo`) fixes this.
- One server, one database container: no failover. The generation limits (one at a time, 10 per hour) are counted per process and in the database, which is correct for one API container.
- The gallery keeps the original photo and the result in Firebase Storage forever; deleting a design removes only its database entry.
- The AI result depends on the Gemini model; the prompt asks for the same layout but it is not guaranteed.
- Not tested against the real Gemini, Firebase and Docker Hub services: those need your keys. The tests use fakes for them, and the deploy script was run against a local registry and a local Docker.
