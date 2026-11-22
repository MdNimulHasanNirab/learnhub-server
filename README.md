# LearnHub Server

## Technology

Node.js, Express.js, MongoDB Native Driver, Better Auth JWKS verification, Stripe, and ImgBB.

## Commands

- `npm run dev` — Node watch mode
- `npm start` — production server
- `npm test` — run tests

## Security

Protected routes verify a Better Auth JWT using JWKS, synchronize/load the trusted database user, and enforce role middleware. Resource ownership is checked in course and lesson operations.

## Environment

Copy `.env.example` to `.env`. Production requires MongoDB, Stripe, webhook, ImgBB, and client URL values.

Set `INITIAL_ADMIN_EMAIL` before first login; that configured account is synchronized as the initial admin. New public registrations are always students. Promote mentor accounts from the admin dashboard. Client and server must use the same persistent MongoDB database in production.
