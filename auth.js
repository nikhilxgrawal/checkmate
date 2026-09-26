const crypto = require("crypto");
const nodemailer = require("nodemailer");

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 60s between OTP sends per email
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// In-memory OTP store: email -> { hash, expires, attempts, lastSentAt }
const otpStore = new Map();

function transporter() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    requireTLS: port !== 465,
    // Without these, a blocked/stalled outbound SMTP connection hangs forever
    // (the symptom we saw: log stops at "sending OTP", no result, no error).
    // These force a fast, logged failure instead.
    connectionTimeout: 10000, // TCP connect
    greetingTimeout: 10000, // wait for server 220 greeting
    socketTimeout: 20000, // inactivity after connect
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

// Runtime override of the allowed domains (managed from the admin panel and
// persisted in the DB by server.js). When null, we fall back to the env var.
let _allowedDomainsOverride = null;
function setAllowedDomains(list) {
  _allowedDomainsOverride = Array.isArray(list)
    ? list.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean)
    : null;
}

function allowedDomains() {
  if (_allowedDomainsOverride) return _allowedDomainsOverride;
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

// The "org" is the first label of the email domain:
//   g.siva@unicommerce.com -> "unicommerce",  a@snapdeal.com -> "snapdeal".
function orgFromEmail(email) {
  const domain = String(email || "").split("@")[1] || "";
  return (domain.split(".")[0] || "").toLowerCase();
}

// Central list of allowed orgs, derived from ALLOWED_EMAIL_DOMAINS. Empty when
// no domain restriction is configured (any domain allowed).
function allowedOrgs() {
  return allowedDomains()
    .map((d) => (d.split(".")[0] || "").toLowerCase())
    .filter(Boolean);
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

  // Rate limit: one OTP per 60s per email
  const existing = otpStore.get(email);
  if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
    return {
      ok: false,
      status: 429,
      retryAfter,
      error: `Please wait ${retryAfter}s before requesting another code.`,
    };
  }

  const code = ("" + Math.floor(100000 + Math.random() * 900000)).slice(0, 6);
  otpStore.set(email, {
    hash: hashOtp(email, code),
    expires: Date.now() + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: Date.now(),
  });

  // DEV-ONLY: when OTP_DEV_ECHO=true, print the code to the server console and
  // skip sending email entirely. This lets you test the login/verify flow
  // locally without SMTP. NEVER enable this in production — it exposes codes.
  if (process.env.OTP_DEV_ECHO === "true") {
    console.log(
      `\n[auth][DEV] OTP for ${email} is ${code}  ` +
      `(OTP_DEV_ECHO enabled — email sending skipped; do NOT use in production)\n`
    );
    return { ok: true, email };
  }

  const from = process.env.MAIL_FROM;
  // Diagnostic: flag any missing SMTP config (common cause of "no OTP arrives").
  const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.warn(`[auth] SMTP config missing: ${missing.join(", ")}`);
  }
  console.log(
    `[auth] sending OTP to ${email} via ${process.env.SMTP_HOST}:${
      process.env.SMTP_PORT || 587
    } from=${from}`
  );
  try {
    const info = await transporter().sendMail({
      from: `SnapGames <${from}>`,
      to: email,
      subject: `Your SnapGames verification code: ${code}`,
      text: `Your SnapGames verification code is ${code}. It expires in 10 minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#050608;color:#fff;padding:32px;border-radius:12px;max-width:420px;margin:auto">
          <h1 style="letter-spacing:2px;margin:0 0 4px">SNAP<span style="color:#e4002b">GAMES</span></h1>
          <p style="color:#9aa3b2;margin:0 0 20px;font-size:13px">The Acevector Gaming Arena</p>
          <p style="font-size:15px">Your verification code is:</p>
          <div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#e4002b;margin:12px 0">${code}</div>
          <p style="color:#9aa3b2;font-size:13px">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
        </div>`,
    });
    // sendMail resolving does NOT guarantee delivery — the SMTP server may have
    // accepted the connection but rejected the recipient. Log the outcome so a
    // silent rejection (e.g. SES sandbox, unverified recipient) is visible.
    console.log(
      `[auth] OTP mail result for ${email}: accepted=${JSON.stringify(
        info.accepted
      )} rejected=${JSON.stringify(info.rejected)} response=${JSON.stringify(
        info.response
      )} id=${info.messageId}`
    );
    if (Array.isArray(info.rejected) && info.rejected.length) {
      console.warn(`[auth] OTP recipient REJECTED by SMTP for ${email}`);
    }
  } catch (e) {
    otpStore.delete(email);
    console.error(`[auth] OTP email failed for ${email}:`, e.message);
    return {
      ok: false,
      status: 502,
      error: "Could not send the verification email. Try again.",
    };
  }

  console.log(`[auth] OTP sent to ${email}`);
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
    console.warn(`[auth] OTP verify failed for ${email} (incorrect code)`);
    return { ok: false, status: 401, error: "Incorrect code." };
  }
  otpStore.delete(email);
  console.log(`[auth] OTP verified for ${email}`);
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

