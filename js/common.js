// ============================================================================
// FantaMantra Patti — logica condivisa tra pagina partecipante e pagina admin.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Aggiungendo ?emulator=1 all'indirizzo si collega agli emulatori locali di
// Firebase invece che al progetto vero (usato solo per i test, non per la
// lega reale).
const USE_EMULATOR = new URLSearchParams(location.search).has("emulator");
if (USE_EMULATOR) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  console.warn("FantaMantra Patti: collegato all'EMULATORE locale, non al progetto reale.");
}

// ----------------------------------------------------------------------------
// Costanti di dominio
// ----------------------------------------------------------------------------

export const ROLE_ORDER = ["Portiere", "Difensore", "Centrocampista", "Attaccante"];

export const ROLE_SHORT = {
  Portiere: "P", Difensore: "D", Centrocampista: "C", Attaccante: "A",
};

export const ROLE_ICON = {
  Portiere: "🧤", Difensore: "🛡️", Centrocampista: "⚙️", Attaccante: "⚔️",
};

export const ROLE_CLASS = {
  Portiere: "role-p", Difensore: "role-d", Centrocampista: "role-c", Attaccante: "role-a",
};

/** Gruppo di colore "alla FantaLab" per la sigla di ruolo Mantra: 5 gruppi
 * pastello (P arancione, D verde, C blu, T/W viola "trequartisti", A rosso).
 * Usato solo per il colore del chip nella rosa: l'ORDINE dei giocatori in
 * rosa segue sempre e comunque il macro-ruolo base (P/D/C/A, da ROLE_ORDER),
 * mai questo raggruppamento a 5 colori. */
export const MANTRA_COLOR_GROUP = {
  Por: "mp",
  Dc: "md", Dd: "md", Ds: "md", B: "md",
  E: "mc", M: "mc", C: "mc",
  T: "mq", W: "mq",
  A: "ma", Pc: "ma",
};

/** Ordine "canonico" delle sigle Mantra, usato solo per decidere in che
 * ordine mostrare i badge quando un calciatore ne ha più di uno (es. un
 * centrocampista/trequartista mostra prima C poi T, mai il contrario),
 * seguendo lo stesso criterio del macro-ruolo base P/D/C/A. */
const MANTRA_SIGLA_ORDER = ["Por", "Dc", "Dd", "Ds", "B", "E", "M", "C", "T", "W", "A", "Pc"];

/** Tutte le sigle di ruolo Mantra di un calciatore, in ordine "canonico".
 * Nel listone i doppi/tripli ruoli si trovano separati da "/", ";" o
 * spazio a seconda della fonte del CSV (es. "C;T", "Dd/E", "W A"): li
 * gestiamo tutti. Se il campo è vuoto, usa la sigla base del macro-ruolo
 * (P/D/C/A) come singolo elemento. */
