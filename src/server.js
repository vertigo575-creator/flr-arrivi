import express from "express";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const UI_WINDOW_MINUTES = 35;
const PUSH_WINDOW_MINUTES = 32;
const DISPLAY_TIME_ZONE = "Europe/Rome";
const FR24_URL =
  "https://api.flightradar24.com/common/v1/airport.json?code=flr&plugin[]=schedule&plugin-setting[schedule][mode]=arrivals&page=1&limit=100";

let pollingActive = false;
let pollingTimer = null;
let pollInProgress = false;
let lastPollTime = null;
let lastPollCount = 0;
let lastUiError = null;

// stato per volo
const flightState = new Map();

// fallback semplice per escludere i nazionali
const ITALY_KEYWORDS = [
  "rome",
  "milan",
  "naples",
  "catania",
  "palermo",
  "bari",
  "bologna",
  "pisa",
  "venice",
  "verona",
  "genoa",
  "turin",
  "olbia",
  "alghero",
  "lamezia",
  "brindisi",
  "ancona",
  "trieste",
  "perugia",
  "elba",
  "florence"
];

async function sendPush(message) {
  try {
    await axios.post("https://api.pushover.net/1/messages.json", {
      token: process.env.PUSHOVER_TOKEN,
      user: process.env.PUSHOVER_USER,
      message
    });
    console.log("PUSH:", message);
  } catch (err) {
    console.error("Push error:", err.message);
  }
}

function getFlightId(f) {
  return `${f.numero}::${f.schedulato ?? f.base ?? "na"}`;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isInternationalFlight(f) {
  const origine = normalizeText(f.origine);
  if (!origine) return true;
  return !ITALY_KEYWORDS.some((k) => origine.includes(k));
}

function hasLanded(f) {
  const stato = normalizeText(f.stato);
  return stato.includes("landed") || stato.includes("arrived") || !!f.reale;
}

function isCanceled(f) {
  return normalizeText(f.stato).includes("cancel");
}

function isDiverted(f) {
  return normalizeText(f.stato).includes("divert");
}

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

    const schedulato = flight?.time?.scheduled?.arrival ?? null;
    const stimato = flight?.time?.estimated?.arrival ?? null;
    const reale = flight?.time?.real?.arrival ?? null;
    const base = reale ?? stimato ?? schedulato;

    return {
      numero: flight?.identification?.number?.default ?? "N/A",
      origine: flight?.airport?.origin?.name ?? "N/A",
      stato: flight?.status?.text ?? "",
      schedulato,
      stimato,
      reale,
      base,
      orario_schedulato: formatTime(schedulato),
      orario_stimato: formatTime(stimato),
      orario_reale: formatTime(reale),
      orario_base: formatTime(base)
    };
  });
}

function flightsWithinMinutes(flights, minutes) {
  const now = Date.now();

  return flights.filter((f) => {
    if (!f.base) return false;
    const diff = f.base * 1000 - now;
    return diff > 0 && diff <= minutes * 60 * 1000;
  });
}

function getUiFlights(flights) {
  return flightsWithinMinutes(flights, UI_WINDOW_MINUTES)
    .filter(isInternationalFlight)
    .filter((f) => !isCanceled(f))
    .filter((f) => !isDiverted(f))
    .sort((a, b) => (a.base ?? 0) - (b.base ?? 0));
}

async function getFlights() {
  const res = await axios.get(FR24_URL, {
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
  }
});

  const rows =
    res.data?.result?.response?.airport?.pluginData?.schedule?.arrivals?.data || [];

  return simplifyFlights(rows);
}

function cleanupOldState() {
  const nowSec = Date.now() / 1000;

  for (const [id, state] of flightState.entries()) {
    const ref = state.base ?? state.schedulato ?? 0;
    if (ref && nowSec - ref > 6 * 3600) {
      flightState.delete(id);
    }
  }
}

