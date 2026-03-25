import express from "express";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

// =====================================
// CONFIG
// =====================================

const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const DISPLAY_TIME_ZONE = "Europe/Rome";
const bootTime = new Date().toISOString();
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const AIRPORT_CODE = "flr";
const FR24_URL = `https://api.flightradar24.com/common/v1/airport.json?code=${AIRPORT_CODE}&plugin[]=schedule&plugin-setting[schedule][mode]=arrivals&page=1&limit=100`;

// =====================================
// STATO POLLING
// =====================================

let pollingActive = false;
let pollingTimer = null;
let pollInProgress = false;
let lastPollTime = null;
let lastPollCount = 0;
let lastUiError = null;

// =====================================
// DEBUG BUFFER IN RAM
// =====================================

const debugBuffer = [];

function logEvent(event) {
  debugBuffer.push({
    ts: new Date().toISOString(),
    ...event
  });

  if (debugBuffer.length > 200) {
    debugBuffer.shift();
  }
}

// =====================================
// TELEGRAM
// =====================================

async function sendTelegram(message) {
  // Se Telegram non è configurato, non blocchiamo il server:
  // salviamo solo l'evento di debug e usciamo.
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logEvent({
      type: "TELEGRAM_SKIPPED",
      reason: "missing_env",
      message
    });
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    });

    logEvent({
      type: "TELEGRAM_SENT",
      message
    });
  } catch (err) {
    logEvent({
      type: "TELEGRAM_ERROR",
      error: err.message
    });
  }
}

// =====================================
// UTILS VOLO
// =====================================

function formatTime(epochSeconds) {
  if (!epochSeconds) return null;

  return new Date(epochSeconds * 1000).toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE
  });
}

function simplifyFlights(rows) {
  return rows.map((row) => {
    const flight = row.flight || row;

    const sched = flight?.time?.scheduled?.arrival ?? null;
    const est = flight?.time?.estimated?.arrival ?? null;
    const real = flight?.time?.real?.arrival ?? null;
    const base = real ?? est ?? sched;

    return {
      numero: flight?.identification?.number?.default ?? "N/A",
      origine: flight?.airport?.origin?.name ?? "N/A",
      stato: flight?.status?.text ?? "",
      sched,
      est,
      real,
      base,
      orario_sched: formatTime(sched),
      orario_est: formatTime(est),
      orario_real: formatTime(real),
      orario_base: formatTime(base)
    };
  });
}

