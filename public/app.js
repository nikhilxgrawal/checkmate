// ---------- Shared helpers ----------
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

// Remember which player the user predicted per match (for UI highlight)
function myPredictions() {
  try { return JSON.parse(localStorage.getItem("cm_pred") || "{}"); }
  catch { return {}; }
}
function setMyPrediction(matchId, playerId) {
  const s = myPredictions();
  s[matchId] = playerId;
  localStorage.setItem("cm_pred", JSON.stringify(s));
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
function showEmailStep() {
  document.getElementById("stepEmail").style.display = "block";
  document.getElementById("stepCode").style.display = "none";
}
function showCodeStep(email) {
  document.getElementById("stepEmail").style.display = "none";
  document.getElementById("stepCode").style.display = "block";
  document.getElementById("codeSentTo").textContent = email;
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
    if (document.getElementById("liveMatches") || document.getElementById("matches")) renderMatches();
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
  if (document.getElementById("liveMatches") || document.getElementById("matches")) renderMatches();
  if (document.getElementById("postForm")) renderPostForm();
    if (document.getElementById("posts")) renderPosts();
  if (document.getElementById("chatComposer")) { renderChatComposer(); renderChat(false); }
    if (document.getElementById("notifyBar")) renderNotifyBar();
  toast("Signed out", "ok");
}

// ---------- Public: matches + predictions ----------
async function renderMatches() {
  renderVerifyBar();
  const containers = {
    live: document.getElementById("liveMatches"),
    upcoming: document.getElementById("upcomingMatches"),
    finished: document.getElementById("completedMatches"),
  };
  // Fallback: legacy single container
  const legacy = document.getElementById("matches");
  if (!containers.live && !containers.upcoming && !legacy) return;
  try {
    const [matches, serverMine] = await Promise.all([
      api("/api/matches"),
      isVerified()
        ? api("/api/my-predictions", {
            method: "POST",
            body: JSON.stringify({ sessionToken: getSession().token }),
          }).catch(() => ({}))
        : Promise.resolve({}),
    ]);
    const mine = { ...myPredictions(), ...serverMine };
    localStorage.setItem("cm_pred", JSON.stringify(mine));

    // Legacy single-list mode (if the page hasn't been split)
    if (legacy && !containers.live) {
      legacy.innerHTML = matches.length
        ? matches.map((m) => matchCardHTML(m, mine[m.id])).join("")
        : '<div class="empty">No matches scheduled yet. Check back soon.</div>';
      return;
    }

    const groups = { live: [], upcoming: [], finished: [] };
    matches.forEach((m) => {
      let s;
      if (m.status === "finished" || m.status === "over") s = "finished"; // both are "match ended"
      else if (m.status === "live") s = "live";
      else s = "upcoming";
      groups[s].push(m);
    });

    setSection(
      "live",
      containers.live,
      groups.live,
      mine,
      "No matches are live right now."
    );
    setSection(
      "upcoming",
      containers.upcoming,
      groups.upcoming,
      mine,
      "No upcoming matches. Check back soon."
    );
    setSection(
      "finished",
      containers.finished,
      groups.finished,
      mine,
      "No completed matches yet."
    );
  } catch (e) {
    if (containers.live) containers.live.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    else if (legacy) legacy.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function setSection(key, container, list, mine, emptyMsg) {
  if (!container) return;
  container.innerHTML = list.length
    ? list.map((m) => matchCardHTML(m, mine[m.id])).join("")
    : `<div class="empty">${emptyMsg}</div>`;
  // Hide the whole section wrapper (title + grid) for the finished group when empty
  const section = document.getElementById("section-" + key);
  if (section) section.style.display = list.length || key !== "finished" ? "" : "none";
}

function matchCardHTML(m, minePid) {
  const total = m.votesA + m.votesB + (m.votesDraw || 0);
  const pctA = total ? Math.round((m.votesA / total) * 100) : 34;
  const pctD = total ? Math.round(((m.votesDraw || 0) / total) * 100) : 33;
  const pctB = 100 - pctA - pctD;
  // Predictions are open ONLY while the match is Upcoming.
  const predOpen = m.status === "upcoming";
  const closed = !predOpen;
  const isLive = m.status === "live";
  const isOver = m.status === "over";
  const statusBadge = isLive ? `<span class="chip live-chip">🔴 LIVE</span>`
    : isOver ? `<span class="chip over-chip">🏁 GAME OVER</span>`
    : "";
  const resultBadge = m.isDraw
    ? `<span class="chip win" style="background:#8a8f98;color:#0a0a0a">🤝 Draw · ½–½</span>`
    : m.winner
    ? `<span class="chip win">🏆 Winner: ${esc(m.winner.name)}</span>`
    : "";
  const drawMine = minePid === "draw";
  const drawCls = ["draw-pick"];
  if (drawMine) drawCls.push("supported");
  if (m.isDraw) drawCls.push("winner");
  const drawRow = `
    <div class="${drawCls.join(" ")}" ${predOpen ? `onclick="predict('${m.id}','draw')"` : 'style="cursor:default"'}>
      <span class="draw-label">🤝 Draw</span>
      <span class="draw-votes">${m.votesDraw || 0} prediction${(m.votesDraw || 0) === 1 ? "" : "s"}</span>
      ${m.isDraw ? '<span class="draw-tag win-tag">RESULT</span>'
        : !predOpen ? (drawMine ? '<span class="draw-tag">You predicted</span>' : "")
        : `<span class="draw-tag ${drawMine ? "on" : ""}">${drawMine ? "✓ Predicted" : "Predict Draw"}</span>`}
    </div>`;
  const hint = predOpen ? "Predict the winner — or a draw"
    : isLive ? "🔴 Match is live — predictions closed"
    : isOver ? "🏁 Game over — awaiting result"
    : "Predictions closed";
  return `
  <div class="match-card ${isLive ? "is-live" : ""} ${isOver ? "is-over" : ""}">
    <div class="match-meta">
      ${statusBadge}
      ${m.time ? `<span class="chip">⏱ ${esc(m.time)}</span>` : ""}
      ${m.day ? `<span class="chip ghost">${esc(m.day)}</span>` : ""}
      ${m.location ? `<span class="chip ghost">📍 ${esc(m.location)}</span>` : ""}
      ${resultBadge}
    </div>
    <div class="versus">
      ${playerCell(m, m.playerA, m.votesA, minePid, predOpen)}
      <div class="vs">VS</div>
      ${playerCell(m, m.playerB, m.votesB, minePid, predOpen)}
    </div>
    <div class="votebar">
      <div class="a" style="width:${pctA}%"></div>
      <div class="d" style="width:${pctD}%"></div>
      <div class="b" style="width:${pctB}%"></div>
    </div>
    ${drawRow}
    <div class="predict-hint">${hint}</div>
  </div>`;
}

function playerCell(match, player, votes, minePid, predOpen) {
  if (!player) return "<div></div>";
  const isMine = minePid === player.id;
  const isWinner = match.winner && match.winner.id === player.id;
  const cls = ["player"];
  if (isMine) cls.push("supported");
  if (isWinner) cls.push("winner");
  const clickable = predOpen ? `onclick="predict('${match.id}','${player.id}')"` : "";
  return `
    <div class="${cls.join(" ")}" ${clickable} ${predOpen ? "" : 'style="cursor:default"'}>
      <div class="pname">${esc(player.name)}</div>
      <div class="porg">${esc(player.org || "")}</div>
      <div class="pvotes">${votes} prediction${votes === 1 ? "" : "s"}</div>
      ${isWinner ? '<div class="crown">👑 WINNER</div>'
        : !predOpen ? `<div class="crown" style="color:var(--muted)">${isMine ? "✓ You predicted" : ""}</div>`
        : `<button class="support-btn">${isMine ? "✓ Predicted" : "Predict"}</button>`}
    </div>`;
}

async function predict(matchId, playerId) {
  if (!isVerified()) {
    openVerify();
    toast("Verify your Snapdeal email to predict.", "err");
    return;
  }
  try {
    const r = await api(`/api/matches/${matchId}/predict`, {
      method: "POST",
      body: JSON.stringify({ playerId, sessionToken: getSession().token }),
    });
    setMyPrediction(matchId, playerId);
    toast(r && r.autoOptedIn
      ? "Prediction counted! You'll now get an email when matches go live."
      : "Your prediction is counted!", "ok");
    renderMatches();
    renderNotifyBar(); // auto-opt-in may have turned notifications on
  } catch (e) {
    if (/verify your email/i.test(e.message)) { clearSession(); openVerify(); }
    if (/already predicted/i.test(e.message)) {
      setMyPrediction(matchId, playerId);
      toast("You've already made your prediction for this match.", "err");
      renderMatches();
      return;
    }
    // On any other failure, resync UI with server truth.
    renderMatches();
    toast(e.message, "err");
  }
}

// ---------- Public: leaderboards ----------
async function renderLeaderboards() {
  try {
    const [winners, predictions, predictors] = await Promise.all([
      api("/api/leaderboard/winners"),
      api("/api/leaderboard/predictions"),
      api("/api/leaderboard/predictors"),
    ]);

    const wEl = document.getElementById("winners");
    if (wEl) wEl.innerHTML = winners.length
      ? winners.map((p, i) => {
          const sub = `${p.wins} win${p.wins === 1 ? "" : "s"}` +
            (p.draws ? ` · ${p.draws} draw${p.draws === 1 ? "" : "s"}` : "");
          const pts = Number.isInteger(p.points) ? p.points : p.points.toFixed(1);
          return boardRow(i, p.name, sub, pts, "win", "pt" + (p.points === 1 ? "" : "s"));
        }).join("")
      : '<div class="empty">No results recorded yet.</div>';

    const pEl = document.getElementById("predictions");
    if (pEl) pEl.innerHTML = predictions.length && predictions.some(p => p.predictions > 0)
      ? predictions.filter(p => p.predictions > 0).map((p, i) => boardRow(i, p.name, p.org, p.predictions, "", "prediction" + (p.predictions === 1 ? "" : "s"))).join("")
      : '<div class="empty">No predictions yet.</div>';

    const prEl = document.getElementById("predictors");
    if (prEl) prEl.innerHTML = predictors.length
      ? predictors.map((p, i) => boardRow(i, p.name, `${p.correct}/${p.total} correct`, p.accuracy + "%", "win", "accuracy")).join("")
      : '<div class="empty">No settled predictions yet. Accuracy appears once matches have winners.</div>';
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
  if (!confirm("Delete this post?")) return;
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

// ---------- Page bootstrappers ----------
function initHome() {
  renderMatches();
  renderNotifyBar();
  connectRealtime({
    predictions: () => renderMatches(),
    matches: () => renderMatches(),
    winner: () => renderMatches(),
  });
}

function initLeaderboard() {
  renderLeaderboards();
  connectRealtime({
    predictions: () => renderLeaderboards(),
    winner: () => renderLeaderboards(),
    matches: () => renderLeaderboards(),
  });
}

function initCommunity() {
  renderVerifyBar();
  renderPostForm();
  renderPosts();
  connectRealtime({
    posts: () => renderPosts(),
  });
}

// ---------- Global chat ----------
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
    const msgs = await api("/api/chat");
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
      body: JSON.stringify({ text, sessionToken: getSession().token }),
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
  if (!confirm("Delete this message?")) return;
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
    predictions: () => {},
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
  const [players, matches] = await Promise.all([
    api("/api/players"),
    api("/api/matches"),
  ]);

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
            <strong>${esc(m.playerA ? m.playerA.name : "?")}</strong> vs
            <strong>${esc(m.playerB ? m.playerB.name : "?")}</strong>
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
  const playerAId = document.getElementById("mA").value;
  const playerBId = document.getElementById("mB").value;
  const time = document.getElementById("mTime").value.trim();
  const day = document.getElementById("mDay").value.trim();
  const location = document.getElementById("mLoc").value.trim();
  if (playerAId === playerBId) return toast("Pick two different players", "err");
  try {
    await api("/api/admin/matches", {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ playerAId, playerBId, time, day, location }),
    });
    document.getElementById("mTime").value = "";
    toast("Match added", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
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