function getSpokenOrigin(origin) {
  const text = String(origin || "").trim();

  const map = {
    "Zurich Airport": "Zurigo",
    "Amsterdam Schiphol Airport": "Amsterdam",
    "Paris Charles de Gaulle Airport": "Parigi Charles de Gaulle",
    "Paris Orly Airport": "Parigi Orly",
    "London Heathrow Airport": "Londra Heathrow",
    "London Gatwick Airport": "Londra Gatwick",
    "Frankfurt Airport": "Francoforte",
    "Munich Airport": "Monaco di Baviera",
    "Madrid Barajas Airport": "Madrid",
    "Barcelona El Prat Airport": "Barcellona",
    "Vienna International Airport": "Vienna",
    "Brussels Airport": "Bruxelles",
    "Copenhagen Airport": "Copenaghen",
    "Lisbon Airport": "Lisbona",
    "Luxembourg Airport": "Lussemburgo"
  };

  return map[text] || text.replace(/\bAirport\b/gi, "").trim();
}


async function processFlight(f) {
  if (!isInternationalFlight(f)) return;

  const id = getFlightId(f);
  const prev = flightState.get(id) || {
    notified30: false,
    landed: false,
    canceled: false,
    diverted: false
  };

  const spokenOrigin = getSpokenOrigin(f.origine);
  const now = Date.now();

  if (!prev.notified30 && f.base) {
    const diff = f.base * 1000 - now;

    if (
		diff > 0 &&
		diff <= PUSH_WINDOW_MINUTES * 60 * 1000 &&
		!isCanceled(f) &&
		!isDiverted(f)
	) {
      await sendPush(
        `Volo ${f.numero} da ${spokenOrigin}. Arrivo previsto a Firenze alle ${f.orario_base}.`
      );
      prev.notified30 = true;
    }
  }

  if (hasLanded(f) && !prev.landed && prev.notified30) {
    await sendPush(
      `Volo ${f.numero} da ${spokenOrigin}. Atterrato a Firenze.`
    );
    prev.landed = true;
  }

  if (isDiverted(f) && !prev.diverted && prev.notified30) {
    await sendPush(
      `Volo ${f.numero} da ${spokenOrigin}. Dirottato.`
    );
    prev.diverted = true;
  }

  if (isCanceled(f) && !prev.canceled && prev.notified30) {
    await sendPush(
      `Volo ${f.numero} da ${spokenOrigin}. Cancellato.`
    );
    prev.canceled = true;
  }

  flightState.set(id, {
    ...prev,
    base: f.base,
    schedulato: f.schedulato,
    updatedAt: Date.now()
  });
}
async function runPoll() {
  if (pollInProgress) {
    return;
  }

  pollInProgress = true;

  try {
    const flights = await getFlights();
    const next30 = getUiFlights(flights);

    lastPollTime = new Date().toLocaleString("it-IT", {
  timeZone: DISPLAY_TIME_ZONE
	});
    lastPollCount = next30.length;
    lastUiError = null;

    console.log("==== POLL ====");
    console.log("Ora:", lastPollTime);
    console.log("Internazionali entro 30 min:", next30.length);

    for (const f of flights) {
      await processFlight(f);
    }

    cleanupOldState();
  } catch (err) {
    lastUiError = err.message;
    console.error("Poll error:", err.message);
  } finally {
    pollInProgress = false;
  }
}

function startPollingLoop() {
  if (pollingActive) return;

  pollingActive = true;

  runPoll().catch((err) => {
    console.error("Errore primo poll:", err.message);
  });

  pollingTimer = setInterval(() => {
    runPoll().catch((err) => {
      console.error("Errore poll:", err.message);
    });
  }, POLL_INTERVAL_MS);
}

