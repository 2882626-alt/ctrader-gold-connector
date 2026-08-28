/*
==============================================================================
CTRADER GOLD CONNECTOR
------------------------------------------------------------------------------
Purpose: replace Twelve Data as the source of XAUUSD candle data, using your
own Fusion Markets account via cTrader's Open API. No credits, no daily cap,
no per-minute limit (well within cTrader's 50 req/sec ceiling).

This is a PERSISTENT process — it needs to run continuously somewhere that
supports long-running Node.js (Railway, Render, a small VPS, etc.), NOT on
GreenGeeks shared hosting, which doesn't allow background processes.

Once running, gold.php on your GreenGeeks server should call this instead of
Twelve Data — the JSON shape below matches what gold.php already expects, so
nothing downstream (indicators.php, decision.php, the website) needs to
change.

STATUS: first version, written against cTrader's documented behavior but not
yet tested against a live connection (I can't reach cTrader's servers from
here to test). Expect to debug this together once it's actually running,
the same way we iterated on the PHP files.
==============================================================================
*/

const { CTraderConnection } = require('@reiryoku/ctrader-layer');
const express = require('express');

/*
|------------------------------------------------------------------------
| CONFIG — set these as environment variables wherever you deploy this
|------------------------------------------------------------------------
*/
const CLIENT_ID = process.env.CTRADER_CLIENT_ID || '34806_JUaXTl2gFzOB5k7qg9M5PZl3iPHnkw3TTMocEZv1NpS1ZC9g5T';
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || 'TaYQxpu6NGKgSqGUTHT6ASHSUuwFBeA2RKJJ3EwVhPorW3DBOy';
const ACCESS_TOKEN = process.env.CTRADER_ACCESS_TOKEN || '5a6kiZffk6cxfo-1fPIQ-Cgm61EvOfRq4s40YnhgY4M';
const REFRESH_TOKEN = process.env.CTRADER_REFRESH_TOKEN || 'U0-CEE3jWhCjCft6zMnOhibst99r_4uRtQOnre74xso';
const ACCOUNT_LOGIN = Number(process.env.CTRADER_ACCOUNT_LOGIN || 10123418); // Fusion Markets Demo, matches AthenaBot
const CTRADER_HOST = process.env.CTRADER_HOST || 'demo.ctraderapi.com'; // switch to 'live.ctraderapi.com' for a live account
const CTRADER_PORT = 5035; // Protobuf port — always 5035, per cTrader docs
const HTTP_PORT = process.env.PORT || 3000;
const SYMBOL_NAME = 'XAUUSD';

// How cTrader's trendbar "period" enum maps to gold.php's interval names
const INTERVAL_TO_PERIOD = {
  '1min': 'M1', '5min': 'M5', '15min': 'M15', '30min': 'M30',
  '1h': 'H1', '4h': 'H4', '1day': 'D1',
};

// How many minutes back to request per interval, generous enough for 500+ candles
// (kept modest — very wide ranges for 4h/1day can be rejected by cTrader in a
// single request, which caused the "Failed to refresh 4h/1day" errors)
const LOOKBACK_MINUTES = {
  '1min': 60 * 12, '5min': 60 * 60, '15min': 60 * 24 * 8, '30min': 60 * 24 * 16,
  '1h': 60 * 24 * 25, '4h': 60 * 24 * 90, '1day': 60 * 24 * 500,
};

// cTrader's protobuf library returns 64-bit fields (timestamps, low prices) as
// "Long" objects, not plain numbers. Dividing a Long directly produces garbage
// (this is what caused the garbled prices like 44549900.02 on the first run).
// Number(x) safely converts either a plain number or a Long to a real number.
function toNum(value) {
  return Number(value);
}