// Send a "match is live" notification email to a single recipient.
// Returns { ok } or { ok:false, error }.
async function sendMatchLiveEmail(toEmail, { title, line, url } = {}) {
  const from = process.env.MAIL_FROM;
  try {
    await transporter().sendMail({
      from: `SnapGames <${from}>`,
      to: toEmail,
      subject: `🔴 LIVE: ${title || "A match is now live"}`,
      text: `${line || title} is now LIVE on SnapGames. ${url || ""}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#050608;color:#fff;padding:32px;border-radius:12px;max-width:460px;margin:auto">
          <h1 style="letter-spacing:2px;margin:0 0 4px">SNAP<span style="color:#e4002b">GAMES</span></h1>
          <p style="color:#9aa3b2;margin:0 0 20px;font-size:13px">The Acevector Gaming Arena</p>
          <div style="display:inline-block;background:#e4002b;color:#fff;font-weight:800;letter-spacing:1px;padding:6px 14px;border-radius:6px;font-size:13px">🔴 NOW LIVE</div>
          <p style="font-size:18px;font-weight:800;margin:16px 0 6px">${line || title}</p>
          <p style="color:#cbd2dd;font-size:14px;margin:0 0 20px">The match has just gone live. Head over to SnapGames and follow the action!</p>
          ${url ? `<a href="${url}" style="display:inline-block;background:#e4002b;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Open SnapGames</a>` : ""}
          <p style="color:#6b7078;font-size:12px;margin-top:24px">You're receiving this because you opted in to match notifications. You can opt out any time on the SnapGames home page.</p>
        </div>`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Email a bidder their result once a match is settled.
// opts: { won:boolean, stake:number, payout:number, matchLine:string, outcomeLabel:string, balance:number, url }
async function sendBetResultEmail(toEmail, opts = {}) {
  const from = process.env.MAIL_FROM;
  const { won, stake = 0, payout = 0, matchLine = "", outcomeLabel = "", balance, url } = opts;
  const net = (payout || 0) - (stake || 0);
  const headline = won ? "🎉 You won your bet!" : "😔 Better luck next time";
  const accent = won ? "#3fbf6f" : "#e4002b";
  const detailText = won
    ? `Your ₹${stake} bid on ${outcomeLabel} won — you received ₹${payout} (net +₹${net}).`
    : `Your ₹${stake} bid on ${outcomeLabel} didn't win. You lost ₹${stake}.`;
  try {
    await transporter().sendMail({
      from: `SnapGames <${from}>`,
      to: toEmail,
      subject: won ? `🎉 You won ₹${payout} on SnapGames` : `Your SnapGames bet result`,
      text: `${matchLine} — result is in. ${detailText}${balance != null ? ` Your balance: ₹${balance}.` : ""} ${url || ""}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#050608;color:#fff;padding:32px;border-radius:12px;max-width:460px;margin:auto">
          <h1 style="letter-spacing:2px;margin:0 0 4px">SNAP<span style="color:#e4002b">GAMES</span></h1>
          <p style="color:#9aa3b2;margin:0 0 20px;font-size:13px">The Acevector Gaming Arena</p>
          <p style="font-size:20px;font-weight:900;color:${accent};margin:0 0 6px">${headline}</p>
          <p style="font-size:15px;font-weight:700;margin:12px 0 4px">${matchLine}</p>
          <p style="color:#cbd2dd;font-size:14px;margin:0 0 16px">${detailText}</p>
          ${balance != null ? `<div style="display:inline-block;background:rgba(245,197,66,0.15);border:1px solid #f5c542;color:#f5c542;font-weight:800;padding:8px 14px;border-radius:20px">💰 Balance: ₹${balance}</div>` : ""}
          ${url ? `<div style="margin-top:20px"><a href="${url}" style="display:inline-block;background:#e4002b;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Open SnapGames</a></div>` : ""}
          <p style="color:#6b7078;font-size:12px;margin-top:24px">You're receiving this because you placed a bid on this match.</p>
        </div>`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  sendOtp,
  verifyOtp,
  verifySession,
  normalizeEmail,
  sendMatchLiveEmail,
  sendBetResultEmail,
  verifySmtp,
  orgFromEmail,
  allowedOrgs,
  allowedDomains,
  setAllowedDomains,
};

// Verify SMTP connection + auth at startup so bad host/credentials surface
// immediately instead of only when the first user requests a code.
async function verifySmtp() {
  const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.warn(`[auth] SMTP not configured, missing: ${missing.join(", ")}`);
    return;
  }
  try {
    await transporter().verify();
    console.log(
      `[auth] SMTP connection OK (${process.env.SMTP_HOST}:${
        process.env.SMTP_PORT || 587
      })`
    );
  } catch (e) {
    console.error("[auth] SMTP verify FAILED:", e.message);
  }
}
