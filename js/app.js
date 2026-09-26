// ============================================================================
// FantaFanta Patti — pagina PARTECIPANTE
// ============================================================================
import {
  doc, getDoc, onSnapshot, runTransaction, Timestamp, collection,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  db, ROLE_ICON, ROLE_CLASS, ROLE_SHORT, DEFAULT_ROSTER_RULES, DEFAULT_CONFIG,
  slugify, fullName, formatCredits, creditColor, rosterStatus, escapeHtml, ringDisplay,
} from "./common.js";

const $ = (id) => document.getElementById(id);
const LS_KEY = "fantafanta_myTeam";

let config = null;
let rules = DEFAULT_ROSTER_RULES;
let state = null;
let teamsById = new Map();
let currentPlayer = null;
let myTeamId = localStorage.getItem(LS_KEY);
let unsubPlayer = null;
let timerInterval = null;

setConnDot("collegamento…", false);

// ---------------------------------------------------------------------------
// Config lega (live, così se l'admin non ha ancora iniziato lo vediamo subito
// quando lo fa)
// ---------------------------------------------------------------------------
onSnapshot(doc(db, "config", "public"), (snap) => {
  if (!snap.exists()) {
    show("waitingView");
    return;
  }
  config = snap.data();
  rules = config.rosterRules || DEFAULT_ROSTER_RULES;
  $("leagueName").textContent = config.leagueName || DEFAULT_CONFIG.leagueName;
  setConnDot("collegato", true);

  const teamNames = config.teams || [];
  if (myTeamId && teamNames.some((n) => slugify(n) === myTeamId)) {
    startLive();
  } else {
    myTeamId = null;
    renderTeamSelect(teamNames);
    show("selectView");
  }
}, (err) => {
  console.error(err);
  setConnDot("errore di collegamento", false);
});

function renderTeamSelect(teamNames) {
  const wrap = $("teamSelectList");
  wrap.innerHTML = "";
  teamNames.forEach((name) => {
    const b = document.createElement("button");
    b.className = "btn block";
    b.textContent = name;
    b.onclick = () => {
      myTeamId = slugify(name);
      localStorage.setItem(LS_KEY, myTeamId);
      startLive();
    };
    wrap.appendChild(b);
  });
}

$("btnChangeTeam").onclick = () => {
  localStorage.removeItem(LS_KEY);
  location.reload();
};

// ---------------------------------------------------------------------------
// Avvio vista live
// ---------------------------------------------------------------------------
function startLive() {
  show("liveView");
  $("btnChangeTeam").classList.remove("hidden");

  onSnapshot(collection(db, "teams"), (snap) => {
    teamsById = new Map();
    snap.forEach((d) => teamsById.set(d.id, { id: d.id, ...d.data() }));
    renderTeams();
    renderMyTeam();
    renderBidButtons();
  });

  onSnapshot(doc(db, "state", "auction"), (snap) => {
    if (!snap.exists()) return;
    state = snap.data();
    watchCurrentPlayer(state.currentPlayerId);
    renderStage();
    renderTicker();
  });
}

function watchCurrentPlayer(playerId) {
  if (currentPlayer && currentPlayer.id === playerId) return;
  if (unsubPlayer) { unsubPlayer(); unsubPlayer = null; }
  currentPlayer = null;
  if (!playerId) { renderStage(); return; }
  unsubPlayer = onSnapshot(doc(db, "players", playerId), (snap) => {
    currentPlayer = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    renderStage();
    renderBidButtons();
  });
}

