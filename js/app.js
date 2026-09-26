// ============================================================================
// FantaFanta Patti — pagina UNICA (partecipante + pannello admin inline)
// ============================================================================
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  runTransaction, Timestamp, collection, writeBatch, increment, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  db, auth, ROLE_ICON, ROLE_CLASS, ROLE_SHORT, ROLE_ORDER,
  DEFAULT_ROSTER_RULES, DEFAULT_CONFIG, slugify, fullName, formatCredits,
  creditColor, rosterStatus, escapeHtml, ringDisplay, parseListoneCsv,
  shuffle, buildLegheFantacalcioCsv, downloadTextFile, armStuckWatchdog,
  setPlayerPhoto, mantraRoles, mantraColorGroup,
} from "./common.js";

const $ = (id) => document.getElementById(id);
const LS_KEY = "fantafanta_myTeam";

const STATUS_LABELS = {
  setup: "da configurare", idle: "in attesa", bidding: "asta aperta",
  sold: "assegnato", unsold: "nessuna offerta", paused: "in pausa", finished: "terminata",
};

// ---------------------------------------------------------------------------
// Stato condiviso
// ---------------------------------------------------------------------------
let config = null;
let rules = DEFAULT_ROSTER_RULES;
let state = null;
let teamsById = new Map();
let playersById = new Map(); // popolata solo quando si è admin (per la ricerca manuale)
let currentPlayer = null;
let lastPhotoPlayerId = null; // evita di ricaricare la <img> ad ogni singolo rilancio
let myTeamId = localStorage.getItem(LS_KEY);
let unsubPlayer = null;
let unsubPlayers = null;

let isAdminUser = false;
let adminSubscribed = false;
let coreSubscribed = false;
let setupPrefilled = false;
let parsedCsvPlayers = null;
let selectedManualPlayerId = null;
let autoFinalizing = false;

setConnDot("collegamento…", false);

let configResolved = false;
armStuckWatchdog(() => configResolved);

// ---------------------------------------------------------------------------
// Config lega (live: appena l'admin inizializza, tutti lo vedono subito)
// ---------------------------------------------------------------------------
onSnapshot(doc(db, "config", "public"), (snap) => {
  configResolved = true;
  if (!snap.exists()) {
    config = null;
    show("waitingView");
    renderTeamsAdmin();
    return;
  }
  config = snap.data();
  rules = config.rosterRules || DEFAULT_ROSTER_RULES;
  $("leagueName").textContent = config.leagueName || DEFAULT_CONFIG.leagueName;
  setConnDot("collegato", true);
  maybePrefillSetup();

  const teamNames = config.teams || [];
  if (myTeamId && teamNames.some((n) => slugify(n) === myTeamId)) {
    startLive();
  } else if (!myTeamId) {
    renderTeamSelect(teamNames);
    show("selectView");
  } else {
    myTeamId = null;
    renderTeamSelect(teamNames);
    show("selectView");
  }
  renderTeamsAdmin();
  populateManualTeamSelect();
  renderControl();
}, (err) => {
  configResolved = true;
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

function startLive() {
  show("liveView");
  $("btnChangeTeam").classList.remove("hidden");
  ensureCoreSubscriptions();
  // Se le sottoscrizioni erano già attive (caso admin: già collegato prima di
  // scegliere la squadra) nessun nuovo evento Firestore arriverà da solo per
  // aggiornare "la mia squadra": disegniamo subito con i dati già in cache.
  renderMyTeam();
  renderBidButtons();
  renderTeams();
}

// ---------------------------------------------------------------------------
// Sottoscrizioni "core" (squadre + stato asta): attive per chiunque abbia
// scelto una squadra OPPURE sia loggato come admin, non solo per i partecipanti.
// ---------------------------------------------------------------------------
function ensureCoreSubscriptions() {
  if (coreSubscribed) return;
  coreSubscribed = true;

  onSnapshot(collection(db, "teams"), (snap) => {
    teamsById = new Map();
    snap.forEach((d) => teamsById.set(d.id, { id: d.id, ...d.data() }));
    renderTeams();
    renderMyTeam();
    renderBidButtons();
    renderTeamsAdmin();
    populateManualTeamSelect();
    renderControl();
  });

  onSnapshot(doc(db, "state", "auction"), (snap) => {
    if (!snap.exists()) return;
    state = snap.data();
    watchCurrentPlayer(state.currentPlayerId);
    renderStage();
    renderTicker();
    renderControl();
  });
}

function watchCurrentPlayer(playerId) {
  if (currentPlayer && currentPlayer.id === playerId) return;
  if (unsubPlayer) { unsubPlayer(); unsubPlayer = null; }
  currentPlayer = null;
  if (!playerId) { renderStage(); renderControl(); return; }
  unsubPlayer = onSnapshot(doc(db, "players", playerId), (snap) => {
    currentPlayer = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    renderStage();
    renderBidButtons();
    renderControl();
  });
}

// ---------------------------------------------------------------------------
// Login / logout admin (finestra in alto a destra, nessuna pagina separata)
// ---------------------------------------------------------------------------
$("btnShowAdminLogin").onclick = () => $("adminLoginBackdrop").classList.remove("hidden");
$("adminLoginClose").onclick = () => $("adminLoginBackdrop").classList.add("hidden");
$("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnSignIn").click(); });
$("btnSignIn").onclick = async () => {
  $("loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPass").value);
  } catch (e) {
    $("loginError").textContent = "Accesso non riuscito: controlla email e password.";
  }
};
$("btnSignOut").onclick = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  isAdminUser = !!user;
  ensureCoreSubscriptions(); // l'admin deve poter controllare l'asta anche prima di scegliere una squadra

  if (user) {
    $("adminLoginBackdrop").classList.add("hidden");
    $("loginEmail").value = ""; $("loginPass").value = ""; $("loginError").textContent = "";
    $("btnShowAdminLogin").classList.add("hidden");
    $("adminWho").textContent = "⚙️ " + user.email;
    $("adminWho").classList.remove("hidden");
    $("btnSignOut").classList.remove("hidden");
    $("adminBar").classList.remove("hidden");
    if (!adminSubscribed) {
      adminSubscribed = true;
      unsubPlayers = onSnapshot(collection(db, "players"), (snap) => {
        playersById = new Map();
        snap.forEach((d) => playersById.set(d.id, { id: d.id, ...d.data() }));
        renderManualSearchResults();
      });
    }
  } else {
    $("btnShowAdminLogin").classList.remove("hidden");
    $("adminWho").classList.add("hidden");
    $("btnSignOut").classList.add("hidden");
    $("adminBar").classList.add("hidden");
    $("adminAdvanced").classList.add("hidden");
    $("btnToggleAdvanced").textContent = "⚙️ Impostazioni, correzioni ed esportazione ▾";
    if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }
    adminSubscribed = false;
    playersById = new Map();
  }
  renderTeamsAdmin();
  renderControl();
});

