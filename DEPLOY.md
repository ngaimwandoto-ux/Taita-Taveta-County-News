# Deploying to a VPS (Ubuntu)

Written from standard practice and **not tested on HostPinnacle**. Ask them first: can I run Node 22 (a current LTS) and PostgreSQL, where is the server located, is SSL free, are daily backups included? A small plan (about 2 GB memory) should do for a pilot.

1. **Secure the server.** Create a non-root user. `sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable`
2. **Install software.** Node 22 (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`), then `sudo apt install -y postgresql nginx certbot python3-certbot-nginx`, then `sudo npm i -g pm2`.
3. **Database.** `sudo -u postgres psql`, then `CREATE USER county WITH PASSWORD 'long-random-password'; CREATE DATABASE county_media OWNER county;`
4. **Upload the project** (the zip) to `/home/you/county-media`, unzip, and run `npm install --omit=dev`.
5. **Settings.** `cp .env.example .env`, fill it in, then `chmod 600 .env`. `PUBLIC_URL` must be your https address.
6. **Create the tables, in order:** `psql "$DATABASE_URL" -f schema.sql`, then `schema_v2.sql`, `v3`, `v4`, `v5`, `v6`, `v7`, `v8`, `v9`, `v10`, `v11`, `v12`, `v13`, `v14`, `v15`, `v16`.
7. **Create your master key:** `node --env-file=.env scripts/create-owner.js "Your Name"`. Save the key. Then sign in at `/desk.html`, create a recovery code and store it apart from the key.
8. **Run it for good:** `pm2 start server.js --name county-media --node-args="--env-file=.env"`, then `pm2 save` and `pm2 startup` (run the command it prints).
9. **Web address and https.** Point your domain at the server. Create an nginx site that proxies to `http://127.0.0.1:3000` with `client_max_body_size 3m;`, then run `sudo certbot --nginx -d your-domain.co.ke`.
10. **Webhooks.** M-Pesa callback: `https://your-domain/api/mpesa-callback/<MPESA_CALLBACK_SECRET>`. WhatsApp: `https://your-domain/api/whatsapp`.
11. **Backups (do not skip).** Nightly cron: `pg_dump` the database and copy the `uploads/` folder, keep a copy off the server, and test a restore once.
12. **Updating later.** Upload the new files, `npm install --omit=dev`, run any new `schema_vN.sql`, then `pm2 restart county-media`.

Before launch: add the boundary file, fonts, icons and the first issue PDF (see README), test M-Pesa on the sandbox, and have the agreements reviewed.

The full step-by-step manual is a separate document (Deployment Manual). This file is the short version.

**Using GitHub instead of uploading a zip:** see "Putting the project on GitHub" in README.md. The server pulls the code with `git clone`, and later updates are `git pull`, `npm install --omit=dev`, any new schema file, then `pm2 restart county-media`.