// ---------------------------------------------------------------------------
// Render: stage (giocatore corrente)
// ---------------------------------------------------------------------------
function renderStage() {
  if (!state) return;
  $("stageEmpty").classList.toggle("hidden", state.status !== "idle");
  $("stageFinished").classList.toggle("hidden", state.status !== "finished");
  const showPlayer = ["bidding", "sold", "unsold", "paused"].includes(state.status);
  $("stagePlayer").classList.toggle("hidden", !showPlayer);

  if (state.status === "idle") {
    $("progressText").textContent = progressLabel();
  }

  const banner = $("statusBanner");
  if (state.status === "sold") {
    const team = teamsById.get(state.lastSoldTeam);
    banner.textContent = `✅ ${state.lastSoldPlayerName || ""} assegnato a ${team ? team.name : "?"} per ${formatCredits(state.lastSoldPrice)} crediti`;
    banner.className = "status-banner sold";
  } else if (state.status === "unsold") {
    banner.textContent = `↪️ Nessuna offerta: giocatore non assegnato, si passa al prossimo`;
    banner.className = "status-banner unsold";
  } else if (state.status === "idle") {
    banner.textContent = `In attesa che l'admin chiami il prossimo giocatore…`;
    banner.className = "status-banner idle";
  } else if (state.status === "paused") {
    banner.textContent = `⏸ L'admin ha messo in pausa l'asta`;
    banner.className = "status-banner idle";
  }
  const showBanner = ["sold", "unsold", "idle", "paused"].includes(state.status);
  banner.classList.toggle("hidden", !showBanner);

  if (showPlayer && currentPlayer) {
    const badge = $("playerRoleBadge");
    badge.textContent = `${ROLE_ICON[currentPlayer.ruolo] || ""} ${currentPlayer.ruolo}${currentPlayer.ruoloMantra ? " · " + currentPlayer.ruoloMantra : ""}`;
    badge.className = "role-badge " + (ROLE_CLASS[currentPlayer.ruolo] || "");
    $("playerName").textContent = fullName(currentPlayer);
    $("playerMeta").textContent = [currentPlayer.squadra, currentPlayer.quotazione ? `Qt.A ${currentPlayer.quotazione}` : ""].filter(Boolean).join(" · ");
    $("currentBid").textContent = formatCredits(state.currentBid || 0);
    const leadTeam = state.currentBidTeam ? teamsById.get(state.currentBidTeam) : null;
    $("currentBidTeam").textContent = leadTeam ? `al rilancio: ${leadTeam.name}` : "Nessuna offerta ancora";
  }

  restartTimerLoop();
  renderBidButtons();
}

function progressLabel() {
  if (!state) return "";
  const called = state.calledCount || 0;
  const total = state.totalCount || 0;
  return total ? `${called} / ${total} calciatori chiamati` : "";
}

function restartTimerLoop() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 200);
  tickTimer();
}

function tickTimer() {
  const ring = $("timerRing");
  const { label, cls } = ringDisplay(state);
  ring.textContent = label;
  ring.className = "timer-ring " + cls;
}

// ---------------------------------------------------------------------------
// Render: le mie info + pulsanti di rilancio
// ---------------------------------------------------------------------------
function renderMyTeam() {
  const team = teamsById.get(myTeamId);
  if (!team) return;
  $("myTeamName").textContent = team.name;
  const el = $("myTeamCredits");
  el.textContent = formatCredits(team.credits);
  el.style.color = creditColor(team.credits, config?.budget || DEFAULT_CONFIG.budget);
}

function renderBidButtons() {
  const container = $("bidButtons");
  const errorEl = $("bidError");
  const myTeam = teamsById.get(myTeamId);
  if (!state || !myTeam || state.status !== "bidding" || !currentPlayer) {
    container.querySelectorAll("button").forEach((b) => (b.disabled = true));
    return;
  }

  const iAmLeading = state.currentBidTeam === myTeamId;
  const rs = rosterStatus(myTeam, rules);
  const roleFull = rs.roleFull(currentPlayer.ruolo);

  errorEl.textContent = iAmLeading
    ? "Stai già rilanciando tu su questo giocatore."
    : roleFull ? "Attenzione: la tua rosa è già al completo per questo ruolo/totale."
    : "";

  container.querySelectorAll("button[data-delta]").forEach((b) => {
    const delta = Number(b.dataset.delta);
    const newBid = (state.currentBid || 0) + delta;
    b.disabled = iAmLeading || newBid > myTeam.credits;
  });
  $("btnAltro").disabled = iAmLeading;
}

$("bidButtons").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-delta]");
  if (btn && !btn.disabled) placeBid(Number(btn.dataset.delta), true);
});

$("btnAltro").onclick = () => {
  $("altroInput").value = (state.currentBid || 0) + 1;
  $("altroError").textContent = "";
  $("altroModalBackdrop").classList.remove("hidden");
};
$("altroCancel").onclick = () => $("altroModalBackdrop").classList.add("hidden");
$("altroConfirm").onclick = () => {
  const val = Number($("altroInput").value);
  if (!Number.isFinite(val) || val <= (state.currentBid || 0)) {
    $("altroError").textContent = "Inserisci un importo superiore all'offerta attuale.";
    return;
  }
  $("altroModalBackdrop").classList.add("hidden");
  placeBid(val, false);
};

