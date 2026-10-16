# Deploy Renoviq on AWS

This guide takes you from nothing to a running site on one EC2 server. You set up the server and the settings once. After that, two buttons in GitHub (**Run workflow**) build and deploy everything.

```
browser ──https──▶ nginx (on the EC2 server)
                    ├─ /            the web app files   (renoviq-frontend workflow copies them)
                    └─ /api, /auth/google ─▶ backend container ─▶ MongoDB container   (renoviq-backend workflow)
                                          ├─▶ Gemini      (redesigns the photo)
                                          └─▶ S3 bucket   (keeps the photos, private)
```

**You do:** create the S3 bucket and the IAM role, create the EC2 server, install the software, create the folders, write the `.env` file, set up nginx, add the GitHub secrets.
**The workflows do:** test, build, push the image to Docker Hub, copy the files to the server, start the containers, switch to the new web app, and roll back if the API does not start.

Allow about an hour the first time. You need an AWS account, a domain name, a Docker Hub account, a Google Cloud OAuth client (for Google sign-in), an SMTP login (for the sign-up emails) and a Gemini API key.

---

## 1. Create the S3 bucket

S3 console → **Create bucket**.

- **Name:** anything unique, for example `renoviq-photos-yourname`. Write it down: it is `S3_BUCKET` later.
- **Region:** the same region as the EC2 server (for example `us-east-1`). It is `AWS_REGION` later.
- **Block all public access:** leave it **on**. The photos are private; the API hands them only to their owner.
- Everything else: defaults.

You do not need CORS or a bucket policy: the browser never talks to S3, only the API does.

## 2. Create the IAM role that lets only the server use the bucket

