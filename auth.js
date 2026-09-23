const crypto = require("crypto");
const nodemailer = require("nodemailer");

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// In-memory OTP store: email -> { hash, expires, attempts, lastSentAt }
const otpStore = new Map();

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false, // STARTTLS on 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function allowedDomains() {
  return (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isDomainAllowed(email) {
  const domains = allowedDomains();
  if (domains.length === 0) return true; // no restriction
  const domain = email.split("@")[1];
  return domains.includes(domain);
}

function hashOtp(email, code) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(email + ":" + code)
    .digest("hex");
}

async function sendOtp(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { ok: false, status: 400, error: "Enter a valid email address." };
  }
  if (!isDomainAllowed(email)) {
    const d = allowedDomains().join(", ");
    return {
      ok: false,
      status: 403,
      error: `Only ${d} email addresses can vote.`,
    };
  }

  // Rate limit: one OTP per 30s per email
  const existing = otpStore.get(email);
  if (existing && Date.now() - existing.lastSentAt < 30 * 1000) {
    return {
      ok: false,
      status: 429,
      error: "Please wait a moment before requesting another code.",
    };
  }

  const code = ("" + Math.floor(100000 + Math.random() * 900000)).slice(0, 6);
  otpStore.set(email, {
    hash: hashOtp(email, code),
    expires: Date.now() + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: Date.now(),
  });

  const from = process.env.MAIL_FROM;
  try {
    await transporter().sendMail({
      from: `CHECKMATE <${from}>`,
      to: email,
      subject: `Your CHECKMATE voting code: ${code}`,
      text: `Your CHECKMATE verification code is ${code}. It expires in 10 minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#050608;color:#fff;padding:32px;border-radius:12px;max-width:420px;margin:auto">
          <h1 style="letter-spacing:2px;margin:0 0 4px">CHECK<span style="color:#e4002b">MATE</span></h1>
          <p style="color:#9aa3b2;margin:0 0 20px;font-size:13px">The Acevector Chess Tournament</p>
          <p style="font-size:15px">Your verification code is:</p>
          <div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#e4002b;margin:12px 0">${code}</div>
          <p style="color:#9aa3b2;font-size:13px">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
        </div>`,
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

function verifyOtp(rawEmail, code) {
  const email = normalizeEmail(rawEmail);
  const entry = otpStore.get(email);
  if (!entry) {
    return { ok: false, status: 400, error: "Request a code first." };
  }
  if (Date.now() > entry.expires) {
    otpStore.delete(email);
    return { ok: false, status: 400, error: "Code expired. Request a new one." };
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    otpStore.delete(email);
    return { ok: false, status: 429, error: "Too many attempts. Request a new code." };
  }
  entry.attempts += 1;
  if (hashOtp(email, String(code || "").trim()) !== entry.hash) {
    return { ok: false, status: 401, error: "Incorrect code." };
  }
  otpStore.delete(email);
  return { ok: true, token: issueSession(email), email };
}

// ---- Signed session token (stateless HMAC): base64(payload).signature ----
function issueSession(email) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return payload + "." + sig;
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
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

module.exports = { sendOtp, verifyOtp, verifySession, normalizeEmail };
