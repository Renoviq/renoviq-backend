# Renoviq AI: backend

The API behind Renoviq AI, a web app that redesigns a room from a photo. Users sign up, verify their email, upload a photo, choose a room type and style, and the AI returns a redesigned version that is saved to a personal gallery.

The web app lives in its own repository, [renoviq-frontend](https://github.com/Renoviq/renoviq-frontend). In production both run on one EC2 server behind nginx.

**To deploy, follow [docs/deployment.md](docs/deployment.md)**: create the S3 bucket and the IAM role, create the EC2 server, install the software, write the `.env`, add the GitHub secrets, then press *Run workflow*.

```
                         EC2 server
browser ──https──▶ nginx ─┬─ /            static files (renoviq-frontend build)
                          └─ /api, /auth/google ─▶ backend container :3000 ─▶ MongoDB container
                                                     ├─▶ Gemini (redesigns the photo)
                                                     └─▶ S3 bucket (private, via the EC2 instance role)
```

| Part | What it uses |
| --- | --- |
| API | Node.js 20, Express, TypeScript, all routes under `/api` |
| Auth | Passport (username and password, Google OAuth), `express-session`, bcrypt |
| Email | Nodemailer over SMTP: 6-digit verification codes (valid 10 minutes), contact form |
| Database | MongoDB: `users`, `renovations`, `contactForm` |
| AI | Google Gemini image model (`gemini-nano-banana-2.1`, change with `GEMINI_IMAGE_MODEL`) |
| Photos | Amazon S3, private bucket. The API reads and writes it with the EC2 instance role and serves the pictures to their owner |
| Delivery | Docker image on Docker Hub, GitHub Actions (manual), nginx, Let's Encrypt |

## How a redesign is made

`POST /api/renovations` is a multipart form: the room type, style and notes as fields and the photo as the `photo` file. The server:

1. checks the session and that the AI and S3 settings exist (`503` otherwise);
2. allows one design at a time per user and at most **10 per rolling hour** (the 429 answers say which limit was hit);
3. checks the photo: JPG or PNG by its first bytes (not by its name), up to 5 MB;
4. asks Gemini to redesign it while keeping the layout, then saves the original and the result to S3 under `originals/<user>/…` and `generated/<user>/…` and stores the gallery entry. Nothing is saved unless the AI succeeded;
5. answers `201` with the design. The client cannot choose any stored value.

The pictures stay private in S3. The API gives the browser the addresses `/api/renovations/<id>/original` and `/api/renovations/<id>/generated`, and requests to them only succeed for the signed-in owner (`404` for anyone else). Deleting a design also deletes both files from S3. Gemini failures become `429` (quota), `504` (timeout) or `502` (error or no image returned, for example blocked by a safety filter).

## Run it locally

Needs Node 20+, MongoDB, a Gemini API key, an S3 bucket with AWS credentials (or an S3-compatible server such as MinIO via `S3_ENDPOINT`), an SMTP login and a Google OAuth client.

```bash
npm install
cp .env.example .env      # fill it in
npm run dev               # http://localhost:3000, restarts on change
```

Run the web app next to it (`renoviq-frontend`, `npm run dev`); its dev server forwards `/api` and `/auth/google` to port 3000.

| Command | What it does |
| --- | --- |
| `npm run dev` | API with automatic restart |
| `npm run build` / `npm start` | Bundle to `dist/index.js` and run it |
| `npm run check` | Type-check |
| `npm test` | Unit tests (fake Gemini and a fake S3 server that the real SDKs talk to). Set `TEST_MONGODB_URI=mongodb://localhost:27017` to also run the route tests against a throw-away database |

### Environment variables

`.env.example` is the template for local development; on the server the settings live in `/opt/renoviq/.env` (template `deploy/server.env.example`, see the deployment guide). `SESSION_SECRET` and the Google OAuth settings are required, the app does not start without them. The SMTP settings are needed for sign-up codes and contact emails.

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs session cookies |
| `MONGODB_URI`, `MONGODB_DB_NAME` | Database (default `mongodb://localhost:27017`, `renoviqai`) |
| `CLIENT_ORIGIN` | Public address of the site, used for the redirect after Google sign-in (default `http://localhost:5173`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google sign-in. The callback is `https://<domain>/auth/google/callback` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email sending |
| `CONTACT_FORM_RECEIVER_EMAIL` | Where contact messages go |
| `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL` | AI access and model name |
| `S3_BUCKET`, `AWS_REGION` | The photo bucket and its region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Only for local development. On EC2 the instance role is used, leave these out |
| `S3_ENDPOINT` | Only for S3-compatible servers (MinIO) |
| `PORT` | Listen port (default 3000) |
| `COOKIE_SECURE` | Defaults to `true` in production (needs HTTPS). Set `false` only to try the production build over plain http |

## API

| Method and path | Auth | Description |
| --- | --- | --- |
| `GET /api/health` | no | `{ "status": "ok" }`, used by Docker and monitoring |
| `POST /api/register`, `POST /api/verify-otp`, `POST /api/resend-otp` | no | Sign up and verify the email |
| `POST /api/login`, `POST /api/logout` | no / yes | Session login and logout |
| `GET /auth/google`, `GET /auth/google/callback` | no | Google sign-in |
| `GET /api/user` | yes | Current user |
| `GET /api/renovations` | yes | Your designs, newest first |
| `POST /api/renovations` | yes | Create a design: multipart form with `photo`, `roomType`, `style`, `description` |
| `GET /api/renovations/:id/original`, `.../generated` | yes | The pictures of one of your designs |
| `DELETE /api/renovations/:id` | yes | Delete one of your own designs and its pictures |
| `POST /api/contactForm` | no | Store a contact message and email it |

## Docker and deployment

```bash
docker build -t renoviq-backend .
```

Multi-stage build on `node:20-alpine`, runs as the unprivileged `node` user, health check on `/api/health`.

Everything for the server is in [docs/deployment.md](docs/deployment.md). In short: the manual **Deploy backend** workflow (Actions tab → Run workflow) tests, builds the image on the runner, pushes it to Docker Hub, and on the server pulls it and starts the API container (`deploy/docker-compose.yml`). MongoDB is created once and then left alone, and a new version that does not start is rolled back. The server settings are a `.env` file you write by hand on the server; nginx is configured by hand too (`deploy/nginx/renoviq.conf` is a ready config). The SSH and copy steps use `appleboy/ssh-action` and `appleboy/scp-action`, pinned to a commit because they receive the SSH key.

## Known limits

- Sessions are kept in memory, so everyone is signed out whenever the API restarts or is deployed. A shared session store (for example `connect-mongo`) fixes this.
- One server, one database container: no failover. The generation limits (one at a time, 10 per hour) are kept per process and in the database, which is correct for one API container.
- The pictures pass through the API (up to 5 MB each way). That is simple and keeps the bucket private, but a very busy site would serve them from S3 or a CDN instead.
- If saving the design to the database fails after the pictures were stored, the two S3 files stay unused.
- The AI result depends on the Gemini model; the prompt asks for the same layout but it is not guaranteed.
- Not tested against the real Gemini, S3, Docker Hub and EC2: those need your accounts and server. The tests use fakes for Gemini and S3 that the real SDKs talk to, and the workflow's server commands were run against a local registry and local Docker. The GitHub Actions run itself has not happened yet.
