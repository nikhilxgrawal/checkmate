# otp-email-auth

A small, reusable **email OTP (one-time password) login flow** for Node.js.

- Sends a 6-digit code to a user's email via SMTP (uses `nodemailer`).
- Verifies the code and issues a **stateless, HMAC-signed session token** — no
  database or session store required.
- Optional **email domain allowlist** (e.g. only `@yourcompany.com`).
- Ships with a ready-made **Express router** and **auth middleware**, plus a
  runnable server + browser example.

The identity is the **verified email address**, not the browser. A user cannot
get extra sessions by opening incognito — re-verifying the same email is still
the same identity to your app.

---

## 1. Files

| File | Purpose |
|------|---------|
| `otp-email-auth.js` | The module. Copy this into your project. |
| `example-server.js` | Minimal Express app showing how to wire it up. |
| `example-client.html` | Minimal browser UI for the 2-step login. |

Only `otp-email-auth.js` is required for integration. It has **one dependency: `nodemailer`** (and `express` only if you use the built-in `router()`).

---

## 2. Install

```bash
npm install nodemailer
# express is only needed if you use auth.router() / auth.requireAuth
npm install express
```

Copy `otp-email-auth.js` into your project.

---

## 3. Configure

Create the auth instance once at startup:

```js
const { createOtpAuth } = require("./otp-email-auth");

const auth = createOtpAuth({
  smtp: {
    host: process.env.SMTP_HOST,       // e.g. email-smtp.ap-south-1.amazonaws.com
    port: process.env.SMTP_PORT || 587,// 587 (STARTTLS) or 465 (TLS)
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
  mailFrom: process.env.MAIL_FROM,      // a VERIFIED sender identity
  fromName: "My App",
  sessionSecret: process.env.SESSION_SECRET, // 32+ random chars, keep secret
  allowedDomains: ["yourcompany.com"],  // [] or omit = allow any domain

  // Optional tuning (defaults shown):
  // otpTtlMs: 10 * 60 * 1000,          // code valid 10 min
  // otpMaxAttempts: 5,                 // wrong-code attempts before lockout
  // resendCooldownMs: 30 * 1000,       // min gap between code requests
  // sessionTtlMs: 12 * 60 * 60 * 1000, // session valid 12 h
  // renderEmail: ({ code, ttlMinutes, appName }) => ({ subject, text, html }),
});
```

### Environment variables (recommended)

```
SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
MAIL_FROM=no-reply@yourcompany.com
SESSION_SECRET=<a long random string, e.g. `openssl rand -hex 32`>
ALLOWED_EMAIL_DOMAINS=yourcompany.com     # comma-separated; blank = any
```

> **`SESSION_SECRET` matters.** If you don't set a fixed value, a random one is
> generated at startup and **all sessions become invalid on every restart**
> (users must re-verify). Set a stable secret in production. It also signs the
> tokens, so keep it private.

---

## 4. The flow (3 functions)

```
requestOtp(email)        -> emails a code            -> { ok, email } | { ok:false, status, error }
verifyOtp(email, code)   -> checks code, issues token-> { ok, email, token } | { ok:false, status, error }
verifySession(token)     -> validates token          -> email (string) | null
```

### Direct use

```js
// Step 1
const r1 = await auth.requestOtp("alice@yourcompany.com");
// r1 = { ok: true, email: "alice@yourcompany.com" }  (email sent)

// Step 2 (code the user typed from their inbox)
const r2 = auth.verifyOtp("alice@yourcompany.com", "123456");
// r2 = { ok: true, email: "...", token: "xxxx.yyyy" }

// Later, on any protected request, validate the token:
const email = auth.verifySession(token); // "alice@yourcompany.com" or null
```

All calls return `{ ok:false, status, error }` on failure so you can pass the
HTTP `status` straight through to the client.

---

## 5. Integrate with Express (fastest path)

