# Harbour CRM — Backend (Node.js + Express + MongoDB)

The API used by both the **website** (`harbour-web`) and the **mobile app** (`harbour-mobile`).
It handles login, roles & permissions, leads, clients, follow-ups, reminders, meetings, tasks,
to-dos, notes, documents (file uploads), payments, chat, calendar, dashboard, team management,
Facebook Lead Ads and website-form integrations, realtime sync and push reminders.

```
harbour-backend/
├── index.js               # ENTRY POINT: Express app, routes, CORS, Socket.IO, starts the server
├── config/index.js        # reads .env
├── models/                # Mongoose models (MongoDB collections)
├── routes/                # REST endpoints (auth, leads, clients, follow-ups, tasks, chat…)
├── middleware/            # login check, error handler
├── utils/                 # permissions, realtime, chat, activity log, mail, helpers
├── jobs/reminders.js      # push notifications every 5 minutes
├── scripts/seed.js        # sample data (testing only)
├── scripts/createAdmin.js # create the first super admin
├── uploads/               # uploaded documents are stored here
├── deploy/nginx-harbour.conf
├── ecosystem.config.js    # PM2
└── .env.example
```

**CORS is fully open**: any website, domain, IP, port or app can call the API and the realtime socket —
no origin list to maintain and no CORS errors.

## 1. Run it on your computer

Requirements: **Node.js 18+** and **MongoDB 6 or 7** (local install, or a free MongoDB Atlas cluster).

```bash
cd harbour-backend
cp .env.example .env          # (Windows: copy .env.example .env) then edit MONGODB_URI and JWT_SECRET
npm install
npm run create-admin -- owner@yourcompany.com "YourStrongPassword" "Your Name"
npm run dev                   # http://localhost:5000/api/health
```

Want sample data to click around? `npm run seed` (only on an empty database) creates four users,
all with password `Password123!`:

| Email | Role | Department |
|---|---|---|
| owner@example.com | Super Admin | — |
| admin@example.com | Admin | Sales |
| employee@example.com | Employee | Sales |
| ethan@example.com | Employee | Client Services |

`npm run seed -- --force` **wipes the database** and reloads the sample data. Never run it on your live server.

## 2. Deploy to a VPS (Ubuntu 22.04/24.04)

```bash
# 1) Node.js 20 + PM2 + nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm i -g pm2

# 2) MongoDB 7 (official repo)  — or skip and use MongoDB Atlas in MONGODB_URI
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod

# 3) The backend
sudo mkdir -p /var/www && cd /var/www
# upload harbour-backend.zip here, then:
unzip harbour-backend.zip && cd harbour-backend
cp .env.example .env && nano .env      # set NODE_ENV=production, JWT_SECRET, PUBLIC_API_URL, WEB_APP_URL, TIMEZONE
npm install --omit=dev
npm run create-admin -- owner@yourcompany.com "YourStrongPassword" "Your Name"
pm2 start ecosystem.config.js && pm2 save && pm2 startup   # keeps it running after reboots

# 4) nginx + HTTPS (website and API on one domain)
sudo cp deploy/nginx-harbour.conf /etc/nginx/sites-available/harbour
sudo nano /etc/nginx/sites-available/harbour        # replace crm.yourdomain.com
sudo ln -s /etc/nginx/sites-available/harbour /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d crm.yourdomain.com
```