$("btnToggleAdvanced").onclick = () => {
  const el = $("adminAdvanced");
  const willShow = el.classList.contains("hidden");
  el.classList.toggle("hidden");
  $("btnToggleAdvanced").textContent = willShow
    ? "⚙️ Impostazioni, correzioni ed esportazione ▴"
    : "⚙️ Impostazioni, correzioni ed esportazione ▾";
};

// ---------------------------------------------------------------------------
// Render: stage (giocatore corrente) — condiviso da tutti, admin compreso
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
    // Un badge colorato per ciascuna sigla Mantra del calciatore (es. un
    // centrocampista/trequartista mostra un chip C blu E un chip T viola
    // affiancati), non un colore unico per il macro-ruolo.
    const sigle = mantraRoles(currentPlayer);
    badge.innerHTML = sigle.map((s) => {
      const g = mantraColorGroup(s);
      return `<span class="role-badge-chip ${g}">${escapeHtml(s)}</span>`;
    }).join("") + `<span class="role-badge-label">${escapeHtml(currentPlayer.ruolo)}</span>`;
    const photo = $("playerPhoto");
    photo.className = "player-photo " + (ROLE_CLASS[currentPlayer.ruolo] || "");
    if (lastPhotoPlayerId !== currentPlayer.id) {
      lastPhotoPlayerId = currentPlayer.id;
      setPlayerPhoto(photo, currentPlayer);
    }
    $("playerName").textContent = fullName(currentPlayer);
    $("playerMeta").textContent = [currentPlayer.squadra, currentPlayer.quotazione ? `Qt.A ${currentPlayer.quotazione}` : ""].filter(Boolean).join(" · ");
    $("currentBid").textContent = formatCredits(state.currentBid || 0);
    const leadTeam = state.currentBidTeam ? teamsById.get(state.currentBidTeam) : null;
    $("currentBidTeam").textContent = leadTeam ? `al rilancio: ${leadTeam.name}` : "Nessuna offerta ancora";
  }
}

function progressLabel() {
  if (!state) return "";
  const called = state.calledCount || 0;
  const total = state.totalCount || 0;
  return total ? `${called} / ${total} calciatori chiamati` : "";
}

function tickTimer() {
  const ring = $("timerRing");
  const { label, cls } = ringDisplay(state);
  ring.textContent = label;
  ring.className = "timer-ring " + cls;
}

// Un solo intervallo per: aggiornare il conto alla rovescia a schermo e,
// se si è admin, controllare se il timer è scaduto e va assegnato il giocatore.
setInterval(() => {
  tickTimer();
  if (isAdminUser) maybeAutoFinalize();
}, 250);

