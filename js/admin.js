// ============================================================================
// FantaFanta Patti — pagina ADMIN
// ============================================================================
import {
  doc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, collection,
  writeBatch, increment, arrayUnion, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  db, auth, ROLE_ICON, ROLE_CLASS, ROLE_SHORT, ROLE_ORDER,
  DEFAULT_ROSTER_RULES, DEFAULT_CONFIG, slugify, fullName, formatCredits,
  rosterStatus, escapeHtml, ringDisplay, parseListoneCsv, shuffle,
  buildLegheFantacalcioCsv, downloadTextFile,
} from "./common.js";

const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  setup: "da configurare", idle: "in attesa", bidding: "asta aperta",
  sold: "assegnato", unsold: "nessuna offerta", paused: "in pausa", finished: "terminata",
};

let config = null;
let rules = DEFAULT_ROSTER_RULES;
let state = null;
let teamsById = new Map();
let playersById = new Map();
let currentPlayer = null;
let parsedCsvPlayers = null;
let unsubPlayer = null;
let subscribed = false;
let setupPrefilled = false;
let selectedManualPlayerId = null;

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  if (user) {
    show("adminView");
    $("btnSignOut").classList.remove("hidden");
    setConnDot("collegato come " + user.email, true);
    if (!subscribed) { subscribed = true; subscribeAll(); }
  } else {
    show("loginView");
    $("btnSignOut").classList.add("hidden");
    setConnDot("non autenticato", false);
  }
});

$("btnSignIn").onclick = async () => {
  $("loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPass").value);
  } catch (e) {
    $("loginError").textContent = "Accesso non riuscito: controlla email e password.";
  }
};
$("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnSignIn").click(); });
$("btnSignOut").onclick = () => signOut(auth);

function show(id) {
  ["loginView", "adminView"].forEach((v) => $(v).classList.toggle("hidden", v !== id));
}
function setConnDot(text, ok) {
  const el = $("connDot");
  el.textContent = (ok ? "● " : "○ ") + text;
  el.style.color = ok ? "var(--ok)" : "var(--text-dim)";
}

// ---------------------------------------------------------------------------
// Sottoscrizioni realtime
// ---------------------------------------------------------------------------
function subscribeAll() {
  onSnapshot(doc(db, "config", "public"), (snap) => {
    config = snap.exists() ? snap.data() : null;
    rules = config?.rosterRules || DEFAULT_ROSTER_RULES;
    maybePrefillSetup();
    renderTeamsAdmin();
    renderControl();
  });

  onSnapshot(doc(db, "state", "auction"), (snap) => {
    state = snap.exists() ? snap.data() : null;
    if (state) watchCurrentPlayer(state.currentPlayerId);
    renderControl();
  });

  onSnapshot(collection(db, "teams"), (snap) => {
    teamsById = new Map();
    snap.forEach((d) => teamsById.set(d.id, { id: d.id, ...d.data() }));
    renderTeamsAdmin();
    populateManualTeamSelect();
    renderControl();
  });

  onSnapshot(collection(db, "players"), (snap) => {
    playersById = new Map();
    snap.forEach((d) => playersById.set(d.id, { id: d.id, ...d.data() }));
    renderManualSearchResults();
  });

  setInterval(() => {
    if (state) { updateRing(); maybeAutoFinalize(); }
  }, 250);
}

function watchCurrentPlayer(playerId) {
  if (currentPlayer && currentPlayer.id === playerId) return;
  if (unsubPlayer) { unsubPlayer(); unsubPlayer = null; }
  currentPlayer = null;
  if (!playerId) { renderControl(); return; }
  unsubPlayer = onSnapshot(doc(db, "players", playerId), (snap) => {
    currentPlayer = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    renderControl();
  });
}

// ---------------------------------------------------------------------------
// 1. Setup
// ---------------------------------------------------------------------------
$("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { players, errors } = parseListoneCsv(text);
  if (errors.length) {
    $("csvSummary").textContent = "⚠ " + errors.join(" ");
    parsedCsvPlayers = null;
    return;
  }
  parsedCsvPlayers = players;
  const counts = {};
  players.forEach((p) => { counts[p.ruolo] = (counts[p.ruolo] || 0) + 1; });
  $("csvSummary").textContent = `${players.length} calciatori caricati (` +
    ROLE_ORDER.map((r) => `${r.slice(0, 3)}: ${counts[r] || 0}`).join(", ") + ")";
});

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

    $("setupStatus").textContent = `✅ Asta inizializzata: ${ids.length} calciatori, ${teamNames.length} squadre, ${budget} crediti a testa.`;
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
  alert("Dati cancellati. Configura una nuova asta dal punto 1.");
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
// 2. Controllo live
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
    const { endsAtMs } = timerInfo();
    const remaining = Math.max(0, endsAtMs - Date.now());
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