function stopPollingLoop() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  pollingActive = false;
}

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>FLR Arrivi</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 28px 20px 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #000;
      color: #fff;
    }
    h1 {
      font-size: 34px;
      margin: 18px 0 28px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    h2 {
      font-size: 28px;
      margin: 34px 0 18px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .row {
      display: flex;
      gap: 14px;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 18px;
      font-size: 18px;
      padding: 18px 24px;
      min-width: 140px;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
    }
    #start {
      background: #1ea446;
    }
    #stop {
      background: #c83a36;
    }
    .panel {
      margin-top: 10px;
      color: #f5f5f7;
      font-size: 18px;
      line-height: 1.45;
    }
    .small {
      color: #b3b3b8;
      font-size: 16px;
    }
    .card {
      background: #17171a;
      border-radius: 18px;
      padding: 18px 20px;
      margin-bottom: 12px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
    }
    .flight-number {
      font-size: 20px;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .flight-origin {
      font-size: 18px;
      margin-bottom: 8px;
    }
    .error {
      background: #3b1f1f;
      color: #ffd7d7;
    }
  </style>
</head>
<body>
  <h1>FLR Arrivi</h1>

  <div class="row">
    <button id="start">AVVIA</button>
    <button id="stop">FERMA</button>
  </div>

  <div class="panel">
    <div><strong>Stato polling:</strong> <span id="status">...</span></div>
    <div class="small">Ultimo controllo: <span id="lastPollTime">-</span></div>
   <div class="small">Arrivi entro 35 min: <span id="lastPollCount">-</span></div>
  </div>

  <h2>Prossimi 35 minuti</h2>
  <div id="flights"></div>

  <script>
    async function getJson(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || data.message || 'Errore richiesta');
      }

      return data;
    }

    async function refreshHealth() {
      try {
        const data = await getJson('/health');
        document.getElementById('status').textContent = data.pollingActive ? 'ATTIVO' : 'FERMO';
        document.getElementById('lastPollTime').textContent = data.lastPollTime || '-';
        document.getElementById('lastPollCount').textContent = data.lastPollCount ?? '-';
      } catch (err) {
        document.getElementById('status').textContent = 'ERRORE';
      }
    }

    async function refreshFlights() {
      const box = document.getElementById('flights');

      try {
        const data = await getJson('/arrivals-next-30');
        box.innerHTML = '';

        if (data.error) {
          box.innerHTML = '<div class="card error">' + data.error + '</div>';
          return;
        }

        const flights = Array.isArray(data.flights) ? data.flights : [];

        if (flights.length === 0) {
          box.innerHTML = '<div class="card">Nessun arrivo internazionale entro 35 minuti</div>';
          return;
        }

        for (const f of flights) {
          const el = document.createElement('div');
          el.className = 'card';
          el.innerHTML =
            '<div class="flight-number">' + f.numero + '</div>' +
            '<div class="flight-origin">' + f.origine + '</div>' +
            '<div class="small">' + (f.orario_base || '-') + ' • ' + (f.stato || '-') + '</div>';
          box.appendChild(el);
        }
      } catch (err) {
        box.innerHTML = '<div class="card error">Errore caricamento arrivi: ' + err.message + '</div>';
      }
    }

    async function startPolling() {
      try {
        await getJson('/start', { method: 'POST' });
        await refreshHealth();
        await refreshFlights();
      } catch (err) {
        alert(err.message);
      }
    }

    async function stopPolling() {
      try {
        await getJson('/stop', { method: 'POST' });
        await refreshHealth();
      } catch (err) {
        alert(err.message);
      }
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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pollingActive,
    lastPollTime,
    lastPollCount,
    lastUiError
  });
});

app.get("/arrivals", async (req, res) => {
  try {
    const flights = await getFlights();
    res.json({
      ok: true,
      flights
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/arrivals-next-30", async (req, res) => {
  try {
    const flights = await getFlights();
    const next30 = getUiFlights(flights);

    res.json({
      ok: true,
      flights: next30
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/start", async (req, res) => {
  startPollingLoop();
  res.json({
    ok: true,
    message: "Polling avviato"
  });
});

app.post("/stop", (req, res) => {
  stopPollingLoop();
  res.json({
    ok: true,
    message: "Polling fermato"
  });
});

app.listen(PORT, () => {
  console.log(`Server attivo su http://localhost:${PORT}`);
});