export function mantraRoles(player) {
  const raw = (player.ruoloMantra || "").trim();
  let sigle = raw ? raw.split(/[/;,\s]+/).map((s) => s.trim()).filter(Boolean) : [];
  if (!sigle.length) sigle = [ROLE_SHORT[player.ruolo] || "?"];
  return sigle.slice().sort((a, b) => {
    const ia = MANTRA_SIGLA_ORDER.indexOf(a);
    const ib = MANTRA_SIGLA_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

/** Sigla di ruolo Mantra "principale" (la prima in ordine canonico) da
 * usare ovunque serva un'unica etichetta/colore per il calciatore, es. per
 * decidere in quale sezione di colore raggrupparlo. */
export function primaryMantraRole(player) {
  return mantraRoles(player)[0];
}

export function mantraColorGroup(sigla) {
  return MANTRA_COLOR_GROUP[sigla] || "mc";
}

/** Chiave di ordinamento SECONDARIA, usata solo per decidere la posizione
 * di un calciatore ALL'INTERNO del proprio macro-ruolo base (P/D/C/A) —
 * non cambia mai il macro-ruolo, che resta sempre il criterio primario.
 * Un Difensore che è ANCHE "E" (esterno, di fatto un centrocampista
 * aggiunto) va posizionato "più avanti" nel blocco Difensori, cioè più
 * vicino ai Centrocampisti pur restando un difensore.
 * Tra i Centrocampisti la scala è a TRE gradini, non solo due: un
 * centrocampista "puro" (solo C/M/E, mai T/W) resta all'inizio del blocco;
 * uno che è ANCHE T o W (es. Ekkelenkamp: "C;T") va nel mezzo, più vicino
 * agli Attaccanti ma ancora prima di chi non ha affatto il ruolo C; infine
 * chi ha SOLO T/W senza mai C/M/E (es. Colpani, Rabiot se fosse puro T)
 * chiude il blocco, il più vicino di tutti agli Attaccanti. Ritorna 0
 * (posizione normale), 1 (spostato più avanti) o 2 (in fondo al blocco). */
export function forwardPushRank(player) {
  const sigle = mantraRoles(player);
  if (player.ruolo === "Difensore") {
    return sigle.includes("E") ? 1 : 0;
  }
  if (player.ruolo === "Centrocampista") {
    const hasCentrale = sigle.some((s) => s === "C" || s === "M" || s === "E");
    const hasTrequartista = sigle.includes("T") || sigle.includes("W");
    if (hasTrequartista && hasCentrale) return 1; // es. Ekkelenkamp "C;T"
    if (hasTrequartista && !hasCentrale) return 2; // es. Colpani, solo "T"
    return 0; // centrocampista puro
  }
  return 0;
}

export const DEFAULT_ROSTER_RULES = {
  portiereMin: 3, portiereMax: 5, totaleMin: 26, totaleMax: 34,
};

export const DEFAULT_CONFIG = {
  leagueName: "FantaMantra Patti",
  budget: 500,
  bidTimerSeconds: 12,
  openTimerSeconds: 25,
  increments: [1, 5, 10],
};

// ----------------------------------------------------------------------------
// Helper generici
// ----------------------------------------------------------------------------

export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "squadra";
}

export function fullName(player) {
  if (!player) return "";
  return [player.cognome, player.nome].filter(Boolean).join(" ");
}

// ----------------------------------------------------------------------------
// Foto calciatori. Le foto NON stanno su Firestore (appesantirebbe i documenti
// e i costi di lettura), ma come file statici pubblicati insieme al sito, in
// "data/foto/<slug-nome-cognome>.jpg" — lo stesso identico slug usato per i
// nomi squadra. Se manca la foto (o il file non esiste ancora), viene mostrata
// automaticamente una sagoma segnaposto: mai un'icona di immagine rotta.
// ----------------------------------------------------------------------------

const PHOTO_PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="#241c52"/>
    <circle cx="100" cy="80" r="34" fill="#4a3f8a"/>
    <path d="M30 178c8-42 42-64 70-64s62 22 70 64" fill="#4a3f8a"/>
  </svg>`
);

/** Nome file atteso per la foto di un calciatore (senza estensione/cartella),
 * usato sia dal sito sia dallo script di download delle foto. */
export function photoSlug(player) {
  return slugify(fullName(player));
}

export function photoUrlFor(player) {
  return "data/foto/" + photoSlug(player) + ".jpg";
}

/** Imposta la foto di un calciatore su un elemento <img>, con fallback
 * automatico alla sagoma segnaposto se il file non esiste. */
export function setPlayerPhoto(imgEl, player) {
  if (!imgEl) return;
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = PHOTO_PLACEHOLDER; };
  imgEl.alt = fullName(player);
  imgEl.src = player ? photoUrlFor(player) : PHOTO_PLACEHOLDER;
}

/** URL del logo della squadra di Serie A REALE di un calciatore (es. Genoa,
 * Fiorentina...), NON della fantasquadra che lo ha acquistato — scaricato
 * con scripts/scarica_loghi.py in data/loghi/<squadra-slug>.png. Restituisce
 * null se il calciatore non ha una squadra nota nel listone (es. svincolato
 * senza colonna Sq. compilata): in quel caso non c'è nessun logo da cercare. */
export function clubLogoUrlFor(player) {
  const squadra = (player?.squadra || "").trim();
  if (!squadra) return null;
  return "data/loghi/" + slugify(squadra) + ".png";
}

/** Imposta il logo-squadra su un elemento <img>: se il file manca (logo non
 * ancora scaricato per quella squadra) nasconde semplicemente l'elemento,
 * invece di mostrare l'icona di immagine rotta del browser. */
export function setClubLogo(imgEl, player) {
  if (!imgEl) return;
  const url = clubLogoUrlFor(player);
  if (!url) { imgEl.style.display = "none"; return; }
  imgEl.style.display = "";
  imgEl.onerror = () => { imgEl.style.display = "none"; };
  imgEl.alt = player.squadra || "";
  imgEl.src = url;
}

export function formatCredits(n) {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString("it-IT");
}

/** Colore semaforo in base ai crediti residui rispetto al budget iniziale,
 * come nello strumento desktop (verde/giallo/rosso). */
export function creditColor(remaining, budget) {
  if (budget <= 0) return "var(--ok)";
  const pct = remaining / budget;
  if (remaining < 0) return "var(--danger)";
  if (pct <= 0.15) return "var(--danger)";
  if (pct <= 0.35) return "var(--warn)";
  return "var(--ok)";
}

/** Stato di completamento rosa di una squadra rispetto alle regole correnti. */
export function rosterStatus(team, rules) {
  rules = rules || DEFAULT_ROSTER_RULES;
  const roster = team.roster || [];
  const countRole = (r) => roster.filter((p) => p.ruolo === r).length;
  const portieri = countRole("Portiere");
  const totale = roster.length;

  const missing = [];
  const mancanoPortieri = Math.max(0, rules.portiereMin - portieri);
  if (mancanoPortieri > 0) {
    missing.push(`${mancanoPortieri} ${mancanoPortieri === 1 ? "Portiere" : "Portieri"}`);
  }
  const mancanoTotale = Math.max(0, rules.totaleMin - totale);
  if (mancanoTotale > 0) {
    missing.push(`${mancanoTotale} giocatori (min. rosa)`);
  }

  const postiRimasti = Math.max(0, rules.totaleMax - totale);
  const portieriMancanti = Math.max(0, rules.portiereMin - portieri);
  const rischioPortieri = portieriMancanti > 0 && portieriMancanti >= postiRimasti;

  // Massimo teoricamente spendibile per UN acquisto restando comunque in
  // grado di completare la rosa minima: i crediti residui meno 1 credito
  // "di riserva" per ognuno degli altri posti ancora da riempire.
  const mancantiDopoQuesto = Math.max(0, rules.totaleMin - totale - 1);
  const maxSpendibile = Math.max(0, (team.credits ?? 0) - mancantiDopoQuesto);

  return {
    portieri, totale,
    movimento: totale - portieri,
    maxSpendibile,
    complete: portieri >= rules.portiereMin && totale >= rules.totaleMin,
    missing,
    rischioPortieri,
    // Il numero di portieri va evidenziato (in rosso) quando è ancora sotto
    // il minimo richiesto oppure ha già raggiunto il massimo consentito: in
    // entrambi i casi la squadra non può più comprare/deve ancora comprare
    // portieri, quindi merita attenzione a colpo d'occhio.
    portieriOutOfRange: portieri < rules.portiereMin || portieri >= rules.portiereMax,
    // Il numero di giocatori di movimento non ha un proprio minimo/massimo
    // indipendente: segue lo stesso limite della rosa totale (il minimo
    // "movimento" implicito è totaleMin-portieriMax, il massimo è
    // totaleMax-portieriMin), quindi lo evidenziamo quando la rosa totale è
    // ancora sotto il minimo complessivo o ha già raggiunto il massimo.
    movimentoOutOfRange: totale < rules.totaleMin || totale >= rules.totaleMax,
    roleFull: (ruolo) => {
      if (totale >= rules.totaleMax) return true;
      if (ruolo === "Portiere") return portieri >= rules.portiereMax;
      return false;
    },
  };
}

export function formatCountdown(msRemaining) {
  const s = Math.max(0, Math.ceil(msRemaining / 1000));
  return String(s);
}

/** Testo/colore per l'anello del timer, condiviso tra pagina partecipante e admin. */
export function ringDisplay(state) {
  if (!state) return { label: "—", cls: "ok" };
  if (state.status === "bidding" && state.timerEndsAt) {
    const endsAt = state.timerEndsAt.toMillis ? state.timerEndsAt.toMillis() : state.timerEndsAt;
    const secs = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    return { label: "⏳ " + secs, cls: secs <= 5 ? "low" : secs <= 10 ? "mid" : "ok" };
  }
  if (state.status === "paused") {
    const secs = Math.max(0, Math.ceil((state.pausedRemainingMs || 0) / 1000));
    return { label: "⏸ " + secs, cls: "mid" };
  }
  return { label: "—", cls: "ok" };
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ----------------------------------------------------------------------------
// Parsing CSV listone. Riconosce DUE formati, per nome di colonna (ordine
// libero, come converti_listone.py):
//  1) formato "semplice" del programma desktop:
//     ruolo,cognome,nome,squadra,quotazione,ruolo_mantra
//  2) formato "ufficiale" export svincolati/listone:
//     #,Nome,Fuori lista,Sq.,Under,R.,R.MANTRA,PGv,MV,FM,FVM/1000,QUOT.,FantaSquadra,Costo
//     (qui "Nome" è già il nominativo intero da mostrare, non c'è "cognome"
//     separato; le righe marcate "Fuori lista" vengono escluse)
// ----------------------------------------------------------------------------

export function parseListoneCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { players: [], errors: ["File vuoto."] };

  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = (names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const iRuolo = idx(["ruolo", "r.", "r"]);
  let iCognome = idx(["cognome"]);
  let iNome = idx(["nome"]);
  if (iCognome === -1 && iNome !== -1) {
    // formato ufficiale: un'unica colonna "Nome" fa da nominativo completo.
    iCognome = iNome;
    iNome = -1;
  }
  const iSquadra = idx(["squadra", "sq."]);
  const iQuot = idx(["quotazione", "qt.a", "quota", "quot."]);
  const iMantra = idx(["ruolo_mantra", "ruolomantra", "mantra", "r.mantra"]);
  const iFuoriLista = idx(["fuori lista", "fuorilista"]);
  // Statistiche stagione in corso, presenti SOLO nel formato "ufficiale":
  // PGv (partite giocate), MV (media voto), FM (fantamedia). Nel formato
  // "semplice" queste colonne non esistono: restano assenti (undefined), e
  // lo stage le nasconde semplicemente quando mancano.
  const iPGv = idx(["pgv"]);
  const iMV = idx(["mv"]);
  const iFM = idx(["fm"]);

  const errors = [];
  if (iRuolo === -1 || iCognome === -1) {
    errors.push("Intestazione non riconosciuta: servono almeno le colonne ruolo/R. e cognome/Nome.");
    return { players: [], errors };
  }

  const ROLE_MAP = {
    p: "Portiere", portiere: "Portiere",
    d: "Difensore", difensore: "Difensore",
    c: "Centrocampista", centrocampista: "Centrocampista",
    a: "Attaccante", attaccante: "Attaccante",
  };

  const players = [];
  let excluded = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => String(c).trim() === "")) continue;
    if (iFuoriLista !== -1 && String(row[iFuoriLista] ?? "").trim() !== "") { excluded++; continue; }
    const ruoloRaw = String(row[iRuolo] ?? "").trim().toLowerCase();
    const ruolo = ROLE_MAP[ruoloRaw];
    const cognome = String(row[iCognome] ?? "").trim();
    if (!ruolo || !cognome) continue;
    players.push({
      ruolo,
      cognome,
      nome: iNome !== -1 ? String(row[iNome] ?? "").trim() : "",
      squadra: iSquadra !== -1 ? String(row[iSquadra] ?? "").trim() : "",
      quotazione: iQuot !== -1 ? (row[iQuot] ?? "") : "",
      ruoloMantra: iMantra !== -1 ? String(row[iMantra] ?? "").trim() : "",
      pgv: iPGv !== -1 ? parseStatNumber(row[iPGv]) : null,
      mv: iMV !== -1 ? parseStatNumber(row[iMV]) : null,
      fm: iFM !== -1 ? parseStatNumber(row[iFM]) : null,
      status: "available",
      assignedTeam: null,
      price: null,
    });
  }
  if (players.length === 0) errors.push("Nessun calciatore valido trovato nel file.");
  return { players, errors, excluded };
}

/** Converte un valore statistico (PGv/MV/FM) dal CSV in un numero, gestendo
 * la virgola decimale italiana ("6,50") e valori vuoti/placeholder ("-",
 * "n.d.") restituendo null invece di NaN, così lo stage può nascondere il
 * dato invece di mostrare "NaN". */
function parseStatNumber(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "-" || s.toLowerCase() === "n.d.") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Parser CSV minimale ma robusto a virgolette e virgole dentro ai campi. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

// ----------------------------------------------------------------------------
// Mescolamento (Fisher-Yates), come "Mescola tutto" nello strumento desktop.
// ----------------------------------------------------------------------------
export function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ----------------------------------------------------------------------------
// Esportazione CSV per l'importazione rose su Leghe Fantacalcio.
// Colonne verificate come accettate dall'importatore: Calciatore, Fantasquadra,
// Prezzo (più Ruolo e Squadra, opzionali ma utili).
// ----------------------------------------------------------------------------
export function buildLegheFantacalcioCsv(teams) {
  const lines = [["Ruolo", "Calciatore", "Squadra", "Fantasquadra", "Prezzo"]];
  for (const team of teams) {
    for (const p of (team.roster || [])) {
      lines.push([
        ROLE_SHORT[p.ruolo] || p.ruolo || "",
        fullName(p),
        p.squadraReale || p.squadra || "",
        team.name,
        p.price ?? "",
      ]);
    }
  }
  return lines.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Rete di sicurezza: se dopo qualche secondo la pagina non ha ancora
 * ricevuto risposta da Firebase (schermata bloccata su "collegamento…"),
 * mostra un avviso comprensibile invece di restare muta. `isReadyFn` deve
 * restituire true non appena la pagina ha una risposta (anche di errore).
 */
export function armStuckWatchdog(isReadyFn, extraHintsHtml = "") {
  setTimeout(() => {
    if (isReadyFn()) return;
    const topbar = document.querySelector(".topbar");
    if (!topbar || document.getElementById("ffStuckWarning")) return;
    const div = document.createElement("div");
    div.id = "ffStuckWarning";
    div.className = "card";
    div.style.borderColor = "var(--danger)";
    div.innerHTML = `
      <h3 style="color:var(--danger); margin-top:0;">⚠ La pagina non riesce a collegarsi</h3>
      <p>Sono passati diversi secondi senza risposta da Firebase. Controlla, in ordine:</p>
      <ol style="padding-left:20px; margin:8px 0;">
        <li>Stai aprendo l'indirizzo <strong>pubblico</strong> del sito (es. <code>https://tuonome.github.io/tuorepo/</code>) e non un file aperto direttamente dal computer, né la pagina del file su github.com?</li>
        <li>Nel progetto Firebase, <strong>Firestore Database</strong> è stato creato (Build → Firestore Database)?</li>
        ${extraHintsHtml}
        <li>Il file <code>js/firebase-config.js</code> pubblicato online contiene i tuoi valori veri (non più "INCOLLA_QUI…")?</li>
      </ol>
      <p class="small">Se tutto questo è a posto, apri la Console del browser (tasto destro sulla pagina → "Ispeziona" → scheda "Console") e guarda se compare una scritta rossa: quel testo dice esattamente cosa non va.</p>
    `;
    topbar.after(div);
  }, 7000);
}

export function downloadTextFile(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