// ---------------------------------------------------------------------------
// Render: le mie info + pulsanti di rilancio
// ---------------------------------------------------------------------------
function renderMyTeam() {
  // La card "La tua squadra / Crediti residui" è stata rimossa dalla vista
  // live su richiesta: i crediti di TUTTE le squadre (compresa la propria)
  // si vedono ora nel riepilogo compatto accanto allo stage
  // (renderCreditsSummary) e nella griglia "Squadre" più sotto.
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
  const budget = config?.budget || DEFAULT_CONFIG.budget;
  for (const team of names) {
    const rs = rosterStatus(team, rules);
    const col = document.createElement("div");
    col.className = "team-col" +
      (team.id === myTeamId ? " me" : "") +
      (state && state.currentBidTeam === team.id ? " leading" : "");
    // Ordine SEMPRE per macro-ruolo base (P poi D poi C poi A), indipendente
    // dall'ordine in cui i giocatori sono stati acquistati: un centrocampista
    // comprato dopo un attaccante va comunque visualizzato prima di lui.
    const roster = (team.roster || []).slice().sort((a, b) => {
      const byRole = ROLE_ORDER.indexOf(a.ruolo) - ROLE_ORDER.indexOf(b.ruolo);
      if (byRole !== 0) return byRole;
      return fullName(a).localeCompare(fullName(b), "it");
    });
    const rows = roster.map((p) => {
      // Un calciatore con più ruoli Mantra (es. "C;T" o "W;A") mostra un
      // badge colorato per ciascuna sigla, in ordine canonico (es. prima il
      // centrocampista C, poi il trequartista T) — come nello screenshot
      // FantaLab. Lo sfondo della riga segue il PRIMO ruolo.
      const sigle = mantraRoles(p);
      const grpPrincipale = mantraColorGroup(sigle[0]);
      const badges = sigle.map((s) => {
        const g = mantraColorGroup(s);
        return `<span class="tp-role ${g}">${escapeHtml(s)}</span>`;
      }).join("");
      return `<div class="tp-row ${grpPrincipale}" title="${escapeHtml(fullName(p))} (${formatCredits(p.price)})">
        <span class="tp-roles">${badges}</span>
        <span class="tp-name">${escapeHtml(fullName(p))}</span>
      </div>`;
    }).join("");
    col.innerHTML = `
      <div class="t-head">
        <span class="t-name">${escapeHtml(team.name)}</span>
      </div>
      <div class="tp-list">${rows}</div>
      <div class="t-foot">
        <span class="t-foot-chip mp" title="Portieri acquistati">🧤 ${rs.portieri}</span>
        <span class="t-foot-chip mov" title="Giocatori di movimento acquistati">⚙️ ${rs.movimento}</span>
        <span class="t-foot-budget" style="color:${creditColor(team.credits, budget)}" title="Crediti residui">${formatCredits(team.credits)}</span>
        <span class="t-foot-max" title="Massimo spendibile su un giocatore restando in regola">MAX ${formatCredits(rs.maxSpendibile)}</span>
      </div>
      ${rs.rischioPortieri ? '<div class="t-sub t-warn">⚠ rischio portieri</div>' : ""}
    `;
    col.onclick = () => openRosterModal(team);
    grid.appendChild(col);
  }
  const total = names.length;
  $("progressBadge").textContent = state ? progressLabel() : `${total} squadre`;
  renderCreditsSummary(names, budget);
}

/** Riepilogo compatto dei crediti di TUTTE le squadre, mostrato accanto allo
 * stage del calciatore in asta (sostituisce la vecchia card "La tua squadra
 * / Crediti residui", che mostrava solo i propri). Ordinato per crediti
 * residui decrescenti, così si vede subito chi può ancora spendere di più. */
function renderCreditsSummary(names, budget) {
  const list = $("creditsSummaryList");
  if (!list) return;
  const sorted = names.slice().sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0));
  list.innerHTML = sorted.map((team) => {
    const isMe = team.id === myTeamId;
    const isLeading = state && state.currentBidTeam === team.id;
    return `<div class="cs-row${isMe ? " me" : ""}${isLeading ? " leading" : ""}">
      <span class="cs-name">${escapeHtml(team.name)}</span>
      <span class="cs-credits" style="color:${creditColor(team.credits, budget)}">${formatCredits(team.credits)}</span>
    </div>`;
  }).join("");
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

function renderTicker() {
  // Sezione "Ultime assegnazioni" rimossa dalla vista live su richiesta.
  // Funzione lasciata come no-op innocuo per non dover toccare i punti che
  // la richiamano dopo ogni cambiamento di stato.
}

// ============================================================================
// DA QUI IN GIÙ: logica ADMIN (visibile e attiva solo per chi è loggato,
// ma le funzioni restano definite per tutti — le regole di sicurezza lato
// server impediscono comunque scritture non autorizzate).
// ============================================================================

function maybePrefillSetup() {
  if (setupPrefilled || !config) return;
  setupPrefilled = true;
  $("teamsTextarea").value = (config.teams || []).join("\n");
  $("budgetInput").value = config.budget ?? DEFAULT_CONFIG.budget;
  $("openTimerInput").value = config.openTimerSeconds ?? DEFAULT_CONFIG.openTimerSeconds;
  $("bidTimerInput").value = config.bidTimerSeconds ?? DEFAULT_CONFIG.bidTimerSeconds;
  $("pMinInput").value = rules.portiereMin;
  $("pMaxInput").value = rules.portiereMax;
  $("totMinInput").value = rules.totaleMin;
  $("totMaxInput").value = rules.totaleMax;
}

