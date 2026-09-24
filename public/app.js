// ---------- Theme (dark / light) ----------
function getTheme() {
  const saved = localStorage.getItem("cm_theme");
  if (saved === "light" || saved === "dark") return saved;
  // default to OS preference
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = t === "light" ? "🌙" : "☀️"; // icon = what you'd switch TO
}
function toggleTheme() {
  const next = getTheme() === "light" ? "dark" : "light";
  localStorage.setItem("cm_theme", next);
  applyTheme(next);
}
// Apply immediately (before DOM ready is fine; sets attribute on <html>)
applyTheme(getTheme());
// Re-apply once the toggle button exists so its icon is set correctly.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => applyTheme(getTheme()));
} else {
  applyTheme(getTheme());
}

// ---------- Coin drop celebration ----------
// Rains gold coins from the top of the viewport. Self-cleans and is a no-op
// for users who prefer reduced motion (handled in CSS too, belt-and-suspenders).
function dropCoins(count = 24) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let layer = document.querySelector(".coin-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "coin-layer";
    document.body.appendChild(layer);
  }
  for (let i = 0; i < count; i++) {
    const c = document.createElement("div");
    c.className = "coin";
    c.style.left = (Math.random() * 100).toFixed(2) + "vw";
    const size = 18 + Math.random() * 16; // 18–34px
    c.style.width = c.style.height = size.toFixed(0) + "px";
    c.style.animationDuration = (1.6 + Math.random() * 1.4).toFixed(2) + "s"; // 1.6–3.0s
    c.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
    c.addEventListener("animationend", () => c.remove());
    layer.appendChild(c);
  }
  // Safety net: drop the layer once the last coin has certainly finished.
  clearTimeout(dropCoins._t);
  dropCoins._t = setTimeout(() => {
    const l = document.querySelector(".coin-layer");
    if (l && !l.children.length) l.remove();
  }, 4000);
}

// ---------- Shared helpers ----------
var CURRENT_GAME_ID = null; // set on the per-game page
function api(path, opts = {}) {
  return fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong");
    return data;
  });
}

function toast(msg, kind = "ok") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast show " + kind;
  setTimeout(() => (t.className = "toast " + kind), 2600);
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

// ---- Email session (verified via OTP) ----
function getSession() {
  return {
    token: localStorage.getItem("cm_session") || "",
    email: localStorage.getItem("cm_email") || "",
    name: localStorage.getItem("cm_name") || "",
  };
}
function setSession(token, email, name) {
  localStorage.setItem("cm_session", token);
  localStorage.setItem("cm_email", email);
  localStorage.setItem("cm_name", name || "");
}
function clearSession() {
  localStorage.removeItem("cm_session");
  localStorage.removeItem("cm_email");
  localStorage.removeItem("cm_name");
}
function isVerified() {
  return !!getSession().token;
}

// Validate the stored token against the server; clear it if the server says
// it's invalid/expired (e.g. after a restart that rotated SESSION_SECRET).
// Prevents the UI showing "Verified as ..." with a token the server rejects.
async function validateSession() {
  const { token } = getSession();
  if (!token) return false;
  try {
    const r = await api("/api/notifications/status", {
      method: "POST",
      body: JSON.stringify({ sessionToken: token }),
    });
    if (!r.verified) { clearSession(); return false; }
    return true;
  } catch {
    return false; // network/other error: don't wipe session on transient failure
  }
}

