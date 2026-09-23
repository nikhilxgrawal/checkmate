/**
 * otp-email-auth
 * -------------------------------------------------------------------------
 * A small, dependency-light email OTP login flow for Node.js.
 *
 *   1. requestOtp(email)      -> emails a 6-digit code (SMTP via nodemailer)
 *   2. verifyOtp(email, code) -> returns a signed, stateless session token
 *   3. verifySession(token)   -> returns the email if the token is valid
 *
 * Sessions are stateless HMAC-signed tokens (no DB/session store needed).
 * OTP codes are kept in memory only until used or expired.
 *
 * Dependencies: nodemailer   (npm i nodemailer)
 *
 * Usage:
 *   const { createOtpAuth } = require("./otp-email-auth");
 *   const auth = createOtpAuth({
 *     smtp: { host, port, user, pass },
 *     mailFrom: "no-reply@yourdomain.com",
 *     fromName: "My App",
 *     sessionSecret: process.env.SESSION_SECRET, // 32+ random chars
 *     allowedDomains: ["yourcompany.com"],       // [] = allow any domain
 *   });
 * -------------------------------------------------------------------------
 */
const crypto = require("crypto");
const nodemailer = require("nodemailer");

function createOtpAuth(options = {}) {
  const cfg = {
    smtp: options.smtp || {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    mailFrom: options.mailFrom || process.env.MAIL_FROM,
    fromName: options.fromName || "Verification",
    sessionSecret:
      options.sessionSecret ||
      process.env.SESSION_SECRET ||
      crypto.randomBytes(32).toString("hex"), // random => tokens die on restart
    allowedDomains:
      options.allowedDomains ||
      (process.env.ALLOWED_EMAIL_DOMAINS || "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    otpTtlMs: options.otpTtlMs || 10 * 60 * 1000, // 10 min
    otpMaxAttempts: options.otpMaxAttempts || 5,
    resendCooldownMs: options.resendCooldownMs || 30 * 1000, // 30 s
    sessionTtlMs: options.sessionTtlMs || 12 * 60 * 60 * 1000, // 12 h
    // Optional custom email renderer: ({ code, ttlMinutes }) => { subject, text, html }
    renderEmail: options.renderEmail || defaultRenderEmail,
  };

  if (!cfg.sessionSecret || cfg.sessionSecret.length < 16) {
    console.warn(
      "[otp-email-auth] WARNING: weak or missing sessionSecret. " +
        "Set a long, random SESSION_SECRET so sessions survive restarts and are secure."
    );
  }

  // email -> { hash, expires, attempts, lastSentAt }
  const otpStore = new Map();

  const transporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: Number(cfg.smtp.port || 587),
    secure: Number(cfg.smtp.port) === 465, // 465 = TLS, 587 = STARTTLS
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });

  // ---------- helpers ----------
  const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
  const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const isDomainAllowed = (email) => {
    if (cfg.allowedDomains.length === 0) return true;
    return cfg.allowedDomains.includes(email.split("@")[1]);
  };
  const hashOtp = (email, code) =>
    crypto.createHmac("sha256", cfg.sessionSecret).update(email + ":" + code).digest("hex");

  // ---------- step 1: request OTP ----------
  async function requestOtp(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email))
      return { ok: false, status: 400, error: "Enter a valid email address." };
    if (!isDomainAllowed(email)) {
      return {
        ok: false,
        status: 403,
        error: `Only ${cfg.allowedDomains.join(", ")} email addresses are allowed.`,
      };
    }
    const existing = otpStore.get(email);
    if (existing && Date.now() - existing.lastSentAt < cfg.resendCooldownMs) {
      return {
        ok: false,
        status: 429,
        error: "Please wait a moment before requesting another code.",
      };
    }

    const code = ("" + Math.floor(100000 + Math.random() * 900000)).slice(0, 6);
    otpStore.set(email, {
      hash: hashOtp(email, code),
      expires: Date.now() + cfg.otpTtlMs,
      attempts: 0,
      lastSentAt: Date.now(),
    });

    const { subject, text, html } = cfg.renderEmail({
      code,
      ttlMinutes: Math.round(cfg.otpTtlMs / 60000),
      appName: cfg.fromName,
    });

    try {
      await transporter.sendMail({
        from: `${cfg.fromName} <${cfg.mailFrom}>`,
        to: email,
        subject,
        text,
        html,
      });
    } catch (e) {
      otpStore.delete(email);
      return {
        ok: false,
        status: 502,
        error: "Could not send the verification email. Try again.",
        detail: e.message,
      };
    }
    return { ok: true, email };
  }

  // ---------- step 2: verify OTP -> session token ----------
  function verifyOtp(rawEmail, code) {
    const email = normalizeEmail(rawEmail);
    const entry = otpStore.get(email);
    if (!entry) return { ok: false, status: 400, error: "Request a code first." };
    if (Date.now() > entry.expires) {
      otpStore.delete(email);
      return { ok: false, status: 400, error: "Code expired. Request a new one." };
    }
    if (entry.attempts >= cfg.otpMaxAttempts) {
      otpStore.delete(email);
      return { ok: false, status: 429, error: "Too many attempts. Request a new code." };
    }
    entry.attempts += 1;
    if (hashOtp(email, String(code || "").trim()) !== entry.hash) {
      return { ok: false, status: 401, error: "Incorrect code." };
    }
    otpStore.delete(email); // one-time use
    return { ok: true, email, token: issueSession(email) };
  }

  // ---------- step 3: stateless session tokens ----------
  function issueSession(email) {
    const payload = Buffer.from(
      JSON.stringify({ email, exp: Date.now() + cfg.sessionTtlMs })
    ).toString("base64url");
    const sig = crypto
      .createHmac("sha256", cfg.sessionSecret)
      .update(payload)
      .digest("base64url");
    return payload + "." + sig;
  }

  function verifySession(token) {
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const [payload, sig] = token.split(".");
    const expected = crypto
      .createHmac("sha256", cfg.sessionSecret)
      .update(payload)
      .digest("base64url");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (Date.now() > data.exp) return null;
      return data.email;
    } catch {
      return null;
    }
  }

  // ---------- optional: ready-made Express router ----------
  // Mount with: app.use("/api/auth", auth.router());
  //   POST /api/auth/request-otp  { email }
  //   POST /api/auth/verify-otp   { email, code }  -> { token, email }
  function router() {
    const express = require("express");
    const r = express.Router();
    r.use(express.json());
    r.post("/request-otp", async (req, res) => {
      const out = await requestOtp((req.body || {}).email);
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      res.json({ ok: true, email: out.email });
    });
    r.post("/verify-otp", (req, res) => {
      const { email, code } = req.body || {};
      const out = verifyOtp(email, code);
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      res.json({ ok: true, token: out.token, email: out.email });
    });
    return r;
  }

  // ---------- optional: Express middleware to protect routes ----------
  // Expects the session token in the Authorization: Bearer <token> header
  // or a "sessionToken" field in the JSON body. Sets req.userEmail.
  function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer || (req.body && req.body.sessionToken);
    const email = verifySession(token);
    if (!email) return res.status(401).json({ error: "Not authenticated." });
    req.userEmail = email;
    next();
  }

  return {
    requestOtp,
    verifyOtp,
    verifySession,
    issueSession,
    normalizeEmail,
    router,
    requireAuth,
    config: cfg,
  };
}

function defaultRenderEmail({ code, ttlMinutes, appName }) {
  return {
    subject: `Your ${appName} verification code: ${code}`,
    text: `Your ${appName} verification code is ${code}. It expires in ${ttlMinutes} minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:28px;border:1px solid #eee;border-radius:12px">
        <h2 style="margin:0 0 12px">${appName}</h2>
        <p style="font-size:15px;margin:0 0 8px">Your verification code is:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:8px;margin:8px 0">${code}</div>
        <p style="color:#666;font-size:13px">This code expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.</p>
      </div>`,
  };
}

module.exports = { createOtpAuth };
