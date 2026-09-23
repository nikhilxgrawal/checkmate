/**
 * Example: a minimal Express app using otp-email-auth.
 *   1. Mounts the ready-made auth router at /api/auth
 *   2. Protects an example route with requireAuth
 *
 * Run:
 *   npm i express nodemailer
 *   SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
 *   MAIL_FROM=no-reply@yourdomain.com SESSION_SECRET=$(openssl rand -hex 32) \
 *   ALLOWED_EMAIL_DOMAINS=yourcompany.com \
 *   node example-server.js
 */
const express = require("express");
const { createOtpAuth } = require("./otp-email-auth");

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // serves example-client.html

const auth = createOtpAuth({
  smtp: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
  mailFrom: process.env.MAIL_FROM,
  fromName: "My App",
  sessionSecret: process.env.SESSION_SECRET, // set a fixed 32+ char secret in prod
  allowedDomains: (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
});

// Login endpoints: POST /api/auth/request-otp , POST /api/auth/verify-otp
app.use("/api/auth", auth.router());

// A protected example endpoint. Send Authorization: Bearer <token>
// (or { sessionToken } in the JSON body).
app.get("/api/me", auth.requireAuth, (req, res) => {
  res.json({ email: req.userEmail });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Example running at http://localhost:${PORT}`));