Point your domain's DNS **A record** to the VPS IP before running certbot.
The website build goes in `/var/www/harbour-web` (see the web zip's README).

Useful commands: `pm2 logs harbour-api` (logs), `pm2 restart harbour-api` (after changing `.env` or code).

### Updating later
Upload the new files (keep your `.env` and `uploads/`), then `npm install --omit=dev && pm2 restart harbour-api`.

### Backups
- Database: `mongodump --db harbour_crm --out /backups/$(date +%F)` (put it in a daily cron job).
- Files: back up the `uploads/` folder too (documents live there).

## 3. Settings (`.env`)

| Setting | What it does |
|---|---|
| `PORT` | Port the API listens on (nginx forwards to it). Default 5000. |
| `MONGODB_URI` | MongoDB connection string. |
| `JWT_SECRET` | Long random string used to sign logins. **Required in production.** |
| `JWT_EXPIRES_IN` | How long a login lasts (default `30d`). |
| `PUBLIC_API_URL` | Public address of the API, used for document download links. |
| `WEB_APP_URL` | Website address, used in password-reset emails. |
| `TIMEZONE` | Your business timezone, e.g. `Asia/Kolkata`. Used for "today", charts and reminder texts. |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | Where documents are stored and the size limit (default 25 MB). |
| `REMINDER_WINDOW_MINUTES` | Push a follow-up reminder this many minutes before it is due (default 15). |
| `META_APP_SECRET` | Optional. Verifies Facebook webhook signatures. |
| `SMTP_*`, `MAIL_FROM` | Optional. Sends password-reset emails. Without SMTP the reset link is printed in `pm2 logs`. |

## 4. Permissions (enforced on the server for every request)

| Role | Leads / clients / follow-ups / tasks / notes | Team | Delete |
|---|---|---|---|
| **Super Admin** | Everything, every department | Create any role, change roles & departments, deactivate, manage departments and integrations | Yes |
| **Admin** | Everything in their own department (+ records with no department) | Create employees/admins in their own department; cannot create or promote super admins | Yes, within department |
| **Employee** | Only records assigned to or created by them; anything they create is assigned to themselves | — | Only their own tasks / follow-ups / notes / uploads |

To-dos are private to each user. Chat messages are visible only to channel members. Every user is in
**General**; department members (and super admins) are in their department channel automatically.

## 5. Integrations

**Website form** — Integrations → Website form → *Add a website form* (super admin). Paste the snippet
into your site. It posts to `https://YOUR-DOMAIN/api/webhooks/website-lead` with an `X-Api-Key` header.
Duplicates (same email or phone within 30 days) are merged into the existing lead.

**Facebook / Instagram Lead Ads** — Integrations → Facebook → *Connect a Facebook page*. In Meta for
Developers set the webhook callback URL to `https://YOUR-DOMAIN/api/webhooks/meta`, use the verify token
shown in the CRM, and subscribe to `leadgen`. Then run
`POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` in Graph API Explorer. Optional: set
`META_APP_SECRET` in `.env`.

## 6. Push reminders

Built in — no extra cron needed. Every 5 minutes the server sends an Expo push notification to the
assignee's phones for each pending follow-up/reminder/meeting due within `REMINDER_WINDOW_MINUTES`.
The phone must have the app installed from an EAS build with notifications allowed (see the mobile README).

## 7. API overview

All endpoints are under `/api` and (except auth/webhooks/files) need `Authorization: Bearer <token>`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/password`, `POST /auth/forgot`, `POST /auth/reset`, `POST/DELETE /auth/push-token` |
| Team | `GET/POST /departments`, `GET/POST /profiles`, `PATCH /profiles/:id`, `GET /employee-performance` |
| Leads | `GET/POST /leads`, `GET/PATCH/DELETE /leads/:id`, `POST /leads/:id/convert`, `POST /leads/import`, `GET /leads/export` |
| Clients | `GET/POST /clients`, `GET/PATCH/DELETE /clients/:id` |
| Follow-ups, reminders, meetings | `GET/POST /follow-ups`, `GET/PATCH/DELETE /follow-ups/:id` |
| Tasks | `GET/POST /tasks`, `PATCH/DELETE /tasks/:id` |
| History | `GET/POST /activities`, `DELETE /activities/:id` |
| Documents | `GET /documents`, `POST /documents?kind=lead|client&record_id=` (multipart `file`), `GET /documents/:id/url`, `DELETE /documents/:id` |
| Payments | `GET/POST /payments`, `PATCH/DELETE /payments/:id` |
| To-do / Notes | `GET/POST /todos`, `PATCH/DELETE /todos/:id`, `GET/POST /notes`, `PATCH/DELETE /notes/:id` |
| Chat | `GET /chat/channels`, `GET/POST /chat/channels/:id/messages`, `POST /chat/channels/:id/read`, `POST /chat/direct`, `POST /chat/groups`, `DELETE /chat/messages/:id` |
| Calendar / Dashboard | `GET /calendar?from&to`, `GET /dashboard?days=30`, `GET /module-counts` |
| Integrations (super admin) | `GET/POST /integrations`, `PATCH/DELETE /integrations/:id`, `GET /integrations/:id/events` |
| Public | `GET /health`, `GET/POST /webhooks/meta`, `POST /webhooks/website-lead`, `GET /files/:id?token=` |

Realtime: clients connect with Socket.IO (`auth: { token }`) and receive `change` events
(`{ table }`) whenever data changes, then refetch through the permission-checked API.
#   h a r b o u r - b a c k e n d  
 