$("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { players, errors, excluded } = parseListoneCsv(text);
  if (errors.length) {
    $("csvSummary").textContent = "⚠ " + errors.join(" ");
    parsedCsvPlayers = null;
    return;
  }
  parsedCsvPlayers = players;
  const counts = {};
  players.forEach((p) => { counts[p.ruolo] = (counts[p.ruolo] || 0) + 1; });
  let summary = `${players.length} calciatori caricati (` +
    ROLE_ORDER.map((r) => `${r.slice(0, 3)}: ${counts[r] || 0}`).join(", ") + ")";
  if (excluded > 0) summary += ` — ${excluded} "fuori lista" esclusi automaticamente.`;
  $("csvSummary").textContent = summary;
});

function readRulesFromForm() {
  return {
    portiereMin: Number($("pMinInput").value) || 3,
    portiereMax: Number($("pMaxInput").value) || 5,
    totaleMin: Number($("totMinInput").value) || 26,
    totaleMax: Number($("totMaxInput").value) || 34,
  };
}
function validateRules(r) {
  if (r.portiereMin > r.portiereMax) return "Portieri: il minimo non può superare il massimo.";
  if (r.totaleMin > r.totaleMax) return "Rosa totale: il minimo non può superare il massimo.";
  if (r.portiereMax > r.totaleMax) return "Il massimo portieri non può superare il massimo rosa totale.";
  return null;
}

$("btnInit").onclick = async () => {
  $("setupError").textContent = "";
  if (!parsedCsvPlayers || !parsedCsvPlayers.length) {
    $("setupError").textContent = "Carica prima un listone CSV valido.";
    return;
  }
  const teamNames = $("teamsTextarea").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (teamNames.length < 2) { $("setupError").textContent = "Inserisci almeno 2 squadre."; return; }
  const slugs = teamNames.map(slugify);
  if (new Set(slugs).size !== teamNames.length) {
    $("setupError").textContent = "Due squadre hanno nomi troppo simili tra loro: rendili più diversi.";
    return;
  }

  const budget = Number($("budgetInput").value) || DEFAULT_CONFIG.budget;
  const openTimerSeconds = Number($("openTimerInput").value) || DEFAULT_CONFIG.openTimerSeconds;
  const bidTimerSeconds = Number($("bidTimerInput").value) || DEFAULT_CONFIG.bidTimerSeconds;
  const rulesNew = readRulesFromForm();
  const rulesError = validateRules(rulesNew);
  if (rulesError) { $("setupError").textContent = rulesError; return; }

  const ok = confirm(
    `Sicuro di voler (re)inizializzare l'asta con ${parsedCsvPlayers.length} calciatori e ${teamNames.length} squadre?\n\n` +
    `QUALSIASI rosa o credito già presente verrà azzerato definitivamente.`
  );
  if (!ok) return;

  $("btnInit").disabled = true;
  $("setupStatus").textContent = "Inizializzazione in corso, un momento…";
  try {
    await wipeCollections(["players", "teams"]);

    const ids = parsedCsvPlayers.map((_, i) => "p" + String(i + 1).padStart(4, "0"));
    const drawOrder = shuffle(ids);

    const ops = [];
    parsedCsvPlayers.forEach((p, i) => ops.push({ ref: doc(db, "players", ids[i]), data: p }));
    teamNames.forEach((name) => ops.push({ ref: doc(db, "teams", slugify(name)), data: { name, credits: budget, roster: [] } }));
    await commitInChunks(ops);

    await setDoc(doc(db, "config", "public"), {
      leagueName: "FantaFanta Patti",
      teams: teamNames,
      budget,
      rosterRules: rulesNew,
      bidTimerSeconds,
      openTimerSeconds,
      increments: [1, 5, 10],
      drawOrder,
    });

    await setDoc(doc(db, "state", "auction"), {
      status: "idle",
      currentPlayerId: null,
      currentBid: 0,
      currentBidTeam: null,
      timerEndsAt: null,
      nextIndex: 0,
      calledCount: 0,
      totalCount: ids.length,
      lastSoldPlayerId: null,
      lastSoldTeam: null,
      lastSoldPrice: null,
      lastSoldPlayerName: null,
      salesLog: [],
    });

    $("setupStatus").textContent = `✅ Asta inizializzata: ${ids.length} calciatori, ${teamNames.length} squadre, ${budget} crediti a testa. Ora scegli anche tu la tua squadra qui sotto.`;
  } catch (e) {
    console.error(e);
    $("setupError").textContent = "Errore durante l'inizializzazione: " + e.message;
  } finally {
    $("btnInit").disabled = false;
  }
};

$("btnQuickUpdate").onclick = async () => {
  $("setupError").textContent = "";
  if (!config) { $("setupError").textContent = "Inizializza prima l'asta almeno una volta."; return; }
  const rulesNew = readRulesFromForm();
  const rulesError = validateRules(rulesNew);
  if (rulesError) { $("setupError").textContent = rulesError; return; }
  const openTimerSeconds = Number($("openTimerInput").value) || DEFAULT_CONFIG.openTimerSeconds;
  const bidTimerSeconds = Number($("bidTimerInput").value) || DEFAULT_CONFIG.bidTimerSeconds;
  try {
    await updateDoc(doc(db, "config", "public"), { rosterRules: rulesNew, openTimerSeconds, bidTimerSeconds });
    $("setupStatus").textContent = "✅ Timer e regole rosa aggiornati (rose e crediti non toccati).";
  } catch (e) {
    $("setupError").textContent = "Errore: " + e.message;
  }
};

