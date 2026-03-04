# CanUpls Backend API (Starter)

This backend is designed for your current iOS app contract.

## Endpoints included
- `POST /v1/auth/google/ios`
- `POST /v1/devices/register`
- `POST /v1/location/update`
- `GET /v1/profile`
- `POST /v1/profile/update`
- `POST /v1/tasks`
- `GET /v1/tasks/:taskId`
- `GET /v1/tasks?status=open&lat=<>&lng=<>&radius=<>`
- `PATCH /v1/tasks/:taskId`
- `POST /v1/tasks/:taskId/cancel`
- `POST /v1/tasks/:taskId/offers`
- `POST /v1/tasks/:taskId/offers/:offerId/accept`
- `POST /v1/tasks/:taskId/status`
- `POST /v1/payments/create-intent`
- `POST /v1/ratings`
- `GET /v1/users/:userId/trust`
- `POST /v1/auth/logout`
- `GET /health`

All success responses use:

```json
{
  "response_status": 1,
  "response_msg": "Success",
  "response_data": {}
}
```

All errors use:

```json
{
  "response_status": 0,
  "response_msg": "Error message",
  "response_data": {}
}
```

## 1) Local setup

```bash
cd backend-api
cp .env.example .env
npm install
```

Create PostgreSQL DB and run:

```bash
psql "$DATABASE_URL" -f sql/schema.sql
```

Start server:

```bash
npm run dev
```

## 2) Required environment variables

- `DATABASE_URL`
- `GOOGLE_WEB_CLIENT_ID`
- `PORT` (Render provides this automatically)
- `SESSION_TTL_DAYS` (optional, default 30)
- `CORS_ORIGIN` (optional, default `*`)

## 3) Render deploy

1. Push this `backend-api` folder to GitHub repo.
2. Create a Render **Web Service** (Node).
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables above.
6. Add PostgreSQL (Render or external).
7. Run `sql/schema.sql` against the DB.

## 4) Run SQL schema + deploy (step-by-step)

1. In Render, create Postgres instance.
2. Copy its `External Database URL`.
3. Run schema:

```bash
cd backend-api
psql "$DATABASE_URL" -f sql/schema.sql
```

If you do not have `psql` locally, use Render Postgres SQL query tool and paste `sql/schema.sql`.

4. Create Render Web Service from this folder.
   - Build command: `npm install`
   - Start command: `npm start`
   - Root directory: `backend-api` (if repo has multiple folders)
5. Add env vars:
   - `DATABASE_URL`
   - `GOOGLE_WEB_CLIENT_ID`
   - `SESSION_TTL_DAYS=30`
   - `MATCH_RADIUS_KM=10`
   - `PLATFORM_FEE_PERCENT=15`
   - `CORS_ORIGIN=*`
6. Deploy and validate:
   - `GET /health` should return `response_status: 1`.

## 4) GoDaddy custom domain

After deploy and once service works on `https://<service>.onrender.com`:

- In Render: add custom domain `api.canupls.ca`
- In GoDaddy DNS:
  - `Type`: `CNAME`
  - `Name`: `api`
  - `Value`: `<service>.onrender.com`

Wait for SSL certificate to become active on Render.

## 5) iOS endpoint mapping

Use these in iOS:

- Google auth: `https://api.canupls.ca/v1/auth/google/ios`
- Profile get: `https://api.canupls.ca/v1/profile`
- Profile update: `https://api.canupls.ca/v1/profile/update`
- Logout: `https://api.canupls.ca/v1/auth/logout`

## Notes

- This starter supports both `idToken` and `id_token` in Google auth request.
- Session token is accepted from either:
  - `Authorization: Bearer <token>`
  - `session_token` in body/query
- Add rate limiting, request logging, and stricter validation before production.