async function placeBid(amount, isDelta) {
  const errorEl = $("bidError");
  errorEl.textContent = "";
  try {
    await runTransaction(db, async (tx) => {
      const stateRef = doc(db, "state", "auction");
      const stateSnap = await tx.get(stateRef);
      const s = stateSnap.data();
      if (s.status !== "bidding") throw new Error("L'asta su questo giocatore si è già chiusa.");
      const newBid = isDelta ? (s.currentBid || 0) + amount : amount;
      if (newBid <= (s.currentBid || 0)) throw new Error("Qualcuno ha già rilanciato più alto: riprova.");

      const teamRef = doc(db, "teams", myTeamId);
      const teamSnap = await tx.get(teamRef);
      const team = teamSnap.data();
      if (!team || team.credits < newBid) throw new Error("Crediti insufficienti per questa offerta.");

      const timerMs = (config?.bidTimerSeconds ?? DEFAULT_CONFIG.bidTimerSeconds) * 1000;
      tx.update(stateRef, {
        currentBid: newBid,
        currentBidTeam: myTeamId,
        timerEndsAt: Timestamp.fromMillis(Date.now() + timerMs),
      });
    });
  } catch (e) {
    errorEl.textContent = e.message || "Rilancio non riuscito, riprova.";
  }
}

// ---------------------------------------------------------------------------
// Render: griglia squadre + modal rosa
// ---------------------------------------------------------------------------
function renderTeams() {
  const grid = $("teamsGrid");
  grid.innerHTML = "";
  const names = [...teamsById.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
  for (const team of names) {
    const rs = rosterStatus(team, rules);
    const div = document.createElement("div");
    div.className = "team-card" +
      (team.id === myTeamId ? " me" : "") +
      (state && state.currentBidTeam === team.id ? " leading" : "");
    div.innerHTML = `
      <div class="t-name">${escapeHtml(team.name)}</div>
      <div class="t-credits" style="color:${creditColor(team.credits, config?.budget || DEFAULT_CONFIG.budget)}">${formatCredits(team.credits)}</div>
      <div class="t-sub">${rs.portieri}/${rules.portiereMin}-${rules.portiereMax} Por · ${rs.totale}/${rules.totaleMin}-${rules.totaleMax} tot</div>
      ${rs.rischioPortieri ? '<div class="t-sub t-warn">⚠ rischio portieri</div>' : ""}
    `;
    div.onclick = () => openRosterModal(team);
    grid.appendChild(div);
  }
  const total = names.length;
  $("progressBadge").textContent = state ? progressLabel() : `${total} squadre`;
}

function openRosterModal(team) {
  $("rosterModalTitle").textContent = `Rosa — ${team.name}`;
  const body = $("rosterModalBody");
  const roster = (team.roster || []).slice().sort((a, b) => a.ruolo.localeCompare(b.ruolo));
  body.innerHTML = roster.length ? "" : '<p class="small">Ancora nessun giocatore acquistato.</p>';
  for (const p of roster) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <span class="rr-role ${ROLE_CLASS[p.ruolo] || ""}">${ROLE_SHORT[p.ruolo] || ""}</span>
      <span class="rr-name">${escapeHtml(fullName(p))}${p.ruoloMantra ? ` <span class="small">(${escapeHtml(p.ruoloMantra)})</span>` : ""}</span>
      <span class="rr-price">${formatCredits(p.price)}</span>
    `;
    body.appendChild(row);
  }
  $("rosterModalBackdrop").classList.remove("hidden");
}
$("rosterModalClose").onclick = () => $("rosterModalBackdrop").classList.add("hidden");
$("rosterModalBackdrop").addEventListener("click", (e) => {
  if (e.target === $("rosterModalBackdrop")) $("rosterModalBackdrop").classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Render: ticker ultime assegnazioni
// ---------------------------------------------------------------------------
function renderTicker() {
  const wrap = $("ticker");
  const log = state?.salesLog || [];
  if (!log.length) { wrap.innerHTML = '<span class="small">Nessuna ancora.</span>'; return; }
  wrap.innerHTML = "";
  for (const entry of log) {
    const line = document.createElement("span");
    line.textContent = `${ROLE_SHORT[entry.ruolo] || ""} ${entry.playerName} → ${entry.teamName} (${formatCredits(entry.price)})`;
    wrap.appendChild(line);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function show(id) {
  ["selectView", "waitingView", "liveView"].forEach((v) => $(v).classList.toggle("hidden", v !== id));
}
function setConnDot(text, ok) {
  const el = $("connDot");
  el.textContent = (ok ? "● " : "○ ") + text;
  el.style.color = ok ? "var(--ok)" : "var(--text-dim)";
}