let connection = null;
let ctidTraderAccountId = null;
let symbolId = null;
const candleCache = {}; // interval -> gold.php-shaped payload

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/*
|------------------------------------------------------------------------
| CONNECT + AUTHENTICATE
|------------------------------------------------------------------------
*/
async function connectAndAuth() {
  connection = new CTraderConnection({ host: CTRADER_HOST, port: CTRADER_PORT });
  await connection.open();
  log('Socket connected to', CTRADER_HOST);

  await connection.sendCommand('ProtoOAApplicationAuthReq', {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  log('Application authenticated.');

  const accountsRes = await connection.sendCommand('ProtoOAGetAccountListByAccessTokenReq', {
    accessToken: ACCESS_TOKEN,
  });

  const accounts = accountsRes.ctidTraderAccount || accountsRes.accessibleAccounts || [];
  const match = accounts.find(a => Number(a.traderLogin) === ACCOUNT_LOGIN);

  if (!match) {
    throw new Error(
      `Account login ${ACCOUNT_LOGIN} not found in token's account list. ` +
      `Accounts seen: ${accounts.map(a => a.traderLogin).join(', ')}`
    );
  }

  ctidTraderAccountId = match.ctidTraderAccountId;
  log('Matched account. ctidTraderAccountId =', ctidTraderAccountId);

  await connection.sendCommand('ProtoOAAccountAuthReq', {
    ctidTraderAccountId,
    accessToken: ACCESS_TOKEN,
  });
  log('Account session authorized.');

  // Heartbeat — cTrader disconnects idle connections after ~10s without one.
  setInterval(() => {
    connection.sendCommand('ProtoHeartbeatEvent', {}).catch(err => {
      log('Heartbeat failed (non-fatal):', err.message);
    });
  }, 10000);

  await resolveSymbolId();
}

async function resolveSymbolId() {
  const res = await connection.sendCommand('ProtoOASymbolsListReq', { ctidTraderAccountId });
  const list = res.symbol || [];
  const match = list.find(s => String(s.symbolName || '').toUpperCase() === SYMBOL_NAME);

  if (!match) {
    throw new Error(`Symbol ${SYMBOL_NAME} not found. Available: ${list.map(s => s.symbolName).join(', ')}`);
  }

  symbolId = match.symbolId;
  log('Resolved symbolId for', SYMBOL_NAME, '=', symbolId);
}

/*
|------------------------------------------------------------------------
| FETCH TRENDBARS (candles) FOR ONE INTERVAL
|------------------------------------------------------------------------
| cTrader encodes trendbar prices as deltas from "low", scaled by 100000.
| Real price = (low + delta) / 100000. Timestamps are in minutes since epoch.
*/
async function fetchTrendbars(interval) {
  const period = INTERVAL_TO_PERIOD[interval];
  const lookbackMs = LOOKBACK_MINUTES[interval] * 60 * 1000;
  const toTimestamp = Date.now();
  const fromTimestamp = toTimestamp - lookbackMs;

  const res = await connection.sendCommand('ProtoOAGetTrendbarsReq', {
    ctidTraderAccountId,
    symbolId,
    period,
    fromTimestamp,
    toTimestamp,
  });

  const bars = res.trendbar || [];

  const candles = bars.map(bar => {
    const low = toNum(bar.low) / 100000;
    const open = (toNum(bar.low) + toNum(bar.deltaOpen || 0)) / 100000;
    const high = (toNum(bar.low) + toNum(bar.deltaHigh || 0)) / 100000;
    const close = (toNum(bar.low) + toNum(bar.deltaClose || 0)) / 100000;
    const timestampMs = toNum(bar.utcTimestampInMinutes) * 60 * 1000;
    const datetime = new Date(timestampMs).toISOString().slice(0, 19).replace('T', ' ');

    return { datetime, open, high, low, close };
  });

  candles.sort((a, b) => a.datetime.localeCompare(b.datetime));

  const latest = candles[candles.length - 1] || null;

  return {
    success: true,
    provider: 'cTrader (Fusion Markets)',
    symbol: 'XAU/USD',
    symbol_label: 'XAUUSD',
    requested_interval: interval,
    interval,
    generated_at_utc: new Date().toISOString().slice(0, 19).replace('T', ' '),
    latest,
    candles_count: candles.length,
    candles,
    price_notice: 'Live feed via your own cTrader (Fusion Markets) account. No third-party data vendor involved.',
  };
}

/*
|------------------------------------------------------------------------
| REFRESH LOOP — keep the cache warm so HTTP requests are instant
|------------------------------------------------------------------------
*/
const REFRESH_EVERY_MS = {
  '1min': 20000, '5min': 30000, '15min': 60000, '30min': 90000,
  '1h': 180000, '4h': 600000, '1day': 1800000,
};

async function refreshInterval(interval, isRetry = false) {
  try {
    candleCache[interval] = await fetchTrendbars(interval);
    log(`Refreshed ${interval}: ${candleCache[interval].candles_count} candles, latest close ${candleCache[interval].latest?.close}`);
  } catch (err) {
    const message = err && err.message ? err.message : JSON.stringify(err);
    log(`Failed to refresh ${interval}:`, message);

    // If we got rate-limited specifically, wait a bit and try once more —
    // this is normal occasionally, not a sign anything is broken.
    if (!isRetry && message.includes('rate limited')) {
      log(`Retrying ${interval} in 10s after rate limit...`);
      setTimeout(() => refreshInterval(interval, true), 10000);
    }
  }
}

function startRefreshLoops() {
  const intervals = Object.keys(INTERVAL_TO_PERIOD);

  // Stagger the initial fetches instead of firing all 7 at once — cTrader
  // rate-limits bursts of heavy historical requests (this is what caused
  // "BLOCKED_PAYLOAD_TYPE / You are being rate limited" on 4h and 1day,
  // which both request a lot of history in one shot).
  intervals.forEach((interval, index) => {
    setTimeout(() => {
      refreshInterval(interval);
      setInterval(() => refreshInterval(interval), REFRESH_EVERY_MS[interval]);
    }, index * 3000); // 3 seconds apart
  });
}

/*
|------------------------------------------------------------------------
| HTTP SERVER — gold.php will call this instead of Twelve Data
|------------------------------------------------------------------------
*/
const app = express();

app.get('/candles', (req, res) => {
  const interval = String(req.query.interval || '5min');

  if (!INTERVAL_TO_PERIOD[interval]) {
    return res.status(422).json({ success: false, error: 'Unsupported interval.' });
  }

  const cached = candleCache[interval];

  if (!cached) {
    return res.status(503).json({ success: false, error: 'Not ready yet — still fetching initial data.' });
  }

  res.json(cached);
});

app.get('/health', (req, res) => {
  res.json({
    connected: !!connection,
    accountId: ctidTraderAccountId,
    symbolId,
    cachedIntervals: Object.keys(candleCache),
  });
});

/*
|------------------------------------------------------------------------
| STARTUP
|------------------------------------------------------------------------
*/
(async () => {
  try {
    await connectAndAuth();
    startRefreshLoops();
    app.listen(HTTP_PORT, () => log(`HTTP server listening on port ${HTTP_PORT}`));
  } catch (err) {
    log('FATAL startup error:', err.message);
    process.exit(1);
  }
})();