// ---------- Realtime (SSE) ----------
let _es = null;
function connectRealtime(handlers) {
  if (_es) _es.close();
  _es = new EventSource("/api/events");
  Object.entries(handlers).forEach(([event, fn]) => {
    _es.addEventListener(event, fn);
  });
  _es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---------- Email verification (OTP) ----------
function renderVerifyBar() {
  const bar = document.getElementById("verifyBar");
  if (!bar) return;
  const s = getSession();
  if (s.token) {
    bar.innerHTML = `<span class="verify-ok">✓ Verified as <strong>${esc(s.name || s.email)}</strong></span>
      <button class="btn small ghost" onclick="signOutVoter()">Sign out</button>`;
  } else {
    bar.innerHTML = `<span style="color:var(--muted)">Verify your Snapdeal email to predict &amp; post.</span>
      <button class="btn small" onclick="openVerify()">Verify Email</button>`;
  }
}

function openVerify() {
  const m = document.getElementById("verifyModal");
  if (m) { m.style.display = "flex"; showEmailStep(); }
}
function closeVerify() {
  const m = document.getElementById("verifyModal");
  if (m) m.style.display = "none";
}

// Styled confirmation dialog — a themed replacement for window.confirm().
// Returns a Promise<boolean>. `message`/`title` are trusted (developer) strings.
function confirmDialog(message, opts = {}) {
  const {
    title = "Please confirm",
    confirmText = "Confirm",
    cancelText = "Cancel",
    danger = true,
  } = opts;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.style.display = "flex";
    overlay.innerHTML =
      '<div class="modal-card confirm-card" role="alertdialog" aria-modal="true">' +
      "<h3>" + title + "</h3>" +
      '<p class="modal-sub">' + message + "</p>" +
      '<div class="confirm-actions">' +
      '<button class="btn ghost small" data-act="cancel">' + cancelText + "</button>" +
      '<button class="btn ' + (danger ? "danger " : "") + 'small" data-act="ok">' + confirmText + "</button>" +
      "</div></div>";
    const done = (val) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
    overlay.querySelector('[data-act="ok"]').addEventListener("click", () => done(true));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}
function showEmailStep() {
  document.getElementById("stepEmail").style.display = "block";
  document.getElementById("stepCode").style.display = "none";
}
function showCodeStep(email) {
  document.getElementById("stepEmail").style.display = "none";
  document.getElementById("stepCode").style.display = "block";
  document.getElementById("codeSentTo").textContent = email;
  const code = document.getElementById("vCode");
  if (code) {
    code.value = "";
    // Auto-submit as soon as a full 6-digit code is typed or pasted.
    code.oninput = () => {
      code.value = code.value.replace(/\D/g, "").slice(0, 6); // digits only
      if (code.value.length === 6) submitOtp();
    };
    setTimeout(() => code.focus(), 60);
  }
}

async function requestOtp() {
  const email = document.getElementById("vEmail").value.trim();
  if (!email) return toast("Enter your email", "err");
  const btn = document.getElementById("reqOtpBtn");
  btn.disabled = true; btn.textContent = "Sending...";
  try {
    const r = await api("/api/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    toast("Code sent to your email", "ok");
    window._pendingEmail = r.email;
    showCodeStep(r.email);
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "Send Code";
  }
}

async function submitOtp() {
  const code = document.getElementById("vCode").value.trim();
  if (!code) return toast("Enter the code", "err");
  try {
    const r = await api("/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email: window._pendingEmail, code }),
    });
    setSession(r.token, r.email, r.name);
    toast("Email verified! You can now predict, post and chat.", "ok");
    closeVerify();
    renderVerifyBar();
    if (document.getElementById("liveMatches") || document.getElementById("matches")) renderMatches(typeof CURRENT_GAME_ID !== "undefined" ? CURRENT_GAME_ID : undefined);
    if (document.getElementById("postForm")) renderPostForm();
    if (document.getElementById("posts")) renderPosts();
    if (document.getElementById("chatComposer")) { renderChatComposer(); renderChat(true); }
    if (document.getElementById("notifyBar")) renderNotifyBar();
  } catch (e) {
    toast(e.message, "err");
  }
}

function signOutVoter() {
  clearSession();
  renderVerifyBar();
  if (document.getElementById("liveMatches") || document.getElementById("matches")) renderMatches(typeof CURRENT_GAME_ID !== "undefined" ? CURRENT_GAME_ID : undefined);
  if (document.getElementById("postForm")) renderPostForm();
    if (document.getElementById("posts")) renderPosts();
  if (document.getElementById("chatComposer")) { renderChatComposer(); renderChat(false); }
    if (document.getElementById("notifyBar")) renderNotifyBar();
  toast("Signed out", "ok");
}

// ---------- Public: matches + betting ----------
let MY_BETS = {};      // matchId -> { outcome, stake, settled, payout }
let MY_BALANCE = null; // current wallet balance (null if unverified)

async function renderMatches(gameId) {
  renderVerifyBar();
  const containers = {
    live: document.getElementById("liveMatches"),
    upcoming: document.getElementById("upcomingMatches"),
    finished: document.getElementById("completedMatches"),
  };
  const legacy = document.getElementById("matches");
  if (!containers.live && !containers.upcoming && !legacy) return;
  try {
    const matchesUrl = gameId ? `/api/matches?gameId=${encodeURIComponent(gameId)}` : "/api/matches";
    const [matches, mineRes] = await Promise.all([
      api(matchesUrl),
      isVerified()
        ? api("/api/my-bids", {
            method: "POST",
            body: JSON.stringify({ sessionToken: getSession().token }),
          }).catch(() => ({ bets: {}, balance: null }))
        : Promise.resolve({ bets: {}, balance: null }),
    ]);
    MY_BETS = mineRes.bets || {};
    MY_BALANCE = mineRes.balance;
    renderWalletBar();

    if (legacy && !containers.live) {
      legacy.innerHTML = matches.length
        ? matches.map((m) => matchCardHTML(m)).join("")
        : '<div class="empty">No matches scheduled yet.</div>';
      return;
    }

    const groups = { live: [], upcoming: [], finished: [] };
    matches.forEach((m) => {
      let s;
      if (m.status === "finished" || m.status === "over") s = "finished";
      else if (m.status === "live") s = "live";
      else s = "upcoming";
      groups[s].push(m);
    });
    setSection("live", containers.live, groups.live, "No matches are live right now.");
    setSection("upcoming", containers.upcoming, groups.upcoming, "No upcoming matches. Check back soon.");
    setSection("finished", containers.finished, groups.finished, "No completed matches yet.");
  } catch (e) {
    if (containers.live) containers.live.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    else if (legacy) legacy.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderWalletBar() {
  const el = document.getElementById("walletBar");
  if (!el) return;
  if (!isVerified()) { el.style.display = "none"; return; }
  el.style.display = "";
  el.innerHTML = `💰 Your balance: <strong>₹${MY_BALANCE == null ? "…" : MY_BALANCE}</strong>`;
}

function setSection(key, container, list, emptyMsg) {
  if (!container) return;
  container.innerHTML = list.length
    ? list.map((m) => matchCardHTML(m)).join("")
    : `<div class="empty">${emptyMsg}</div>`;
  const section = document.getElementById("section-" + key);
  if (section) section.style.display = list.length || key !== "finished" ? "" : "none";
}

function oddsLabel(o) { return o ? `${o.toFixed(2)}×` : "—"; }

// Build one betting outcome row.
function outcomeRow(m, key, label, stakeOnThis, odds, betOpen, myBet, isWinnerOutcome) {
  const mineHere = myBet && myBet.outcome === key;
  const cls = ["bet-opt"];
  if (mineHere) cls.push("mine");
  if (isWinnerOutcome) cls.push("won");
  const click = betOpen && !myBet ? `onclick="openBet('${m.id}','${key}','${esc(label).replace(/'/g,"")}')"` : "";
  const right = isWinnerOutcome
    ? `<span class="bet-tag won-tag">WON</span>`
    : mineHere
    ? `<span class="bet-tag mine-tag">Your bid · ₹${myBet.stake}${myBet.settled ? ` → +₹${myBet.payout}` : ""}</span>`
    : betOpen && !myBet
    ? `<span class="bet-tag">Bid</span>`
    : "";
  return `
    <div class="${cls.join(" ")}" ${click} ${click ? "" : 'style="cursor:default"'}>
      <div class="bet-label">${label}</div>
      <div class="bet-figs">
        <span class="bet-odds">${oddsLabel(odds)}</span>
        <span class="bet-pool">₹${stakeOnThis}</span>
      </div>
      ${right}
    </div>`;
}

function matchCardHTML(m) {
  const betOpen = m.status === "upcoming";
  const isLive = m.status === "live";
  const isOver = m.status === "over";
  const statusBadge = isLive ? `<span class="chip live-chip">🔴 LIVE</span>`
    : isOver ? `<span class="chip over-chip">🏁 GAME OVER</span>` : "";
  const resultBadge = m.isDraw
    ? `<span class="chip win" style="background:#8a8f98;color:#0a0a0a">🤝 Draw · ½–½</span>`
    : m.winner ? `<span class="chip win">🏆 ${esc(m.winner.name)}</span>` : "";
  const myBet = MY_BETS[m.id];
  const total = m.poolTotal || 0;
  const pctA = total ? Math.round((m.pool.A / total) * 100) : 34;
  const pctD = total ? Math.round((m.pool.draw / total) * 100) : 33;
  const pctB = 100 - pctA - pctD;
  const wo = m.result ? (m.isDraw ? "draw" : (m.winner && m.winner.id === m.playerAId ? "A" : "B")) : null;
  const hint = betOpen
    ? (myBet ? `You bid ₹${myBet.stake} on ${myBet.outcome === "draw" ? "Draw" : myBet.outcome === "A" ? esc(m.playerA.name) : esc(m.playerB.name)}` : "Place your bid")
    : isLive ? "🔴 Live — bidding closed"
    : isOver ? "🏁 Game over — awaiting result"
    : "Bidding closed";
  return `
  <div class="match-card ${isLive ? "is-live" : ""} ${isOver ? "is-over" : ""}">
    <div class="match-meta">
      ${statusBadge}
      ${m.time ? `<span class="chip">⏱ ${esc(m.time)}</span>` : ""}
      ${m.day ? `<span class="chip ghost">${esc(m.day)}</span>` : ""}
      ${m.location ? `<span class="chip ghost">📍 ${esc(m.location)}</span>` : ""}
      ${resultBadge}
    </div>
    <div class="matchup">
      <strong>${esc(m.playerA ? m.playerA.name : "?")}</strong>
      <span class="vs-sm">vs</span>
      <strong>${esc(m.playerB ? m.playerB.name : "?")}</strong>
    </div>
    <div class="pool-line">Pool: <strong>₹${total}</strong> · ${m.betCount} bid${m.betCount === 1 ? "" : "s"}</div>
    <div class="bet-opts">
      ${outcomeRow(m, "A", m.playerA ? m.playerA.name : "Player A", m.pool.A, m.odds.A, betOpen, myBet, wo === "A")}
      ${outcomeRow(m, "draw", "🤝 Draw", m.pool.draw, m.odds.draw, betOpen, myBet, wo === "draw")}
      ${outcomeRow(m, "B", m.playerB ? m.playerB.name : "Player B", m.pool.B, m.odds.B, betOpen, myBet, wo === "B")}
    </div>
    <div class="votebar">
      <div class="a" style="width:${pctA}%"></div>
      <div class="d" style="width:${pctD}%"></div>
      <div class="b" style="width:${pctB}%"></div>
    </div>
    <div class="predict-hint">${hint}</div>
  </div>`;
}

// Open the styled bid modal for a chosen outcome.
let _pendingBid = null; // { matchId, outcome, label }
function openBet(matchId, outcome, label) {
  if (!isVerified()) { openVerify(); toast("Verify your Snapdeal email to bid.", "err"); return; }
  _pendingBid = { matchId, outcome, label };
  const modal = document.getElementById("bidModal");
  if (!modal) {
    // Fallback if the modal markup isn't present on the page.
    const raw = prompt(`Bid on ${label} (₹):`, "100");
    if (raw === null) return;
    return placeBet(matchId, outcome, Math.floor(Number(raw)));
  }
  document.getElementById("bidOutcome").textContent = label;
  document.getElementById("bidBalance").textContent = "₹" + MY_BALANCE;
  const input = document.getElementById("bidAmount");
  input.value = "";
  document.getElementById("bidError").textContent = "";
  modal.style.display = "flex";
  setTimeout(() => input.focus(), 50);
}

function closeBid() {
  const m = document.getElementById("bidModal");
  if (m) m.style.display = "none";
  _pendingBid = null;
}

function submitBid() {
  if (!_pendingBid) return;
  const input = document.getElementById("bidAmount");
  const errEl = document.getElementById("bidError");
  const stake = Math.floor(Number(input.value));
  if (!Number.isFinite(stake) || stake < 1) {
    errEl.textContent = "Enter a whole amount of at least ₹1.";
    return;
  }
  if (stake > MY_BALANCE) {
    errEl.textContent = `That's more than your balance (₹${MY_BALANCE}).`;
    return;
  }
  const { matchId, outcome } = _pendingBid;
  closeBid();
  placeBet(matchId, outcome, stake);
}

// Quick-fill chips inside the modal
function setBidAmount(v) {
  const input = document.getElementById("bidAmount");
  if (!input) return;
  input.value = v === "max" ? MY_BALANCE : v;
  document.getElementById("bidError").textContent = "";
  input.focus();
}

async function placeBet(matchId, outcome, stake) {
  try {
    const r = await api(`/api/matches/${matchId}/bid`, {
      method: "POST",
      body: JSON.stringify({ outcome, stake, sessionToken: getSession().token }),
    });
    MY_BALANCE = r.balance;
    dropCoins();
    toast(`Bid placed: ₹${stake}. Balance: ₹${r.balance}`, "ok");
    renderMatches(CURRENT_GAME_ID);
    renderNotifyBar();
  } catch (e) {
    if (/verify your email/i.test(e.message)) { clearSession(); openVerify(); }
    renderMatches(CURRENT_GAME_ID);
    toast(e.message, "err");
  }
}

// ---------- Public: leaderboards ----------
async function renderLeaderboards(gameId) {
  const q = gameId ? `?gameId=${encodeURIComponent(gameId)}` : "";
  try {
    const [winnersBoard, bettors, backed] = await Promise.all([
      api("/api/leaderboard/winners" + q),
      api("/api/leaderboard/bettors" + q),
      api("/api/leaderboard/backed" + q),
    ]);

    // Match winners (chess points: win=1, draw=0.5 each)
    const mwEl = document.getElementById("matchWinners");
    if (mwEl) mwEl.innerHTML = winnersBoard.length
      ? winnersBoard.map((p, i) => {
          const sub = `${p.wins} win${p.wins === 1 ? "" : "s"}` +
            (p.draws ? ` · ${p.draws} draw${p.draws === 1 ? "" : "s"}` : "");
          const pts = Number.isInteger(p.points) ? p.points : p.points.toFixed(1);
          return boardRow(i, p.name, sub, pts, "win", "pt" + (p.points === 1 ? "" : "s"));
        }).join("")
      : '<div class="empty">No match results yet. Winners appear once matches are decided.</div>';

    // Top bettors by net winnings (settled bets)
    const wEl = document.getElementById("winners");
    if (wEl) wEl.innerHTML = bettors.length
      ? bettors.map((p, i) => {
          const sub = `₹${p.balance} balance · staked ₹${p.staked}, won ₹${p.won}`;
          const net = (p.net > 0 ? "+₹" : p.net < 0 ? "-₹" : "₹") + Math.abs(p.net);
          return boardRow(i, p.name, sub, net, p.net >= 0 ? "win" : "", "net");
        }).join("")
      : '<div class="empty">No settled bids yet. Winnings show once matches have results.</div>';

    // Most-backed players (by points staked)
    const pEl = document.getElementById("predictions");
    if (pEl) {
      const players = (backed.players || []);
      let html = players.length
        ? players.map((p, i) => boardRow(i, p.name, p.org, p.staked, "", "₹ backed")).join("")
        : "";
      if (backed.drawStake) {
        html += boardRow(players.length, "🤝 Draw", "points on a draw", backed.drawStake, "", "₹ backed");
      }
      pEl.innerHTML = html || '<div class="empty">No bids placed yet.</div>';
    }

    // Third board (predictors) not used in bidding mode — hide if present.
    const prEl = document.getElementById("predictors");
    if (prEl) prEl.innerHTML = '<div class="empty">Place bids on upcoming matches to climb the winnings board!</div>';
  } catch (e) {
    toast(e.message, "err");
  }
}

function boardRow(i, name, sub, score, scoreCls, unit) {
  const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1);
  return `
    <div class="board-row top-${i + 1}">
      <div class="rank">${medal}</div>
      <div class="who">
        <div class="n">${esc(name)}</div>
        <div class="o">${esc(sub || "")}</div>
      </div>
      <div class="score ${scoreCls}">${score} <span style="font-size:12px;color:var(--muted);font-weight:600">${unit}</span></div>
    </div>`;
}

// ---------- Community posts ----------
function renderPostForm() {
  const el = document.getElementById("postForm");
  if (!el) return;
  if (isVerified()) {
    const s = getSession();
    el.innerHTML = `
      <div class="post-compose">
        <textarea id="postText" maxlength="500" placeholder="Share something with the tournament community..."></textarea>
        <div class="identity-choice">
          <span class="ic-label">Post as:</span>
          <label class="ic-opt"><input type="radio" name="identity" value="name" checked> ${esc(s.name || s.email)}</label>
          <label class="ic-opt"><input type="radio" name="identity" value="anon"> 🕶️ Anonymous</label>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
          <span id="postCount" style="color:var(--muted);font-size:12px">0/500</span>
          <button class="btn small" onclick="submitPost()">Post</button>
        </div>
      </div>`;
    const ta = document.getElementById("postText");
    ta.addEventListener("input", () => {
      document.getElementById("postCount").textContent = ta.value.length + "/500";
    });
  } else {
    el.innerHTML = `
      <div class="post-compose" style="text-align:center">
        <p style="color:var(--muted);margin-bottom:10px">Verify your Snapdeal email to post in the community.</p>
        <button class="btn small" onclick="openVerify()">Verify Email</button>
      </div>`;
  }
}

async function submitPost() {
  const ta = document.getElementById("postText");
  const text = ta.value.trim();
  if (!text) return toast("Write something first", "err");
  const sel = document.querySelector('input[name="identity"]:checked');
  const anonymous = sel ? sel.value === "anon" : false;
  try {
    await api("/api/posts", {
      method: "POST",
      body: JSON.stringify({ text, anonymous, sessionToken: getSession().token }),
    });
    ta.value = "";
    document.getElementById("postCount").textContent = "0/500";
    toast(anonymous ? "Submitted anonymously for approval" : "Submitted for approval", "ok");
    showPendingNotice(anonymous);
  } catch (e) {
    if (/verify your email/i.test(e.message)) { clearSession(); renderPostForm(); openVerify(); }
    toast(e.message, "err");
  }
}

function showPendingNotice(anonymous) {
  const el = document.getElementById("pendingNotice");
  if (!el) return;
  el.innerHTML = `<span>⏳ Your ${anonymous ? "<strong>anonymous</strong> " : ""}post was submitted and is <strong>awaiting admin approval</strong>. It will appear in the feed once approved.</span>`;
  el.style.display = "block";
  clearTimeout(window._pendingTimer);
  window._pendingTimer = setTimeout(() => { el.style.display = "none"; }, 8000);
}

async function renderPosts() {
  const el = document.getElementById("posts");
  if (!el) return;
  try {
    // Fetch posts and (if verified) which ones are mine, so authors see a
    // delete button even on their own anonymous posts.
    const [posts, mineRes] = await Promise.all([
      api("/api/posts"),
      isVerified()
        ? api("/api/posts/mine", {
            method: "POST",
            body: JSON.stringify({ sessionToken: getSession().token }),
          }).catch(() => ({ ids: [] }))
        : Promise.resolve({ ids: [] }),
    ]);
    const mineIds = new Set(mineRes.ids || []);
    const isAdmin = !!adminKey();
    if (!posts.length) {
      el.innerHTML = '<div class="empty">No posts yet. Be the first to say something!</div>';
      return;
    }
    el.innerHTML = posts.map((p) => {
      const avatar = p.anonymous ? "🕶️" : esc((p.author || "?").charAt(0).toUpperCase());
      const canDelete = isAdmin || mineIds.has(p.id);
      return `
      <div class="post">
        <div class="post-head">
          <div class="avatar ${p.anonymous ? "anon" : ""}">${avatar}</div>
          <div>
            <div class="post-author">${esc(p.author)}${mineIds.has(p.id) ? ' <span class="anon-tag">you</span>' : ""}</div>
            <div class="post-time">${timeAgo(p.ts)}</div>
          </div>
          ${canDelete ? `<button class="btn danger" style="margin-left:auto" onclick="delPost('${p.id}')">Delete</button>` : ""}
        </div>
        <div class="post-body">${esc(p.text)}</div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function delPost(postId) {
  if (!(await confirmDialog("This post will be permanently deleted.", {
    title: "Delete post?", confirmText: "Delete",
  }))) return;
  try {
    // Owner-or-admin endpoint: send admin key if present, and the session token.
    await api(`/api/posts/${postId}`, {
      method: "DELETE",
      headers: adminKey() ? adminHeaders() : {},
      body: JSON.stringify({ sessionToken: getSession().token }),
    });
    toast("Post deleted", "ok");
    renderPosts();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- Notifications opt-in (home page) ----------
async function renderNotifyBar() {
  const el = document.getElementById("notifyBar");
  if (!el) return;
  if (!isVerified()) {
    el.innerHTML = `
      <span>🔔 Get an <strong>email</strong> when a match goes live.</span>
      <button class="btn small" onclick="openVerify()">Verify to enable</button>`;
    return;
  }
  let optedIn = false;
  try {
    const r = await api("/api/notifications/status", {
      method: "POST",
      body: JSON.stringify({ sessionToken: getSession().token }),
    });
    optedIn = !!r.optedIn;
  } catch { /* ignore */ }
  el.innerHTML = optedIn
    ? `<span class="notify-on">🔔 Match notifications <strong>ON</strong> — you'll get an email when a match goes live.</span>
       <button class="btn small ghost" onclick="setNotify(false)">Turn off</button>`
    : `<span>🔕 Match notifications are <strong>off</strong>.</span>
       <button class="btn small" onclick="setNotify(true)">Notify me by email</button>`;
}

async function setNotify(optIn) {
  if (!isVerified()) { openVerify(); return; }
  try {
    await api("/api/notifications/set", {
      method: "POST",
      body: JSON.stringify({ optIn, sessionToken: getSession().token }),
    });
    toast(optIn ? "You'll be emailed when matches go live" : "Notifications turned off", "ok");
    renderNotifyBar();
  } catch (e) {
    if (/verify your email/i.test(e.message)) { clearSession(); renderNotifyBar(); openVerify(); }
    toast(e.message, "err");
  }
}

// ---------- SnapGames: home (games grid + live-now + stats) ----------
function gameCardHTML(g) {
  const parts = [];
  if (g.liveCount) parts.push(`<span class="gc-live">🔴 ${g.liveCount} live</span>`);
  if (g.upcomingCount) parts.push(`<span class="gc-tag">${g.upcomingCount} upcoming</span>`);
  if (g.completedCount) parts.push(`<span class="gc-tag">${g.completedCount} done</span>`);
  if (!parts.length) parts.push(`<span class="gc-tag">No matches yet</span>`);
  return `
    <a class="game-card ${g.liveCount ? "has-live" : ""}" href="/game.html?id=${g.id}">
      <div class="game-emoji">${esc(g.emoji || "🎮")}</div>
      <div class="game-name">${esc(g.name)}</div>
      <div class="game-desc">${esc(g.description || "")}</div>
      <div class="game-meta">${parts.join("")}</div>
    </a>`;
}

async function renderStats() {
  const el = document.getElementById("statsBar");
  if (!el) return;
  try {
    const s = await api("/api/stats");
    el.innerHTML = `
      <div class="stat"><div class="stat-n">${s.games}</div><div class="stat-l">Games</div></div>
      <div class="stat"><div class="stat-n">${s.liveMatches}</div><div class="stat-l">Live now</div></div>
      <div class="stat"><div class="stat-n">${s.matches}</div><div class="stat-l">Matches</div></div>
      <div class="stat"><div class="stat-n">${s.bids}</div><div class="stat-l">Bids</div></div>
      <div class="stat"><div class="stat-n">₹${s.pointsWagered}</div><div class="stat-l">Total Bid</div></div>
      <div class="stat"><div class="stat-n">${s.players}</div><div class="stat-l">Players</div></div>`;
  } catch { /* ignore */ }
}

async function renderGamesGrid() {
  const grid = document.getElementById("gamesGrid");
  if (!grid) return;
  try {
    const games = await api("/api/games");
    grid.innerHTML = games.length
      ? games.map(gameCardHTML).join("")
      : '<div class="empty">No games yet. An admin can add games in the Admin panel.</div>';

    // Live-now strip
    const live = games.filter((g) => g.liveCount > 0);
    const liveSection = document.getElementById("section-livenow");
    const liveGrid = document.getElementById("liveNow");
    if (liveGrid) {
      if (live.length) {
        liveGrid.innerHTML = live.map(gameCardHTML).join("");
        if (liveSection) liveSection.style.display = "";
      } else if (liveSection) {
        liveSection.style.display = "none";
      }
    }
  } catch (e) {
    grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- Page bootstrappers ----------
function initHome() {
  renderVerifyBar();
  renderNotifyBar();
  renderStats();
  renderGamesGrid();
  // Validate any stored session against the server; if stale, clear and re-render.
  validateSession().then((ok) => { if (!ok) { renderVerifyBar(); renderNotifyBar(); } });
  connectRealtime({
    games: () => { renderGamesGrid(); renderStats(); },
    matches: () => { renderGamesGrid(); renderStats(); },
    winner: () => { renderGamesGrid(); renderStats(); },
    bets: () => renderStats(),
  });
}

// ---------- Per-game page ----------

function gameIdFromUrl() {
  return new URLSearchParams(location.search).get("id");
}

async function renderGameHeader() {
  const el = document.getElementById("gameHeader");
  if (!el) return;
  try {
    const g = await api("/api/games/" + CURRENT_GAME_ID);
    document.title = `${g.name} — SnapGames`;
    el.innerHTML = `
      <div class="game-emoji big">${esc(g.emoji || "🎮")}</div>
      <div>
        <h2 class="game-title">${esc(g.name)}</h2>
        <p class="game-subtitle">${esc(g.description || "")}</p>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function switchTab(name) {
  ["matches", "standings", "chat"].forEach((t) => {
    const panel = document.getElementById("tab-" + t);
    if (!panel) return;
    if (t === name) {
      panel.style.display = "";
      // restart the fade-in animation each time this tab is shown
      panel.classList.remove("tab-anim");
      void panel.offsetWidth; // force reflow so the animation replays
      panel.classList.add("tab-anim");
    } else {
      panel.style.display = "none";
    }
  });
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  if (name === "standings") renderLeaderboards(CURRENT_GAME_ID);
  if (name === "chat") { renderChatComposer(); renderChat(true); }
}

function initGame() {
  CURRENT_GAME_ID = gameIdFromUrl();
  if (!CURRENT_GAME_ID) { location.href = "/"; return; }
  renderGameHeader();
  renderVerifyBar();
  renderNotifyBar();
  renderMatches(CURRENT_GAME_ID);
  validateSession().then((ok) => {
    if (!ok) { renderVerifyBar(); renderNotifyBar(); renderMatches(CURRENT_GAME_ID); renderChatComposer(); }
  });
  connectRealtime({
    bets: () => { renderMatches(CURRENT_GAME_ID); if (isTabVisible("standings")) renderLeaderboards(CURRENT_GAME_ID); },
    matches: () => renderMatches(CURRENT_GAME_ID),
    winner: () => { renderMatches(CURRENT_GAME_ID); if (isTabVisible("standings")) renderLeaderboards(CURRENT_GAME_ID); },
    chat: (e) => { if (isTabVisible("chat")) renderChat(true); },
    games: () => renderGameHeader(),
  });
}

function isTabVisible(name) {
  const p = document.getElementById("tab-" + name);
  return p && p.style.display !== "none";
}

function initCommunity() {
  renderVerifyBar();
  renderPostForm();
  renderPosts();
  validateSession().then((ok) => { if (!ok) { renderVerifyBar(); renderPostForm(); renderPosts(); } });
  connectRealtime({
    posts: () => renderPosts(),
  });
}

// ---------- Per-game chat ----------
let _chatMineIds = new Set();

function renderChatComposer() {
  const el = document.getElementById("chatComposer");
  if (!el) return;
  if (isVerified()) {
    const s = getSession();
    el.innerHTML = `
      <div class="chat-as">Chatting as <strong>${esc(s.name || s.email)}</strong></div>
      <div class="chat-input-row">
        <input id="chatText" maxlength="500" placeholder="Type a message..." autocomplete="off" />
        <button class="btn small" onclick="sendChat()">Send</button>
      </div>`;
    const input = document.getElementById("chatText");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  } else {
    el.innerHTML = `
      <div style="text-align:center">
        <p style="color:var(--muted);margin-bottom:10px">Verify your Snapdeal email to join the chat.</p>
        <button class="btn small" onclick="openVerify()">Verify Email</button>
      </div>`;
  }
}

async function refreshChatMine() {
  if (!isVerified()) { _chatMineIds = new Set(); return; }
  try {
    const r = await api("/api/chat/mine", {
      method: "POST",
      body: JSON.stringify({ sessionToken: getSession().token }),
    });
    _chatMineIds = new Set(r.ids || []);
  } catch { _chatMineIds = new Set(); }
}

async function renderChat(scroll = true) {
  const el = document.getElementById("chatMessages");
  if (!el) return;
  try {
    await refreshChatMine();
    const msgs = await api("/api/chat" + (CURRENT_GAME_ID ? `?gameId=${encodeURIComponent(CURRENT_GAME_ID)}` : ""));
    const isAdmin = !!adminKey();
    if (!msgs.length) {
      el.innerHTML = '<div class="empty">No messages yet. Say hi! 👋</div>';
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.innerHTML = msgs.map((m) => {
      const mine = _chatMineIds.has(m.id);
      const canDelete = mine || isAdmin;
      return `
      <div class="chat-msg ${mine ? "mine" : ""}">
        <div class="chat-avatar">${esc((m.author || "?").charAt(0).toUpperCase())}</div>
        <div class="chat-bubble">
          <div class="chat-meta"><span class="chat-name">${esc(m.author)}</span><span class="chat-time">${timeAgo(m.ts)}</span></div>
          <div class="chat-body">${esc(m.text)}</div>
        </div>
        ${canDelete ? `<button class="chat-del" title="Delete" onclick="deleteChat('${m.id}')">×</button>` : ""}
      </div>`;
    }).join("");
    if (scroll && nearBottom) el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function sendChat() {
  if (!isVerified()) { openVerify(); return; }
  const input = document.getElementById("chatText");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text, gameId: CURRENT_GAME_ID, sessionToken: getSession().token }),
    });
    const el = document.getElementById("chatMessages");
    await renderChat(true);
    if (el) el.scrollTop = el.scrollHeight;
  } catch (e) {
    if (/verify your email/i.test(e.message)) { clearSession(); renderChatComposer(); openVerify(); }
    toast(e.message, "err");
  }
}

async function deleteChat(msgId) {
  if (!(await confirmDialog("This message will be permanently removed from the chat.", {
    title: "Delete message?", confirmText: "Delete",
  }))) return;
  try {
    // Send both credentials; server allows if owner (session) OR admin (key).
    await api(`/api/chat/${msgId}`, {
      method: "DELETE",
      headers: adminKey() ? adminHeaders() : {},
      body: JSON.stringify({ sessionToken: getSession().token }),
    });
    toast("Message deleted", "ok");
    renderChat(false);
  } catch (e) { toast(e.message, "err"); }
}

function initChat() {
  renderVerifyBar();
  renderChatComposer();
  renderChat(true);
  connectRealtime({
    chat: () => renderChat(true),
  });
}

// ---------- Admin ----------
function adminKey() { return sessionStorage.getItem("cm_admin") || ""; }
function adminHeaders() { return { "x-admin-key": adminKey() }; }

async function initAdmin() {
  if (adminKey()) {
    try {
      await api("/api/admin/verify", {
        method: "POST",
        body: JSON.stringify({ key: adminKey() }),
      });
      showPanel();
      return;
    } catch { sessionStorage.removeItem("cm_admin"); }
  }
  document.getElementById("login").style.display = "block";
  document.getElementById("panel").style.display = "none";
}

async function adminLogin() {
  const key = document.getElementById("adminKey").value.trim();
  try {
    await api("/api/admin/verify", { method: "POST", body: JSON.stringify({ key }) });
    sessionStorage.setItem("cm_admin", key);
    toast("Welcome, Admin", "ok");
    showPanel();
  } catch (e) {
    toast(e.message, "err");
  }
}

function adminLogout() {
  sessionStorage.removeItem("cm_admin");
  initAdmin();
}

function showPanel() {
  document.getElementById("login").style.display = "none";
  document.getElementById("panel").style.display = "block";
  loadAdminData();
  loadModQueue();
  connectRealtime({
    moderation: () => loadModQueue(),
    matches: () => loadAdminData(),
    games: () => loadAdminData(),
    predictions: () => {},
    bets: () => {},
  });
}

// ---- Community moderation queue ----
async function loadModQueue() {
  const el = document.getElementById("modQueue");
  if (!el) return;
  try {
    const pending = await api("/api/admin/posts/pending", { headers: adminHeaders() });
    if (!pending.length) {
      el.innerHTML = '<div class="empty">No posts awaiting approval. 🎉</div>';
      return;
    }
    el.innerHTML = pending.map((p) => {
      const displayAuthor = p.anonymous ? "Anonymous" : esc(p.author);
      const avatar = p.anonymous ? "🕶️" : esc((p.author || "?").charAt(0).toUpperCase());
      const sub = p.anonymous ? "Anonymous post" : esc(p.email);
      return `
      <div class="mod-item">
        <div class="post-head">
          <div class="avatar ${p.anonymous ? "anon" : ""}">${avatar}</div>
          <div>
            <div class="post-author">${displayAuthor}</div>
            <div class="post-time">${sub} · ${timeAgo(p.ts)}</div>
          </div>
          <span class="chip ghost" style="margin-left:auto">Pending</span>
        </div>
        <div class="post-body">${esc(p.text)}</div>
        <div class="mod-actions">
          <button class="btn small" onclick="approvePost('${p.id}')">✓ Approve</button>
          <button class="btn danger" onclick="rejectPost('${p.id}')">✕ Reject</button>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function approvePost(postId) {
  try {
    await api(`/api/admin/posts/${postId}/approve`, { method: "POST", headers: adminHeaders() });
    toast("Post approved — now live", "ok");
    loadModQueue();
  } catch (e) { toast(e.message, "err"); }
}

async function rejectPost(postId) {
  if (!confirm("Reject and discard this post?")) return;
  try {
    await api(`/api/admin/posts/${postId}/reject`, { method: "POST", headers: adminHeaders() });
    toast("Post rejected", "ok");
    loadModQueue();
  } catch (e) { toast(e.message, "err"); }
}

async function loadAdminData() {
  const filterSel = document.getElementById("matchGameFilter");
  const filterGameId = filterSel ? filterSel.value : "";
  const [games, players, matches] = await Promise.all([
    api("/api/games"),
    api("/api/players"),
    api("/api/matches" + (filterGameId ? `?gameId=${encodeURIComponent(filterGameId)}` : "")),
  ]);
  const gameNameById = {};
  games.forEach((g) => (gameNameById[g.id] = `${g.emoji || "🎮"} ${g.name}`));

  // Games list
  const gamesListEl = document.getElementById("gamesList");
  if (gamesListEl) {
    gamesListEl.innerHTML = games.length
      ? games.map((g) => `
          <div class="list-item">
            <div><strong>${esc(g.emoji || "🎮")} ${esc(g.name)}</strong>
              <span style="color:var(--muted)">· ${g.matchCount} match${g.matchCount === 1 ? "" : "es"}${g.liveCount ? " · 🔴 " + g.liveCount + " live" : ""}</span>
              ${g.description ? `<div style="color:var(--muted);font-size:12px">${esc(g.description)}</div>` : ""}
            </div>
            <button class="btn danger" onclick="delGame('${g.id}')">Delete</button>
          </div>`).join("")
      : '<div class="empty">No games yet. Add one above.</div>';
  }

  // Game selectors (add-match + filter)
  const gameOpts = games.map((g) => `<option value="${g.id}">${esc(g.emoji || "🎮")} ${esc(g.name)}</option>`).join("");
  const mGame = document.getElementById("mGame");
  if (mGame) mGame.innerHTML = games.length ? gameOpts : '<option value="">— add a game first —</option>';
  if (filterSel) {
    const cur = filterSel.value;
    filterSel.innerHTML = `<option value="">All games</option>` + gameOpts;
    filterSel.value = cur;
  }

  // Players list
  document.getElementById("playersList").innerHTML = players.length
    ? players.map((p) => `
        <div class="list-item">
          <div><strong>${esc(p.name)}</strong> <span style="color:var(--muted)">· ${esc(p.org || "")}</span></div>
          <button class="btn danger" onclick="delPlayer('${p.id}')">Remove</button>
        </div>`).join("")
    : '<div class="empty">No players yet.</div>';

  const opts = players.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.org || "")})</option>`).join("");
  document.getElementById("mA").innerHTML = opts;
  document.getElementById("mB").innerHTML = opts;

  document.getElementById("adminMatches").innerHTML = matches.length
    ? matches.map((m) => {
        const resultText = m.isDraw ? " · 🤝 Draw (½–½)" : m.winner ? " · 🏆 " + esc(m.winner.name) : "";
        const gameTag = gameNameById[m.gameId] ? `<span class="chip ghost" style="margin:0 0 4px">${esc(gameNameById[m.gameId])}</span>` : "";
        const finished = m.status === "finished";
        const statusControl = finished
          ? `<span class="chip win" style="margin:0">✅ Result set</span>`
          : `<div class="status-toggle">
               <button class="seg ${m.status === "upcoming" ? "on" : ""}" onclick="setStatus('${m.id}','upcoming')">🕒 Upcoming</button>
               <button class="seg ${m.status === "live" ? "on live" : ""}" onclick="setStatus('${m.id}','live')">🔴 Live</button>
               <button class="seg ${m.status === "over" ? "on over" : ""}" onclick="setStatus('${m.id}','over')">🏁 Game Over</button>
             </div>`;
        return `
        <div class="list-item" style="flex-wrap:wrap;gap:10px">
          <div style="flex:1;min-width:200px">
            ${gameTag}
            <div><strong>${esc(m.playerA ? m.playerA.name : "?")}</strong> vs
            <strong>${esc(m.playerB ? m.playerB.name : "?")}</strong></div>
            <div style="color:var(--muted);font-size:12px">${esc(m.time || "")} · ${esc(m.day || "")}${resultText}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            ${statusControl}
            <select id="win_${m.id}">
              <option value="">— set result —</option>
              ${m.playerA ? `<option value="${m.playerA.id}" ${m.result === m.playerA.id ? "selected" : ""}>${esc(m.playerA.name)} wins</option>` : ""}
              ${m.playerB ? `<option value="${m.playerB.id}" ${m.result === m.playerB.id ? "selected" : ""}>${esc(m.playerB.name)} wins</option>` : ""}
              <option value="draw" ${m.result === "draw" ? "selected" : ""}>Draw (½–½)</option>
            </select>
            <button class="btn small" onclick="setWinner('${m.id}')">Save</button>
            <button class="btn danger" onclick="delMatch('${m.id}')">Delete</button>
          </div>
        </div>`;
      }).join("")
    : '<div class="empty">No matches yet.</div>';
}

// ---- Admin: games ----
async function addGame() {
  const name = document.getElementById("gName").value.trim();
  const emoji = document.getElementById("gEmoji").value.trim();
  const description = document.getElementById("gDesc").value.trim();
  if (!name) return toast("Game name is required", "err");
  try {
    await api("/api/admin/games", {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ name, emoji, description }),
    });
    document.getElementById("gName").value = "";
    document.getElementById("gEmoji").value = "";
    document.getElementById("gDesc").value = "";
    toast("Game added", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function delGame(gameId) {
  if (!confirm("Delete this game? All its matches, predictions and chat will be removed.")) return;
  try {
    await api(`/api/admin/games/${gameId}`, { method: "DELETE", headers: adminHeaders() });
    toast("Game deleted", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function setStatus(matchId, status) {
  try {
    await api(`/api/admin/matches/${matchId}/status`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ status }),
    });
    toast(status === "live" ? "Match set to LIVE — notifications sent"
      : status === "over" ? "Match set to Game Over"
      : "Match set to Upcoming", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function addPlayer() {
  const name = document.getElementById("pName").value.trim();
  const org = document.getElementById("pOrg").value.trim();
  if (!name) return toast("Player name is required", "err");
  try {
    await api("/api/admin/players", {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ name, org }),
    });
    document.getElementById("pName").value = "";
    document.getElementById("pOrg").value = "";
    toast("Player added", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function delPlayer(id) {
  if (!confirm("Remove this player? Their matches and predictions will also be removed.")) return;
  try {
    await api(`/api/admin/players/${id}`, { method: "DELETE", headers: adminHeaders() });
    toast("Player removed", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function addMatch() {
  const gameId = document.getElementById("mGame").value;
  const playerAId = document.getElementById("mA").value;
  const playerBId = document.getElementById("mB").value;
  const time = document.getElementById("mTime").value.trim();
  const day = document.getElementById("mDay").value.trim();
  const location = document.getElementById("mLoc").value.trim();
  if (!gameId) return toast("Pick a game (add one first if none)", "err");
  if (playerAId === playerBId) return toast("Pick two different players", "err");
  try {
    await api("/api/admin/matches", {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ gameId, playerAId, playerBId, time, day, location }),
    });
    document.getElementById("mTime").value = "";
    toast("Match added", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

// Bulk upload matches from an .xlsx file.
async function bulkUpload() {
  const input = document.getElementById("bulkFile");
  const resultEl = document.getElementById("bulkResult");
  if (!input || !input.files || !input.files[0]) return toast("Choose an .xlsx file first", "err");
  const fd = new FormData();
  fd.append("file", input.files[0]);
  resultEl.innerHTML = '<div style="color:var(--muted)">Uploading…</div>';
  try {
    // Note: no Content-Type header — the browser sets multipart boundary; admin key via header.
    const r = await fetch("/api/admin/matches/bulk", {
      method: "POST",
      headers: adminHeaders(), // x-admin-key only
      body: fd,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Upload failed");
    const s = data.summary;
    const rowsHtml = data.report.map((row) =>
      `<div class="list-item" style="padding:6px 0">
         <span>Row ${row.row}</span>
         <span style="margin-left:auto;color:${row.ok ? "#3fbf6f" : "var(--red)"}">${row.ok ? "✓ " + esc(row.match) : "✕ " + esc(row.error)}</span>
       </div>`).join("");
    resultEl.innerHTML = `
      <div class="pending-notice" style="display:block">
        Imported <strong>${s.created}</strong> of ${s.rows} rows · skipped ${s.skipped} ·
        games created ${s.gamesCreated} · players created ${s.playersCreated}
      </div>
      ${rowsHtml}`;
    input.value = "";
    toast(`Bulk upload: ${s.created} added, ${s.skipped} skipped`, s.created ? "ok" : "err");
    loadAdminData();
  } catch (e) {
    resultEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    toast(e.message, "err");
  }
}

async function delMatch(id) {
  if (!confirm("Delete this match and its predictions?")) return;
  try {
    await api(`/api/admin/matches/${id}`, { method: "DELETE", headers: adminHeaders() });
    toast("Match deleted", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function setWinner(matchId) {
  const result = document.getElementById("win_" + matchId).value;
  try {
    await api(`/api/admin/matches/${matchId}/winner`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ result }),
    });
    toast(result ? (result === "draw" ? "Draw saved (½–½)" : "Result saved") : "Result cleared", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}