$("btnWipe").onclick = async () => {
  if (!confirm("Cancellare DEFINITIVAMENTE listone, squadre e stato dell'asta? Questa azione non si può annullare.")) return;
  if (!confirm("Sei sicuro? Tutte le rose e i crediti verranno persi per sempre.")) return;
  await wipeCollections(["players", "teams"]);
  await deleteDoc(doc(db, "config", "public")).catch(() => {});
  await deleteDoc(doc(db, "state", "auction")).catch(() => {});
  setupPrefilled = false;
  alert("Dati cancellati. Configura una nuova asta dal pannello impostazioni.");
};

async function commitInChunks(ops, chunkSize = 400) {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + chunkSize)) batch.set(op.ref, op.data);
    await batch.commit();
  }
}
async function wipeCollections(names) {
  for (const name of names) {
    const snap = await getDocs(collection(db, name));
    const refs = snap.docs.map((d) => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
      await batch.commit();
    }
  }
}

// ---------------------------------------------------------------------------
// Controllo live (Prossimo / Assegna / Pausa / Nessuna offerta / Annulla)
// ---------------------------------------------------------------------------
$("btnNext").onclick = async () => {
  if (!config || !state) return;
  $("btnNext").disabled = true;
  try {
    const drawOrder = config.drawOrder || [];
    let idx = state.nextIndex || 0;
    let foundId = null;
    while (idx < drawOrder.length) {
      const pid = drawOrder[idx];
      const p = playersById.get(pid);
      if (p && p.status === "available") { foundId = pid; break; }
      idx++;
    }
    if (!foundId) {
      await updateDoc(doc(db, "state", "auction"), { status: "finished", currentPlayerId: null, nextIndex: idx });
      return;
    }
    const timerMs = (config.openTimerSeconds ?? DEFAULT_CONFIG.openTimerSeconds) * 1000;
    await updateDoc(doc(db, "state", "auction"), {
      status: "bidding",
      currentPlayerId: foundId,
      currentBid: 0,
      currentBidTeam: null,
      timerEndsAt: Timestamp.fromMillis(Date.now() + timerMs),
      nextIndex: idx + 1,
      calledCount: (state.calledCount || 0) + 1,
    });
    await updateDoc(doc(db, "players", foundId), { status: "called" });
  } catch (e) {
    console.error(e);
    alert("Errore: " + e.message);
  } finally {
    $("btnNext").disabled = false;
  }
};

$("btnAssignNow").onclick = async () => {
  if (!state || state.status !== "bidding") return;
  if (!state.currentBidTeam) {
    alert("Nessuna offerta ancora: usa 'Nessuna offerta' per saltare il giocatore, oppure attendi un rilancio.");
    return;
  }
  await finalizeSale();
};

$("btnMarkUnsold").onclick = async () => {
  if (!state || state.status !== "bidding") return;
  if (state.currentBidTeam) {
    if (!confirm("C'è già un'offerta in corso: segnare comunque come non assegnato?")) return;
  }
  await markUnsold();
};

$("btnPause").onclick = async () => {
  if (!state) return;
  if (state.status === "bidding") {
    const remaining = Math.max(0, timerEndsAtMs() - Date.now());
    await updateDoc(doc(db, "state", "auction"), { status: "paused", pausedFrom: "bidding", pausedRemainingMs: remaining });
  } else if (state.status === "paused") {
    const remaining = state.pausedRemainingMs || 0;
    await updateDoc(doc(db, "state", "auction"), {
      status: state.pausedFrom || "bidding",
      timerEndsAt: Timestamp.fromMillis(Date.now() + remaining),
    });
  }
};

$("btnUndo").onclick = async () => {
  if (!state || !state.lastSoldPlayerId) { alert("Non c'è nulla da annullare."); return; }
  const teamName = teamsById.get(state.lastSoldTeam)?.name || state.lastSoldTeam;
  if (!confirm(`Annullare l'assegnazione di ${state.lastSoldPlayerName} a ${teamName}?`)) return;
  try {
    await unassignPlayer(state.lastSoldPlayerId);
    const idx = (config?.drawOrder || []).indexOf(state.lastSoldPlayerId);
    await updateDoc(doc(db, "state", "auction"), {
      status: "idle",
      currentPlayerId: null,
      currentBid: 0,
      currentBidTeam: null,
      timerEndsAt: null,
      lastSoldPlayerId: null,
      lastSoldTeam: null,
      lastSoldPrice: null,
      lastSoldPlayerName: null,
      nextIndex: idx >= 0 ? idx : state.nextIndex,
      calledCount: Math.max(0, (state.calledCount || 0) - 1),
      salesLog: (state.salesLog || []).slice(1),
    });
  } catch (e) {
    alert("Errore durante l'annullamento: " + e.message);
  }
};