```js
const express = require("express");
const app = express();
app.use(express.json());

// Login endpoints:
//   POST /api/auth/request-otp   { email }
//   POST /api/auth/verify-otp    { email, code }  -> { token, email }
app.use("/api/auth", auth.router());

// Protect any route. Reads "Authorization: Bearer <token>"
// or { sessionToken } from the JSON body. Sets req.userEmail.
app.get("/api/me", auth.requireAuth, (req, res) => {
  res.json({ email: req.userEmail });
});
```

### Protect your own routes manually

```js
app.post("/api/do-something", (req, res) => {
  const email = auth.verifySession(req.body.sessionToken);
  if (!email) return res.status(401).json({ error: "Not authenticated." });
  // ...email is the verified user...
});
```

---

## 6. Integrate with other frameworks

The three core functions are framework-agnostic. Examples:

**Fastify**
```js
fastify.post("/api/auth/request-otp", async (req, reply) => {
  const out = await auth.requestOtp(req.body.email);
  if (!out.ok) return reply.code(out.status).send({ error: out.error });
  return { ok: true, email: out.email };
});
```

**Next.js API route** (`pages/api/auth/verify-otp.js`)
```js
import { createOtpAuth } from "../../../lib/otp-email-auth";
const auth = createOtpAuth({ /* config */ });
export default function handler(req, res) {
  const out = auth.verifyOtp(req.body.email, req.body.code);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.json({ token: out.token, email: out.email });
}
```

---

## 7. Frontend (any client)

1. `POST /api/auth/request-otp` with `{ email }`.
2. Ask the user for the code from their inbox.
3. `POST /api/auth/verify-otp` with `{ email, code }` → store the returned `token`.
4. Send the token on protected calls as `Authorization: Bearer <token>`.

See `example-client.html` for a complete, minimal working UI. Store the token in
`localStorage` (persists) or memory (drops on reload) as your security needs
dictate.

---

## 8. Run the example

```bash
npm i express nodemailer
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
MAIL_FROM=no-reply@yourcompany.com SESSION_SECRET=$(openssl rand -hex 32) \
ALLOWED_EMAIL_DOMAINS=yourcompany.com \
node example-server.js
# open http://localhost:4000
```

---

## 9. Security notes & limits

- **One identity = one email.** Domain allowlisting + OTP means fake addresses
  can't receive a code, so they can't verify. This is the main abuse defense.
- **OTP storage is in-memory.** Pending codes live in a `Map` and are cleared on
  use/expiry. If you run multiple processes/instances, either use sticky routing
  or replace the `otpStore` Map with a shared store (Redis) — the code is small
  and easy to adapt.
- **Session tokens are stateless.** They can't be individually revoked before
  expiry (short-lived by default: 12 h). Rotating `SESSION_SECRET` invalidates
  all tokens at once. For per-user revocation, add a token/version check against
  a store.
- **SMTP sender must be verified.** With Amazon SES (or similar), `MAIL_FROM`
  must be a verified identity, and the account must be in **production mode** to
  send to arbitrary recipients (sandbox only sends to verified addresses).
- **Rate limiting.** A 30 s per-email resend cooldown and a 5-attempt cap are
  built in. Add IP-level rate limiting at your gateway for extra protection.
- Don't log OTP codes or tokens in production.

---

## 10. API reference

`createOtpAuth(options)` → returns:

| Method | Signature | Returns |
|--------|-----------|---------|
| `requestOtp` | `async (email)` | `{ ok, email }` or `{ ok:false, status, error, detail? }` |
| `verifyOtp` | `(email, code)` | `{ ok, email, token }` or `{ ok:false, status, error }` |
| `verifySession` | `(token)` | `email` string, or `null` |
| `issueSession` | `(email)` | signed token (advanced/manual use) |
| `router` | `()` | Express Router with `/request-otp`, `/verify-otp` |
| `requireAuth` | `(req,res,next)` | middleware; sets `req.userEmail` |
| `normalizeEmail` | `(email)` | lowercased/trimmed email |
| `config` | — | the resolved config object |
```
