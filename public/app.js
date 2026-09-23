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

// Stable per-browser voter token so a person votes once per match
function voterToken() {
  let t = localStorage.getItem("cm_voter");
  if (!t) {
    t = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("cm_voter", t);
  }
  return t;
}

// Remember which player the user supported per match (for UI highlight)
function mySupport() {
  try { return JSON.parse(localStorage.getItem("cm_support") || "{}"); }
  catch { return {}; }
}
function setMySupport(matchId, playerId) {
  const s = mySupport();
  s[matchId] = playerId;
  localStorage.setItem("cm_support", JSON.stringify(s));
}

// ---------- Public: matches ----------
async function renderMatches() {
  const el = document.getElementById("matches");
  try {
    const matches = await api("/api/matches");
    const support = mySupport();
    if (!matches.length) {
      el.innerHTML = '<div class="empty">No matches scheduled yet. Check back soon.</div>';
      return;
    }
    el.innerHTML = matches.map((m) => {
      const total = m.votesA + m.votesB;
      const pctA = total ? Math.round((m.votesA / total) * 100) : 50;
      const pctB = 100 - pctA;
      const mine = support[m.id];
      const winnerBadge = m.winner
        ? `<span class="chip win">🏆 Winner: ${esc(m.winner.name)}</span>` : "";
      return `
      <div class="match-card">
        <div class="match-meta">
          ${m.time ? `<span class="chip">⏱ ${esc(m.time)}</span>` : ""}
          ${m.day ? `<span class="chip ghost">${esc(m.day)}</span>` : ""}
          ${m.location ? `<span class="chip ghost">📍 ${esc(m.location)}</span>` : ""}
          ${winnerBadge}
        </div>
        <div class="versus">
          ${playerCell(m, m.playerA, m.votesA, mine, "A")}
          <div class="vs">VS</div>
          ${playerCell(m, m.playerB, m.votesB, mine, "B")}
        </div>
        <div class="votebar">
          <div class="a" style="width:${pctA}%"></div>
          <div class="b" style="width:${pctB}%"></div>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function playerCell(match, player, votes, mine, side) {
  if (!player) return "<div></div>";
  const isSupported = mine === player.id;
  const isWinner = match.winner && match.winner.id === player.id;
  const cls = ["player"];
  if (isSupported) cls.push("supported");
  if (isWinner) cls.push("winner");
  return `
    <div class="${cls.join(" ")}" onclick="support('${match.id}','${player.id}')">
      <div class="pname">${esc(player.name)}</div>
      <div class="porg">${esc(player.org || "")}</div>
      <div class="pvotes">${votes} support${votes === 1 ? "" : "s"}</div>
      ${isWinner ? '<div class="crown">👑 WINNER</div>'
        : `<button class="support-btn">${isSupported ? "✓ Supported" : "Support"}</button>`}
    </div>`;
}

async function support(matchId, playerId) {
  try {
    await api(`/api/matches/${matchId}/support`, {
      method: "POST",
      body: JSON.stringify({ playerId, voterToken: voterToken() }),
    });
    setMySupport(matchId, playerId);
    toast("Your support is counted!", "ok");
    renderMatches();
  } catch (e) {
    if (/already supported/i.test(e.message)) {
      setMySupport(matchId, playerId);
      renderMatches();
    }
    toast(e.message, "err");
  }
}

// ---------- Public: leaderboards ----------
async function renderLeaderboards() {
  try {
    const [winners, support] = await Promise.all([
      api("/api/leaderboard/winners"),
      api("/api/leaderboard/support"),
    ]);

    const wEl = document.getElementById("winners");
    wEl.innerHTML = winners.length
      ? winners.map((p, i) => boardRow(i, p, p.wins, "win", "win" + (p.wins === 1 ? "" : "s")))
          .join("")
      : '<div class="empty">No winners recorded yet.</div>';

    const sEl = document.getElementById("support");
    sEl.innerHTML = support.length
      ? support.map((p, i) => boardRow(i, p, p.support, "", "support" + (p.support === 1 ? "" : "s")))
          .join("")
      : '<div class="empty">No support votes yet.</div>';
  } catch (e) {
    toast(e.message, "err");
  }
}

function boardRow(i, p, score, scoreCls, unit) {
  const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1);
  return `
    <div class="board-row top-${i + 1}">
      <div class="rank">${medal}</div>
      <div class="who">
        <div class="n">${esc(p.name)}</div>
        <div class="o">${esc(p.org || "")}</div>
      </div>
      <div class="score ${scoreCls}">${score} <span style="font-size:12px;color:var(--muted);font-weight:600">${unit}</span></div>
    </div>`;
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
}

let ADMIN_PLAYERS = [];
async function loadAdminData() {
  const [players, matches] = await Promise.all([
    api("/api/players"),
    api("/api/matches"),
  ]);
  ADMIN_PLAYERS = players;

  // players list
  document.getElementById("playersList").innerHTML = players.length
    ? players.map((p) => `
        <div class="list-item">
          <div><strong>${esc(p.name)}</strong> <span style="color:var(--muted)">· ${esc(p.org || "")}</span></div>
          <button class="btn danger" onclick="delPlayer('${p.id}')">Remove</button>
        </div>`).join("")
    : '<div class="empty">No players yet.</div>';

  // match player selects
  const opts = players.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.org || "")})</option>`).join("");
  document.getElementById("mA").innerHTML = opts;
  document.getElementById("mB").innerHTML = opts;

  // manage matches
  document.getElementById("adminMatches").innerHTML = matches.length
    ? matches.map((m) => `
        <div class="list-item" style="flex-wrap:wrap;gap:10px">
          <div style="flex:1;min-width:200px">
            <strong>${esc(m.playerA ? m.playerA.name : "?")}</strong> vs
            <strong>${esc(m.playerB ? m.playerB.name : "?")}</strong>
            <div style="color:var(--muted);font-size:12px">${esc(m.time || "")} · ${esc(m.day || "")}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="win_${m.id}">
              <option value="">— set winner —</option>
              ${m.playerA ? `<option value="${m.playerA.id}" ${m.winnerId === m.playerA.id ? "selected" : ""}>${esc(m.playerA.name)}</option>` : ""}
              ${m.playerB ? `<option value="${m.playerB.id}" ${m.winnerId === m.playerB.id ? "selected" : ""}>${esc(m.playerB.name)}</option>` : ""}
            </select>
            <button class="btn small" onclick="setWinner('${m.id}')">Save</button>
            <button class="btn danger" onclick="delMatch('${m.id}')">Delete</button>
          </div>
        </div>`).join("")
    : '<div class="empty">No matches yet.</div>';
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
  if (!confirm("Remove this player? Their matches and votes will also be removed.")) return;
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
  if (!confirm("Delete this match and its support votes?")) return;
  try {
    await api(`/api/admin/matches/${id}`, { method: "DELETE", headers: adminHeaders() });
    toast("Match deleted", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}

async function setWinner(matchId) {
  const winnerId = document.getElementById("win_" + matchId).value;
  try {
    await api(`/api/admin/matches/${matchId}/winner`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({ winnerId }),
    });
    toast(winnerId ? "Winner saved" : "Winner cleared", "ok");
    loadAdminData();
  } catch (e) { toast(e.message, "err"); }
}