// "Annulla chiamata": il giocatore attualmente in asta (ancora indeciso, non
// assegnato) torna disponibile e si ripresenterà in seguito, come se non
// fosse mai stato chiamato. Diverso da "Annulla ultima assegnazione", che
// invece disfa una vendita già conclusa.
$("btnCancelCall").onclick = async () => {
  if (!state || !state.currentPlayerId) { alert("Nessun giocatore in asta al momento."); return; }
  if (!["bidding", "paused"].includes(state.status)) return;
  if (state.currentBidTeam) {
    if (!confirm("C'è già un'offerta in corso su questo giocatore: annullare comunque la chiamata? Il giocatore tornerà disponibile e si potrà richiamare più avanti.")) return;
  }
  await cancelCall();
};

// "Rilancio manuale": l'admin registra un'offerta fatta a voce da chi è al
// tavolo, per conto di una squadra (utile per chi non usa un proprio
// dispositivo durante l'asta dal vivo).
$("btnManualBid").onclick = () => {
  if (!state || state.status !== "bidding") { alert("Nessuna asta aperta in questo momento."); return; }
  populateManualBidTeamSelect();
  $("manualBidAmount").value = (state.currentBid || 0) + 1;
  $("manualBidError").textContent = "";
  $("manualBidModalBackdrop").classList.remove("hidden");
};
$("manualBidCancel").onclick = () => $("manualBidModalBackdrop").classList.add("hidden");
$("manualBidConfirm").onclick = async () => {
  const teamId = $("manualBidTeamSelect").value;
  const amount = Number($("manualBidAmount").value);
  $("manualBidError").textContent = "";
  if (!teamId) { $("manualBidError").textContent = "Seleziona una squadra."; return; }
  if (!Number.isFinite(amount) || amount <= 0) { $("manualBidError").textContent = "Inserisci un importo valido."; return; }
  try {
    await adminManualBid(teamId, amount);
    $("manualBidModalBackdrop").classList.add("hidden");
  } catch (e) {
    $("manualBidError").textContent = e.message || "Rilancio non riuscito.";
  }
};
function populateManualBidTeamSelect() {
  const sel = $("manualBidTeamSelect");
  sel.innerHTML = [...teamsById.values()].sort((a, b) => a.name.localeCompare(b.name, "it"))
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${formatCredits(t.credits)} crediti)</option>`).join("");
}

function timerEndsAtMs() {
  if (!state?.timerEndsAt) return Date.now();
  return state.timerEndsAt.toMillis ? state.timerEndsAt.toMillis() : state.timerEndsAt;
}

async function finalizeSale() {
  if (!state || state.status !== "bidding" || !state.currentPlayerId) return;
  if (!state.currentBidTeam) { await markUnsold(); return; }
  const playerId = state.currentPlayerId;
  const teamId = state.currentBidTeam;
  const price = state.currentBid;
  const player = playersById.get(playerId) || currentPlayer;
  if (!player) return;
  const teamName = teamsById.get(teamId)?.name || teamId;

  const rosterEntry = {
    playerId, cognome: player.cognome, nome: player.nome || "",
    ruolo: player.ruolo, ruoloMantra: player.ruoloMantra || "",
    squadra: player.squadra || "", price,
  };
  await updateDoc(doc(db, "teams", teamId), { credits: increment(-price), roster: arrayUnion(rosterEntry) });
  await updateDoc(doc(db, "players", playerId), { status: "assigned", assignedTeam: teamId, price });

  const newLog = [{ playerName: fullName(player), teamName, price, ruolo: player.ruolo }, ...(state.salesLog || [])].slice(0, 15);
  await updateDoc(doc(db, "state", "auction"), {
    status: "sold",
    lastSoldPlayerId: playerId,
    lastSoldTeam: teamId,
    lastSoldPrice: price,
    lastSoldPlayerName: fullName(player),
    salesLog: newLog,
  });
}

async function markUnsold() {
  if (!state || !state.currentPlayerId) return;
  await updateDoc(doc(db, "players", state.currentPlayerId), { status: "skipped" });
  await updateDoc(doc(db, "state", "auction"), {
    status: "unsold", lastSoldPlayerId: null, lastSoldTeam: null, lastSoldPrice: null, lastSoldPlayerName: null,
  });
}

async function cancelCall() {
  if (!state || !state.currentPlayerId) return;
  const playerId = state.currentPlayerId;
  try {
    await updateDoc(doc(db, "players", playerId), { status: "available" });
    const idx = (config?.drawOrder || []).indexOf(playerId);
    await updateDoc(doc(db, "state", "auction"), {
      status: "idle",
      currentPlayerId: null,
      currentBid: 0,
      currentBidTeam: null,
      timerEndsAt: null,
      nextIndex: idx >= 0 ? idx : state.nextIndex,
      calledCount: Math.max(0, (state.calledCount || 0) - 1),
    });
  } catch (e) {
    alert("Errore durante l'annullamento della chiamata: " + e.message);
  }
}

/** Rilancio registrato dall'admin per conto di una squadra (offerta fatta a
 * voce al tavolo). Stessa validazione di un rilancio normale, ma può essere
 * fatto per QUALSIASI squadra, non solo la propria. */
async function adminManualBid(teamId, amount) {
  await runTransaction(db, async (tx) => {
    const stateRef = doc(db, "state", "auction");
    const stateSnap = await tx.get(stateRef);
    const s = stateSnap.data();
    if (!s || s.status !== "bidding") throw new Error("Nessuna asta aperta in questo momento.");
    if (!(amount > (s.currentBid || 0))) throw new Error("L'importo deve superare l'offerta attuale.");

    const teamRef = doc(db, "teams", teamId);
    const teamSnap = await tx.get(teamRef);
    const team = teamSnap.data();
    if (!team) throw new Error("Squadra non valida.");
    if (team.credits < amount) throw new Error(`${team.name} non ha crediti sufficienti per questa offerta.`);

    const timerMs = (config?.bidTimerSeconds ?? DEFAULT_CONFIG.bidTimerSeconds) * 1000;
    tx.update(stateRef, {
      currentBid: amount,
      currentBidTeam: teamId,
      timerEndsAt: Timestamp.fromMillis(Date.now() + timerMs),
    });
  });
}

async function maybeAutoFinalize() {
  if (autoFinalizing) return;
  if (!state || state.status !== "bidding" || !state.timerEndsAt) return;
  if (Date.now() < timerEndsAtMs()) return;
  autoFinalizing = true;
  try {
    if (state.currentBidTeam) await finalizeSale(); else await markUnsold();
  } catch (e) {
    console.error("Errore assegnazione automatica:", e);
  } finally {
    autoFinalizing = false;
  }
}

function renderControl() {
  if (!isAdminUser) return;
  if (!state) {
    $("adminStatusPill").textContent = "stato: —";
    return;
  }
  $("adminStatusPill").textContent = "stato: " + (STATUS_LABELS[state.status] || state.status) +
    (state.totalCount ? ` (${state.calledCount || 0}/${state.totalCount})` : "");
  $("btnPause").textContent = state.status === "paused" ? "▶️ Riprendi" : "⏸ Pausa";
  $("btnPause").disabled = !["bidding", "paused"].includes(state.status);
  $("btnNext").disabled = !config || !["idle", "sold", "unsold"].includes(state.status);
  $("btnAssignNow").disabled = state.status !== "bidding" || !state.currentBidTeam;
  $("btnMarkUnsold").disabled = state.status !== "bidding";
  $("btnCancelCall").disabled = !["bidding", "paused"].includes(state.status) || !state.currentPlayerId;
  $("btnManualBid").disabled = state.status !== "bidding";
  $("btnUndo").disabled = !state.lastSoldPlayerId;
}

// ---------------------------------------------------------------------------
// Squadre e correzioni manuali
// ---------------------------------------------------------------------------
async function setTeamCredits(teamId, newCredits) {
  await updateDoc(doc(db, "teams", teamId), { credits: newCredits });
}

async function unassignPlayer(playerId) {
  const player = playersById.get(playerId);
  if (!player || !player.assignedTeam) {
    await updateDoc(doc(db, "players", playerId), { status: "available", assignedTeam: null, price: null });
    return;
  }
  const teamId = player.assignedTeam;
  const price = player.price || 0;
  const team = teamsById.get(teamId);
  const newRoster = (team?.roster || []).filter((r) => r.playerId !== playerId);
  await updateDoc(doc(db, "teams", teamId), { credits: increment(price), roster: newRoster });
  await updateDoc(doc(db, "players", playerId), { status: "available", assignedTeam: null, price: null });
}

async function manualAssign(playerId, teamId, price) {
  const player = playersById.get(playerId);
  if (!player) throw new Error("Calciatore non trovato.");
  if (!teamsById.get(teamId)) throw new Error("Squadra non valida.");
  if (!Number.isFinite(price) || price < 0) throw new Error("Prezzo non valido.");

  if (player.assignedTeam) await unassignPlayer(playerId);

  const rosterEntry = {
    playerId, cognome: player.cognome, nome: player.nome || "",
    ruolo: player.ruolo, ruoloMantra: player.ruoloMantra || "",
    squadra: player.squadra || "", price,
  };
  await updateDoc(doc(db, "teams", teamId), { credits: increment(-price), roster: arrayUnion(rosterEntry) });
  await updateDoc(doc(db, "players", playerId), { status: "assigned", assignedTeam: teamId, price });
}

function renderTeamsAdmin() {
  if (!isAdminUser) return;
  const wrap = $("teamsAdminList");
  const teams = [...teamsById.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
  wrap.innerHTML = teams.map((team) => {
    const rs = rosterStatus(team, rules);
    const roster = (team.roster || []).slice().sort((a, b) => ROLE_ORDER.indexOf(a.ruolo) - ROLE_ORDER.indexOf(b.ruolo));
    return `
      <div class="card" style="background:var(--panel-2);">
        <div class="row between">
          <strong>${escapeHtml(team.name)}</strong>
          <span class="small">${rs.portieri}/${rules.portiereMin}-${rules.portiereMax} Por · ${rs.totale}/${rules.totaleMin}-${rules.totaleMax} tot ${rs.rischioPortieri ? '<span class="t-warn">⚠ rischio portieri</span>' : ""}</span>
        </div>
        <div class="row center mt">
          <label style="margin:0;">Crediti:</label>
          <input type="number" class="credits-input" data-team="${team.id}" value="${team.credits}" style="max-width:110px;" />
          <button class="btn" data-action="save-credits" data-team="${team.id}">Salva</button>
        </div>
        <div class="roster-list mt">
          ${roster.length ? roster.map((p) => `
            <div class="roster-row">
              <span class="rr-role ${ROLE_CLASS[p.ruolo] || ""}">${ROLE_SHORT[p.ruolo] || ""}</span>
              <span class="rr-name">${escapeHtml(fullName(p))}</span>
              <span class="rr-price">${formatCredits(p.price)}</span>
              <button class="btn ghost" data-action="remove-player" data-player="${p.playerId}">✕</button>
            </div>
          `).join("") : '<p class="small">Rosa vuota.</p>'}
        </div>
      </div>
    `;
  }).join("") || '<p class="small">Nessuna squadra ancora configurata.</p>';
}

$("teamsAdminList").addEventListener("click", async (e) => {
  const saveBtn = e.target.closest('[data-action="save-credits"]');
  if (saveBtn) {
    const teamId = saveBtn.dataset.team;
    const input = $("teamsAdminList").querySelector(`.credits-input[data-team="${teamId}"]`);
    const val = Number(input.value);
    if (Number.isFinite(val)) await setTeamCredits(teamId, val);
    return;
  }
  const removeBtn = e.target.closest('[data-action="remove-player"]');
  if (removeBtn) {
    if (confirm("Rimuovere questo giocatore dalla rosa? I crediti verranno restituiti.")) {
      await unassignPlayer(removeBtn.dataset.player);
    }
  }
});

function populateManualTeamSelect() {
  if (!isAdminUser) return;
  const sel = $("manualTeamSelect");
  const current = sel.value;
  sel.innerHTML = '<option value="">Squadra…</option>' +
    [...teamsById.values()].sort((a, b) => a.name.localeCompare(b.name, "it"))
      .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

$("manualPlayerSearch").addEventListener("input", renderManualSearchResults);
function renderManualSearchResults() {
  const q = $("manualPlayerSearch").value.trim().toLowerCase();
  const wrap = $("manualPlayerResults");
  if (!q || selectedManualPlayerId) { wrap.innerHTML = ""; return; }
  const matches = [...playersById.values()]
    .filter((p) => (p.cognome || "").toLowerCase().includes(q) || (p.nome || "").toLowerCase().includes(q))
    .slice(0, 20);
  wrap.innerHTML = matches.map((p) => `
    <div class="roster-row" data-action="pick-player" data-player="${p.id}" style="cursor:pointer;">
      <span class="rr-role ${ROLE_CLASS[p.ruolo] || ""}">${ROLE_SHORT[p.ruolo] || ""}</span>
      <span class="rr-name">${escapeHtml(fullName(p))} <span class="small">(${escapeHtml(p.squadra || "")}) — ${p.status}${p.assignedTeam ? " → " + escapeHtml(teamsById.get(p.assignedTeam)?.name || p.assignedTeam) : ""}</span></span>
    </div>
  `).join("") || '<p class="small">Nessun risultato.</p>';
}
$("manualPlayerResults").addEventListener("click", (e) => {
  const row = e.target.closest('[data-action="pick-player"]');
  if (!row) return;
  selectedManualPlayerId = row.dataset.player;
  $("manualPlayerSearch").value = fullName(playersById.get(selectedManualPlayerId));
  $("manualPlayerResults").innerHTML = "";
});
$("manualPlayerSearch").addEventListener("focus", () => {
  if (selectedManualPlayerId) { selectedManualPlayerId = null; $("manualPlayerSearch").value = ""; }
});

$("btnManualAssign").onclick = async () => {
  $("manualAssignError").textContent = "";
  const teamId = $("manualTeamSelect").value;
  const price = Number($("manualPriceInput").value);
  if (!selectedManualPlayerId) { $("manualAssignError").textContent = "Seleziona prima un calciatore dai risultati di ricerca."; return; }
  if (!teamId) { $("manualAssignError").textContent = "Seleziona una squadra."; return; }
  if (!Number.isFinite(price) || price < 0) { $("manualAssignError").textContent = "Inserisci un prezzo valido."; return; }
  try {
    await manualAssign(selectedManualPlayerId, teamId, price);
    selectedManualPlayerId = null;
    $("manualPlayerSearch").value = "";
    $("manualPriceInput").value = "";
  } catch (e) {
    $("manualAssignError").textContent = e.message;
  }
};

// ---------------------------------------------------------------------------
// Esportazione
// ---------------------------------------------------------------------------
$("btnExport").onclick = () => {
  const teams = [...teamsById.values()];
  const csv = buildLegheFantacalcioCsv(teams);
  downloadTextFile("rose_leghe_fantacalcio.csv", csv);
};

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