function timerInfo() {
  const endsAtMs = state?.timerEndsAt
    ? (state.timerEndsAt.toMillis ? state.timerEndsAt.toMillis() : state.timerEndsAt)
    : Date.now();
  return { endsAtMs };
}

async function finalizeSale() {
  if (!state || state.status !== "bidding" || !state.currentPlayerId) return;
  if (!state.currentBidTeam) { await markUnsold(); return; }
  const playerId = state.currentPlayerId;
  const teamId = state.currentBidTeam;
  const price = state.currentBid;
  const player = playersById.get(playerId);
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

let autoFinalizing = false;
async function maybeAutoFinalize() {
  if (autoFinalizing) return;
  if (!state || state.status !== "bidding" || !state.timerEndsAt) return;
  const { endsAtMs } = timerInfo();
  if (Date.now() < endsAtMs) return;
  autoFinalizing = true;
  try {
    if (state.currentBidTeam) await finalizeSale(); else await markUnsold();
  } catch (e) {
    console.error("Errore assegnazione automatica:", e);
  } finally {
    autoFinalizing = false;
  }
}

function updateRing() {
  const { label, cls } = ringDisplay(state);
  $("adminTimerRing").textContent = label;
  $("adminTimerRing").className = "timer-ring " + cls;
}

function renderControl() {
  if (!state) return;
  $("adminStatusPill").textContent = "stato: " + (STATUS_LABELS[state.status] || state.status);
  $("adminProgress").textContent = state.totalCount ? `${state.calledCount || 0} / ${state.totalCount}` : "—";
  $("btnPause").textContent = state.status === "paused" ? "▶️ Riprendi" : "⏸ Pausa";
  $("btnPause").disabled = !["bidding", "paused"].includes(state.status);
  $("btnNext").disabled = !config || !["idle", "sold", "unsold"].includes(state.status);
  $("btnAssignNow").disabled = state.status !== "bidding" || !state.currentBidTeam;
  $("btnMarkUnsold").disabled = state.status !== "bidding";
  $("btnUndo").disabled = !state.lastSoldPlayerId;

  const showPlayer = ["bidding", "sold", "unsold", "paused"].includes(state.status) && currentPlayer;
  if (showPlayer) {
    $("adminRoleBadge").textContent = `${ROLE_ICON[currentPlayer.ruolo] || ""} ${currentPlayer.ruolo}${currentPlayer.ruoloMantra ? " · " + currentPlayer.ruoloMantra : ""}`;
    $("adminRoleBadge").className = "role-badge " + (ROLE_CLASS[currentPlayer.ruolo] || "");
    $("adminPlayerName").textContent = fullName(currentPlayer);
    $("adminPlayerMeta").textContent = [currentPlayer.squadra, currentPlayer.quotazione ? `Qt.A ${currentPlayer.quotazione}` : ""].filter(Boolean).join(" · ");
    $("adminCurrentBid").textContent = formatCredits(state.currentBid || 0);
    const leadTeam = state.currentBidTeam ? teamsById.get(state.currentBidTeam) : null;
    $("adminCurrentBidTeam").textContent = leadTeam ? `al rilancio: ${leadTeam.name}` : "Nessuna offerta";
  } else {
    $("adminRoleBadge").textContent = "";
    $("adminPlayerName").textContent = state.status === "finished" ? "🏁 Asta terminata" : "Nessun giocatore in asta";
    $("adminPlayerMeta").textContent = "";
    $("adminCurrentBid").textContent = "0";
    $("adminCurrentBidTeam").textContent = "—";
  }
  updateRing();
}

// ---------------------------------------------------------------------------
// 3. Squadre e correzioni manuali
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
// 4. Esportazione
// ---------------------------------------------------------------------------
$("btnExport").onclick = () => {
  const teams = [...teamsById.values()];
  const csv = buildLegheFantacalcioCsv(teams);
  downloadTextFile("rose_leghe_fantacalcio.csv", csv);
};