async function getFlights() {
  const res = await axios.get(FR24_URL, {
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  const rows =
    res.data?.result?.response?.airport?.pluginData?.schedule?.arrivals?.data || [];

  return simplifyFlights(rows);
}

// =====================================
// FILTRI VOLI RILEVANTI
// =====================================

// Qui stiamo facendo una prima selezione pragmatica:
// hub importanti e nodi italiani strategici.
// La lista si può migliorare dopo, ma intanto evita rumore.
const HUB_KEYWORDS = [
  "london",
  "paris",
  "amsterdam",
  "frankfurt",
  "munich",
  "madrid",
  "barcelona",
  "zurich",
  "vienna",
  "brussels",
  "copenhagen",
  "lisbon",
  "dublin"
];

const ITALY_STRATEGIC_KEYWORDS = [
  "rome",
  "fiumicino",
  "milan",
  "malpensa"
];

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isRelevantFlight(f) {
  const origine = normalizeText(f.origine);

  return (
    HUB_KEYWORDS.some((k) => origine.includes(k)) ||
    ITALY_STRATEGIC_KEYWORDS.some((k) => origine.includes(k))
  );
}

function hasLanded(f) {
  const stato = normalizeText(f.stato);
  return stato.includes("landed") || stato.includes("arrived") || !!f.real;
}

function getFlightId(f) {
  return f.numero || "N/A";
}

function getUiFlights(flights) {
  const now = Date.now();

  return flights
    .filter(isRelevantFlight)
    .filter((f) => {
      if (!f.base) return false;
      const diff = f.base * 1000 - now;
      return diff > 0 && diff <= 35 * 60 * 1000;
    })
    .sort((a, b) => (a.base ?? 0) - (b.base ?? 0));
}

// =====================================
// STATO DEI VOLI
// =====================================

const flightState = new Map();

// Per ogni volo teniamo traccia minima ma utile:
// - se notificato
// - se atterrato
// - quando l'abbiamo visto l'ultima volta
// - quante volte è "mancato" dal feed
async function processFlights(flights) {
  const seenIds = new Set();

  for (const f of flights) {
    if (!isRelevantFlight(f)) continue;

    const id = getFlightId(f);
    seenIds.add(id);

    const prev = flightState.get(id) || {
		  notified: false,
		  landed: false,
		  diverted: false,
		  canceled: false,
		  probableLanded: false,
		  closed: false,
		  lastSeenAt: 0,
		  misses: 0,
		  numero: f.numero,
		  origine: f.origine,
		  base: f.base,
		  stato: f.stato
};

    prev.lastSeenAt = Date.now();
    prev.misses = 0;
    prev.numero = f.numero;
    prev.origine = f.origine;
    prev.base = f.base;
    prev.stato = f.stato;
	
	const statoNorm = normalizeText(f.stato);

// Se FR24 segnala dirottato, lo chiudiamo come dirottato certo
if (statoNorm.includes("divert")) {
  if (!prev.diverted && !prev.closed) {
    prev.diverted = true;
    prev.closed = true;

   await sendTelegram(`↪️ ${f.numero} da ${f.origine} dirottato`);

    logEvent({
      type: "DIVERTED",
      id,
      flight: f.numero,
      origin: f.origine
    });
  }

  flightState.set(id, prev);
  continue;
}

// Se FR24 segnala cancellato, lo chiudiamo come cancellato certo
if (statoNorm.includes("cancel")) {
  if (!prev.canceled && !prev.closed) {
    prev.canceled = true;
    prev.closed = true;

    logEvent({
      type: "CANCELED",
      id,
      flight: f.numero,
      origin: f.origine
    });
  }

  flightState.set(id, prev);
  continue;
}

    // =====================================
    // NOTIFICA PRE-ARRIVO
    // =====================================
    // Invia una notifica una sola volta quando il volo entra
    // nella finestra dei prossimi 30 minuti.
    if (!prev.notified && f.base) {
      const diff = f.base * 1000 - Date.now();

      if (diff > 0 && diff <= 30 * 60 * 1000) {
        await sendTelegram(
          `✈️ ${f.numero} da ${f.origine}. Arrivo previsto a Firenze alle ${f.orario_base || "-"}`
        );

        prev.notified = true;

        logEvent({
          type: "NOTIFIED_30",
          id,
          flight: f.numero,
          origin: f.origine,
          time: f.orario_base || null
        });
      }
    }

    // =====================================
    // NOTIFICA ATTERRAGGIO
    // =====================================
    // Se FR24 segnala atterrato e il volo era già stato notificato,
    // mandiamo la conferma di arrivo.
   if (hasLanded(f) && prev.notified && !prev.landed && !prev.closed) {
	 await sendTelegram(`✅ ${f.numero} da ${f.origine} atterrato a Firenze`);

	  prev.landed = true;
	  prev.closed = true;

	  logEvent({
		type: "LANDED",
		id,
		flight: f.numero,
		origin: f.origine
  });
}

    flightState.set(id, prev);
  }

  // =====================================
  // GESTIONE VOLI SPARITI DAL FEED
  // =====================================
  // Se un volo notificato sparisce dal feed per più cicli,
  // possiamo almeno segnalarlo come "probabile atterrato".
 for (const [id, state] of flightState.entries()) {
  if (seenIds.has(id)) continue;

  state.misses = (state.misses || 0) + 1;

  const now = Date.now();
  const baseTime = state.base ? state.base * 1000 : null;

  // Caso neutro: il volo era aperto, ma non lo vediamo più su FLR
  // dopo ETA + 2 minuti. NON diciamo "atterrato", perché potrebbe
  // anche essere stato dirottato e il feed non averlo mostrato bene.
  if (
    state.notified &&
    !state.landed &&
    !state.diverted &&
    !state.canceled &&
    !state.closed &&
    state.misses >= 2 &&
    baseTime &&
    now > baseTime + 2 * 60 * 1000
  ) {
    state.closed = true;

    await sendTelegram(`⚠️ ${state.origine} non più su FLR`);

    logEvent({
      type: "DISAPPEARED_FROM_FLR",
      id,
      flight: state.numero,
      origin: state.origine
    });
  }

  flightState.set(id, state);
}
}

// =====================================
// POLLING
// =====================================

async function poll() {
  if (pollInProgress) {
    logEvent({ type: "POLL_SKIPPED", reason: "already_running" });
    return;
  }

  pollInProgress = true;

  try {
    const flights = await getFlights();
    const relevantUiFlights = getUiFlights(flights);

    lastPollTime = new Date().toLocaleString("it-IT", {
      timeZone: DISPLAY_TIME_ZONE
    });
    lastPollCount = relevantUiFlights.length;
    lastUiError = null;

    logEvent({
      type: "POLL_OK",
      totalFlights: flights.length,
      relevantFlights: relevantUiFlights.length
    });

    await processFlights(flights);
  } catch (err) {
    lastUiError = err.message;

    logEvent({
      type: "POLL_ERROR",
      error: err.message
    });
  } finally {
    pollInProgress = false;
  }
}

function getNextPollInterval() {
  const now = Date.now();

  let hasRelevantSoon = false;
  let hasVeryCloseFlight = false;
  let hasOpenOverdueFlight = false;

  for (const state of flightState.values()) {
    // Consideriamo solo i voli ancora "aperti"
    const isOpen =
      state.notified &&
      !state.landed &&
      !state.diverted &&
      !state.canceled;

    if (!isOpen) continue;

    if (!state.base) continue;

    const diff = state.base * 1000 - now;

    // volo già oltre ETA ma non ancora chiuso
    if (diff <= 0) {
      hasOpenOverdueFlight = true;
    }

    // volo molto vicino all'arrivo
    if (diff > 0 && diff <= 8 * 60 * 1000) {
      hasVeryCloseFlight = true;
    }
  }

  // Se non ho open flights, guardo i voli UI correnti
  // per capire se sta per arrivare qualcosa di interessante.
  if (!hasOpenOverdueFlight && !hasVeryCloseFlight) {
    const nowSec = now / 1000;

    for (const state of flightState.values()) {
      if (!state.base) continue;

      const diffSec = state.base - nowSec;

      if (diffSec > 0 && diffSec <= 60 * 60) {
        hasRelevantSoon = true;
        break;
      }
    }
  }

  // PRIORITÀ:
  // 1) volo oltre ETA ma ancora aperto -> controllo stretto
  if (hasOpenOverdueFlight) return 15000; // 15 sec

  // 2) volo entro 8 minuti -> controllo ravvicinato
  if (hasVeryCloseFlight) return 20000; // 20 sec

  // 3) qualcosa di rilevante entro 60 min -> ritmo normale
  if (hasRelevantSoon) return 60000; // 60 sec

  // 4) calma piatta -> ritmo lento
  return 180000; // 3 min
}

function scheduleNextPoll() {
  if (!pollingActive) return;

  const nextMs = getNextPollInterval();

  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  logEvent({
    type: "NEXT_POLL_SCHEDULED",
    ms: nextMs
  });

  pollingTimer = setTimeout(() => {
    poll()
      .catch((err) => {
        logEvent({
          type: "SCHEDULED_POLL_ERROR",
          error: err.message
        });
      })
      .finally(() => {
        scheduleNextPoll();
      });
  }, nextMs);
}

function startPolling() {
  if (pollingActive) return;

  pollingActive = true;

  logEvent({ type: "POLLING_STARTED" });

  // Primo poll immediato
  poll()
    .catch((err) => {
      logEvent({ type: "START_POLL_ERROR", error: err.message });
    })
    .finally(() => {
      scheduleNextPoll();
    });
}

function stopPolling() {
  if (!pollingActive) return;

  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  pollingActive = false;

  logEvent({ type: "POLLING_STOPPED" });
}

// =====================================
// PAGINA WEB
// =====================================

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>FLR Monitor</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #111;
      color: #fff;
      margin: 0;
      padding: 20px;
    }
    h1, h2 {
      margin-top: 0;
    }
    button {
      font-size: 18px;
      padding: 12px 18px;
      margin-right: 10px;
      margin-bottom: 10px;
      border: 0;
      border-radius: 10px;
      cursor: pointer;
    }
    #start { background: #1ea446; color: white; }
    #stop { background: #c83a36; color: white; }
    .card {
      background: #1c1c1c;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 10px;
    }
    .small {
      color: #bbb;
      font-size: 14px;
    }
  </style>
</head>
<body>
 <h1>FLR Monitor</h1>

<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
  <button id="start">AVVIA</button>
  <button id="stop">FERMA</button>
</div>

<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px;">
  <a href="/health" target="_blank" style="font-size:11px; padding:4px 7px; background:#2a2a2a; color:#ddd; text-decoration:none; border-radius:6px;">Health</a>
  <a href="/debug/events" target="_blank" style="font-size:11px; padding:4px 7px; background:#2a2a2a; color:#ddd; text-decoration:none; border-radius:6px;">Events</a>
  <a href="/debug/state" target="_blank" style="font-size:11px; padding:4px 7px; background:#2a2a2a; color:#ddd; text-decoration:none; border-radius:6px;">State</a>
  <a href="/arrivals-next" target="_blank" style="font-size:11px; padding:4px 7px; background:#2a2a2a; color:#ddd; text-decoration:none; border-radius:6px;">Next</a>
</div>

  <div class="card">
    <div><strong>Polling:</strong> <span id="status">...</span></div>
    <div class="small">Ultimo controllo: <span id="lastPollTime">-</span></div>
    <div class="small">Voli rilevanti entro 35 min: <span id="lastPollCount">-</span></div>
    <div class="small">Errore: <span id="lastUiError">-</span></div>
  </div>

  <h2>Prossimi arrivi rilevanti</h2>
  <div id="flights"></div>

  <script>
    async function getJson(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Errore richiesta");
      return data;
    }

    async function refreshHealth() {
      try {
        const data = await getJson('/health');
        document.getElementById('status').textContent = data.pollingActive ? 'ATTIVO' : 'FERMO';
        document.getElementById('lastPollTime').textContent = data.lastPollTime || '-';
        document.getElementById('lastPollCount').textContent = data.lastPollCount ?? '-';
        document.getElementById('lastUiError').textContent = data.lastUiError || '-';
      } catch (err) {
        document.getElementById('status').textContent = 'ERRORE';
      }
    }

    async function refreshFlights() {
      const box = document.getElementById('flights');

      try {
        const data = await getJson('/arrivals-next');
        const flights = Array.isArray(data.flights) ? data.flights : [];
        box.innerHTML = '';

        if (flights.length === 0) {
          box.innerHTML = '<div class="card">Nessun volo rilevante entro 35 minuti</div>';
          return;
        }

        for (const f of flights) {
          const el = document.createElement('div');
          el.className = 'card';
          el.innerHTML =
            '<div><strong>' + f.numero + '</strong></div>' +
            '<div>' + f.origine + '</div>' +
            '<div class="small">' + (f.orario_base || '-') + ' • ' + (f.stato || '-') + '</div>';
          box.appendChild(el);
        }
      } catch (err) {
        box.innerHTML = '<div class="card">Errore caricamento voli: ' + err.message + '</div>';
      }
    }

    async function startPolling() {
      await getJson('/start', { method: 'POST' });
      await refreshHealth();
      await refreshFlights();
    }

    async function stopPolling() {
      await getJson('/stop', { method: 'POST' });
      await refreshHealth();
    }

    document.getElementById('start').addEventListener('click', startPolling);
    document.getElementById('stop').addEventListener('click', stopPolling);

    refreshHealth();
    refreshFlights();

    setInterval(() => {
      refreshHealth();
      refreshFlights();
    }, 10000);
  </script>
</body>
</html>`);
});

// =====================================
// API
// =====================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pollingActive,
    lastPollTime,
    lastPollCount,
    lastUiError,
    bootTime
  });
});

app.get("/arrivals", async (req, res) => {
  try {
    const flights = await getFlights();
    res.json({ ok: true, flights });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/arrivals-next", async (req, res) => {
  try {
    const flights = await getFlights();
    const next = getUiFlights(flights);

    res.json({
      ok: true,
      flights: next
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/debug/events", (req, res) => {
  res.json(debugBuffer);
});

app.get("/debug/state", (req, res) => {
  res.json(Object.fromEntries(flightState));
});

app.post("/start", (req, res) => {
  startPolling();
  res.json({ ok: true, message: "Polling avviato" });
});

app.post("/stop", (req, res) => {
  stopPolling();
  res.json({ ok: true, message: "Polling fermato" });
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, () => {
  console.log(`Server attivo su http://localhost:${PORT}`);


		
		

  // 🔥 avvio automatico polling
  startPolling();
});