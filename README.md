# RigRent Server

Express API for equipment listings, booking, role authorization, MongoDB storage, Stripe payment fulfillment and ImgBB upload.

## Local development

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Configure MongoDB, Stripe, ImgBB, Better Auth origin, and the initial administrator email. See [`../docs/AUTHENTICATION.md`](../docs/AUTHENTICATION.md), [`../docs/DATABASE_SCHEMA.md`](../docs/DATABASE_SCHEMA.md) and [`../docs/API_DOCUMENTATION.md`](../docs/API_DOCUMENTATION.md).

The API defaults to `http://localhost:5000`; `GET /api/health` is its health endpoint. Live backend URL: **Not deployed yet**.

## Deployment on Vercel

The Vercel project `rigrent-server` is linked to this independent repository and uses the Express entry point in [`index.js`](./index.js). Before deploying, configure Production (and Preview, if needed) environment variables in Vercel:

- `NODE_ENV=production`
- `MONGODB_URI` and `MONGODB_DB_NAME` — production MongoDB Atlas connection.
- `CLIENT_URL` and `CORS_ORIGINS` — deployed client origin(s).
- `BETTER_AUTH_URL` — deployed client origin used for token verification.
- `INITIAL_ADMIN_EMAIL` — email that receives initial admin privileges.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` — Stripe keys; webhook URL is `<api-origin>/api/webhooks/stripe`.
- `IMGBB_API_KEY` — private ImgBB API key.

Set secrets in Vercel Project Settings → Environment Variables. Deploy with `vercel --prod` from this repository only after the client has a production URL and all required values are configured.

## Endpoints

| Area | Routes |
| --- | --- |
| Catalog | `GET /api/equipment`, `/featured`, `/:id` |
| Owner listings | `POST /api/equipment`, `GET /api/owner/equipment`, `PATCH/DELETE /api/equipment/:id` |
| Profile | `GET/PATCH /api/me` |
| Favorites | `GET /api/favorites`, `POST/DELETE /api/favorites/:equipmentId` |
| Rentals | `POST/GET /api/bookings`, `POST /api/bookings/:id/checkout`, `GET /api/checkout/:sessionId` |
| Administration | `GET /api/admin/users`, `PATCH /api/admin/users/:id/role`, `GET /api/admin/equipment` |
| Analytics | `GET /api/analytics/admin`, `GET /api/analytics/owner` |
| Integrations | `POST /api/upload-image`, `POST /api/webhooks/stripe` |

## Scripts

- `npm run dev` — watch mode.
- `npm start` — production server.
- `npm test` — Node test runner.

`MONGODB_URI` is required in production. Without it, local development uses ephemeral in-memory storage and no data persists after restart. Never expose Stripe, ImgBB, OAuth or database secrets in source control.