1. IAM → **Policies** → Create policy → JSON tab. Paste this (replace `YOUR_BUCKET`), name it `renoviq-s3-access`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR_BUCKET" },
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR_BUCKET/*" }
     ]
   }
   ```
2. IAM → **Roles** → Create role → *AWS service* → **EC2** → attach `renoviq-s3-access` → name it `renoviq-ec2-role`.

The role can only be taken by EC2 instances you attach it to, so the bucket is reachable by your server and by nobody else. No AWS keys are written anywhere: not in GitHub, not in the `.env` file. The API container gets temporary credentials from the instance.

## 3. Create the EC2 server

EC2 → **Launch instance**.

- **Image:** Ubuntu Server 24.04 LTS (or 22.04). **Size:** `t3.small` (2 GB RAM) or bigger. **Disk:** 20 GB gp3.
- **Key pair:** create one and keep the `.pem` file.
- **Network settings → security group, inbound rules:**
  - SSH `22` from anywhere (`0.0.0.0/0`). GitHub's runners have changing addresses, so it cannot be limited to your own IP. Ubuntu only allows key login, keep it that way.
  - HTTP `80` and HTTPS `443` from anywhere.
  - Do **not** open `3000` or `27017`.
- **Advanced details:**
  - **IAM instance profile:** `renoviq-ec2-role`.
  - **Metadata response hop limit:** `2`. The API runs in Docker, one network hop further than the server itself, and with the default of `1` it cannot get its S3 credentials.

  Already launched? Use Actions → Security → *Modify IAM role*, and Actions → Instance settings → *Modify instance metadata options* → hop limit `2`.

Then: EC2 → **Elastic IPs** → allocate one and associate it with the instance (the address then survives restarts). In your DNS, create an `A` record `YOUR.DOMAIN` → that address, and wait until `nslookup YOUR.DOMAIN` shows it.

## 4. Install the software on the server

```bash
ssh -i your-key.pem ubuntu@YOUR.DOMAIN
sudo apt-get update && sudo apt-get -y upgrade
```

Docker with the Compose plugin:

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
```

nginx and certbot (free HTTPS certificates):

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

**Log out and log in again** (the Docker permission needs a new session), then check:

```bash
docker compose version && docker run --rm hello-world
```

## 5. Create the folders

```bash
sudo install -d -o ubuntu -g ubuntu /opt/renoviq                                   # backend: compose file and .env
sudo install -d -o ubuntu -g ubuntu /var/www/renoviq /var/www/renoviq/releases     # web app builds
```

(The workflows create these too if they are missing; doing it now means nothing depends on `sudo` later.)

## 6. Write the `.env` file

```bash
nano /opt/renoviq/.env
chmod 600 /opt/renoviq/.env
```

Start from `deploy/server.env.example` in this repository, or this list. The workflow stops, before building anything, if a required name is missing or empty.

| Variable | Required | What to put |
| --- | --- | --- |
| `MONGO_USER` | yes | Any name, for example `renoviq` |
| `MONGO_PASSWORD` | yes | Random, **letters and digits only**: `openssl rand -hex 24` |
| `SESSION_SECRET` | yes | Random: `openssl rand -hex 32` |
| `CLIENT_ORIGIN` | yes | `https://YOUR.DOMAIN` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | From the Google Cloud OAuth client |
| `GOOGLE_CALLBACK_URL` | yes | `https://YOUR.DOMAIN/auth/google/callback` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | yes | Your mail server (the sign-up code is emailed) |
| `GEMINI_API_KEY` | yes | From Google AI Studio (see step 9) |
| `S3_BUCKET` | yes | The bucket name from step 1 |
| `AWS_REGION` | yes | The bucket's region, for example `us-east-1` |
| `MONGODB_DB_NAME` | no | Default `renoviqai` |
| `SMTP_SECURE`, `SMTP_FROM` | no | `SMTP_SECURE=true` for port 465 |
| `CONTACT_FORM_RECEIVER_EMAIL` | no | Where contact-form messages go |
| `GEMINI_IMAGE_MODEL` | no | Default `gemini-nano-banana-2.1` |

Plain `KEY=value` lines, one per line. Put a value in single quotes if it contains `$`, `#` or spaces. **Do not add AWS access keys**: the instance role provides them.

## 7. Set up nginx and HTTPS

nginx is configured by you; the workflows never touch it.

```bash
sudo curl -fsSL https://raw.githubusercontent.com/Renoviq/renoviq-backend/main/deploy/nginx/renoviq.conf -o /etc/nginx/sites-available/renoviq.conf
sudo sed -i 's/renoviq.example.com/YOUR.DOMAIN/' /etc/nginx/sites-available/renoviq.conf
sudo ln -s /etc/nginx/sites-available/renoviq.conf /etc/nginx/sites-enabled/renoviq.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR.DOMAIN
```

The file is `deploy/nginx/renoviq.conf` in this repository. It serves the web app from `/var/www/renoviq/current`, forwards `/api` and `/auth/google` (Google sign-in) to the API on `127.0.0.1:3000`, allows photo uploads up to 6 MB, waits up to 120 s for the AI, and rate-limits the sign-in endpoints. Certbot asks for an email, adds the HTTPS block and redirects HTTP to HTTPS, and renews the certificate by itself.

Until the first frontend deploy, the site shows an error because `/var/www/renoviq/current` does not exist yet. That is expected.

## 8. Let GitHub log in to the server

On your own computer:

```bash
ssh-keygen -t ed25519 -f renoviq-deploy -C github-actions -N ""
cat renoviq-deploy.pub
```

On the server, add the public line to `~/.ssh/authorized_keys`:

```bash
echo "PASTE_THE_PUBLIC_LINE_HERE" >> ~/.ssh/authorized_keys
```

## 9. Add the GitHub secrets

Each repository: Settings → Secrets and variables → Actions → **New repository secret**.

**renoviq-backend**

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Your Docker Hub user |
| `DOCKERHUB_TOKEN` | Docker Hub → Account settings → Personal access tokens → Read & Write. The same token pushes the image and pulls it on the server |
| `EC2_HOST` | The Elastic IP or `YOUR.DOMAIN` |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | The whole private key file `renoviq-deploy` (with the BEGIN and END lines) |

**renoviq-frontend**: the same three `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`.

Also outside GitHub:

- **Google Cloud:** on the OAuth client, add the redirect URI `https://YOUR.DOMAIN/auth/google/callback`.
- **Gemini:** the default image model has **no free tier**: enable billing on your Google AI Studio project (aistudio.google.com/api-keys), about $0.034 per image. Each user is limited to 10 designs per hour. To try without billing, set `GEMINI_IMAGE_MODEL=gemini-2.5-flash-image` in the `.env` (has a free tier with limits; not tested with this app).

## 10. Run the workflows

1. **renoviq-backend** → Actions → **Deploy backend** → Run workflow.
2. When it is green, **renoviq-frontend** → Actions → **Deploy frontend** → Run workflow.
3. Open `https://YOUR.DOMAIN`. `https://YOUR.DOMAIN/api/health` should answer `{"status":"ok"}`.

What the backend run does, in order: checks Docker, the folder and the `.env` file on the server (stops in seconds if something is missing), runs the tests, builds the image on GitHub and pushes it to Docker Hub, copies `docker-compose.yml` to the server, logs in to Docker Hub there with the same token, starts MongoDB (first run only, never touched again) and the API, waits for the health check, and checks that the API can reach the S3 bucket. If the new API does not become healthy, the previous version is started again.

## Day to day

- **Update:** run the workflow again. The backend swaps only the API container; the frontend keeps the 2 previous builds next to the new one.
- **Changed the `.env`?** Run **Deploy backend** again so the API restarts with it. `MONGO_USER` and `MONGO_PASSWORD` only apply when the database is first created.
- **Logs and state:**
  ```bash
  cd /opt/renoviq && docker compose ps && docker compose logs -f api
  ```
- **Go back to an older web app build:**
  ```bash
  ls -1t /var/www/renoviq/releases
  ln -sfn /var/www/renoviq/releases/<older> /var/www/renoviq/current.new && mv -Tf /var/www/renoviq/current.new /var/www/renoviq/current
  ```
- **Back up the database** (it lives on the same server; copy the file somewhere else, ideally from cron):
  ```bash
  cd /opt/renoviq && docker compose exec -T mongo sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' > backup.archive.gz
  ```

## When something fails

| You see | Do this |
| --- | --- |
| "Docker Engine with the Compose plugin must be installed…" | Step 4: install Docker and log out and in again after `usermod` |
| "Write /opt/renoviq/.env on the server first" or "has no value for: …" | Step 6: it names the missing variables |
| "Cannot create /opt/renoviq" | Give the user passwordless sudo (default on EC2 Ubuntu) or do step 5 |
| "S3 check failed … (HTTP 403)" | The role policy or bucket name is wrong (steps 1 and 2) |
| "S3 check failed … Could not load credentials" | The role is not attached to the instance, or the metadata hop limit is not 2 (step 3) |
| The new API is "unhealthy" | `docker compose logs --tail 50 api`; usually a wrong value in `.env` |
| Site shows nginx 502 | The API container is down: `docker compose ps` |
| "AI design is not set up on this server yet" (503) | `GEMINI_API_KEY`, `S3_BUCKET` or `AWS_REGION` is missing in the `.env`; run Deploy backend again |
| "The AI service is busy" (429) | Gemini quota or billing (step 9) |
| Photo upload fails with 413 | The nginx file is older than this guide: `client_max_body_size` must be `6m` |
