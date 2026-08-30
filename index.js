/*
==============================================================================
DG CAPITAL AI — CTRADER GOLD CONNECTOR
XAUUSD LIVE DATA CONNECTOR
==============================================================================
*/

const { CTraderConnection } = require('@reiryoku/ctrader-layer');
const express = require('express');

// ============================================================================
// CONFIGURATION — credentials come from Railway Variables
// ============================================================================

const CLIENT_ID = process.env.CTRADER_CLIENT_ID;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET;
const ACCESS_TOKEN = process.env.CTRADER_ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.CTRADER_REFRESH_TOKEN;

const ACCOUNT_LOGIN = Number(
    process.env.CTRADER_ACCOUNT_LOGIN || 10123418
);

const CTRADER_HOST =
    process.env.CTRADER_HOST || 'demo.ctraderapi.com';

const CTRADER_PORT = 5035;

const HTTP_PORT =
    process.env.PORT || 3000;

const SYMBOL_NAME = 'XAUUSD';


// ============================================================================
// INTERVAL MAPPING
// ============================================================================

const INTERVAL_TO_PERIOD = {

    '1min': 'M1',
    '5min': 'M5',
    '15min': 'M15',
    '30min': 'M30',
    '1h': 'H1',
    '4h': 'H4',
    '1day': 'D1'

};


// ============================================================================
// HISTORY LOOKBACK
//
// IMPORTANT:
//
// M1 and M5 need extra calendar history because weekends contain no gold
// candles. A short calendar lookback can therefore return fewer than the
// 210 candles required by DG Capital AI.
//
// M1 = 60 hours
// M5 = 96 hours
//
// Higher timeframes remain unchanged.
// ============================================================================

const LOOKBACK_MINUTES = {

    '1min': 60 * 60,

    '5min': 60 * 24 * 4,

    '15min': 60 * 24 * 8,

    '30min': 60 * 24 * 16,

    '1h': 60 * 24 * 25,

    '4h': 60 * 24 * 90,

    '1day': 60 * 24 * 500

};


// ============================================================================
// REFRESH SPEED
// ============================================================================

const REFRESH_EVERY_MS = {

    '1min': 20000,

    '5min': 30000,

    '15min': 60000,

    '30min': 90000,

    '1h': 180000,

    '4h': 600000,

    '1day': 1800000

};


// ============================================================================
// STATE
// ============================================================================

let connection = null;

let ctidTraderAccountId = null;

let symbolId = null;

const candleCache = {};


// ============================================================================
// UTILITIES
// ============================================================================

function log(...args) {

    console.log(
        new Date().toISOString(),
        ...args
    );

}


function toNum(value) {

    return Number(value);

}


// ============================================================================
// CONNECT TO CTRADER
// ============================================================================

async function connectAndAuth() {

    if (!CLIENT_ID)
        throw new Error('CTRADER_CLIENT_ID missing from Railway Variables');

    if (!CLIENT_SECRET)
        throw new Error('CTRADER_CLIENT_SECRET missing from Railway Variables');

    if (!ACCESS_TOKEN)
        throw new Error('CTRADER_ACCESS_TOKEN missing from Railway Variables');


    connection = new CTraderConnection({

        host: CTRADER_HOST,

        port: CTRADER_PORT

    });


    await connection.open();


    log(
        'Socket connected to',
        CTRADER_HOST
    );


// ============================================================================
// APPLICATION AUTH
// ============================================================================

    await connection.sendCommand(
        'ProtoOAApplicationAuthReq',
        {

            clientId: CLIENT_ID,

            clientSecret: CLIENT_SECRET

        }
    );


    log(
        'Application authenticated.'
    );


// ============================================================================
// FIND ACCOUNT
// ============================================================================

    const accountsRes =
        await connection.sendCommand(
            'ProtoOAGetAccountListByAccessTokenReq',
            {

                accessToken: ACCESS_TOKEN

            }
        );


    const accounts =
        accountsRes.ctidTraderAccount ||
        accountsRes.accessibleAccounts ||
        [];


    const match =
        accounts.find(
            a =>
                Number(a.traderLogin) ===
                ACCOUNT_LOGIN
        );


    if (!match) {

        throw new Error(

            `Account login ${ACCOUNT_LOGIN} not found. Accounts seen: ` +

            accounts
                .map(a => a.traderLogin)
                .join(', ')

        );

    }


    ctidTraderAccountId =
        match.ctidTraderAccountId;


    log(
        'Matched account.',
        'ctidTraderAccountId =',
        ctidTraderAccountId
    );


// ============================================================================
// ACCOUNT AUTH
// ============================================================================

    await connection.sendCommand(
        'ProtoOAAccountAuthReq',
        {

            ctidTraderAccountId,

            accessToken: ACCESS_TOKEN

        }
    );


    log(
        'Account session authorized.'
    );


// ============================================================================
// HEARTBEAT
// ============================================================================

    setInterval(
        () => {

            if (!connection)
                return;


            connection
                .sendCommand(
                    'ProtoHeartbeatEvent',
                    {}
                )
                .catch(
                    err => {

                        log(
                            'Heartbeat failed:',
                            err.message
                        );

                    }
                );

        },

        10000
    );


    await resolveSymbolId();

}


// ============================================================================
// FIND XAUUSD SYMBOL ID
// ============================================================================

async function resolveSymbolId() {

    const res =
        await connection.sendCommand(
            'ProtoOASymbolsListReq',
            {

                ctidTraderAccountId

            }
        );


    const list =
        res.symbol || [];


    const match =
        list.find(
            s =>
                String(
                    s.symbolName || ''
                )
                .toUpperCase() ===
                SYMBOL_NAME
        );


    if (!match) {

        throw new Error(
            `Symbol ${SYMBOL_NAME} not found.`
        );

    }


    symbolId =
        match.symbolId;


    log(
        'Resolved symbolId for',
        SYMBOL_NAME,
        '=',
        symbolId
    );

}


// ============================================================================
// FETCH CTRADER CANDLES
// ============================================================================

async function fetchTrendbars(interval) {

    const period =
        INTERVAL_TO_PERIOD[interval];


    if (!period) {

        throw new Error(
            `Unsupported interval ${interval}`
        );

    }


    const lookbackMs =

        LOOKBACK_MINUTES[interval] *

        60 *

        1000;


    const toTimestamp =
        Date.now();


    const fromTimestamp =
        toTimestamp -
        lookbackMs;


    const res =
        await connection.sendCommand(
            'ProtoOAGetTrendbarsReq',
            {

                ctidTraderAccountId,

                symbolId,

                period,

                fromTimestamp,

                toTimestamp

            }
        );


    const bars =
        res.trendbar || [];


// ============================================================================
// CONVERT CTRADER PRICE FORMAT
// ============================================================================

    const candles =
        bars.map(
            bar => {

                const low =
                    toNum(bar.low) /
                    100000;


                const open =

                    (
                        toNum(bar.low) +

                        toNum(
                            bar.deltaOpen || 0
                        )
                    ) /

                    100000;


                const high =

                    (
                        toNum(bar.low) +

                        toNum(
                            bar.deltaHigh || 0
                        )
                    ) /

                    100000;


                const close =

                    (
                        toNum(bar.low) +

                        toNum(
                            bar.deltaClose || 0
                        )
                    ) /

                    100000;


                const timestampMs =

                    toNum(
                        bar.utcTimestampInMinutes
                    ) *

                    60 *

                    1000;


                const datetime =

                    new Date(timestampMs)

                        .toISOString()

                        .slice(0, 19)

                        .replace(
                            'T',
                            ' '
                        );


                return {

                    datetime,

                    open,

                    high,

                    low,

                    close

                };

            }
        );


// ============================================================================
// SORT OLDEST → NEWEST
// ============================================================================

    candles.sort(
        (a, b) =>
            a.datetime.localeCompare(
                b.datetime
            )
    );


    const latest =

        candles[
            candles.length - 1
        ] || null;


// ============================================================================
// RESPONSE FORMAT
// ============================================================================

    return {

        success: true,

        provider:
            'cTrader (Fusion Markets)',

        symbol:
            'XAU/USD',

        symbol_label:
            'XAUUSD',

        requested_interval:
            interval,

        interval,

        generated_at_utc:

            new Date()

                .toISOString()

                .slice(0, 19)

                .replace(
                    'T',
                    ' '
                ),

        latest,

        candles_count:
            candles.length,

        candles,

        price_notice:

            'Live feed via cTrader Fusion Markets.'

    };

}


// ============================================================================
// REFRESH ONE TIMEFRAME
// ============================================================================

async function refreshInterval(
    interval,
    isRetry = false
) {

    try {

        const data =
            await fetchTrendbars(
                interval
            );


        // Never destroy good cached data
        // because one temporary request failed.

        if (
            data &&
            data.candles_count > 0
        ) {

            candleCache[interval] =
                data;

        }


        log(

            `Refreshed ${interval}:`,

            `${data.candles_count} candles,`,

            `latest close ${data.latest?.close}`

        );

    }

    catch (err) {

        const message =

            err &&
            err.message

                ? err.message

                : JSON.stringify(
                    err
                );


        log(

            `Failed to refresh ${interval}:`,

            message

        );


        if (
            !isRetry &&
            message
                .toLowerCase()
                .includes(
                    'rate limit'
                )
        ) {

            log(
                `Retrying ${interval} in 10 seconds...`
            );


            setTimeout(
                () =>
                    refreshInterval(
                        interval,
                        true
                    ),

                10000
            );

        }

    }

}


// ============================================================================
// START REFRESH LOOPS
// ============================================================================

function startRefreshLoops() {

    const intervals =
        Object.keys(
            INTERVAL_TO_PERIOD
        );


    intervals.forEach(
        (
            interval,
            index
        ) => {

            // Stagger historical requests.
            // Prevent cTrader burst rate limiting.

            setTimeout(
                async () => {

                    await refreshInterval(
                        interval
                    );


                    setInterval(
                        () =>
                            refreshInterval(
                                interval
                            ),

                        REFRESH_EVERY_MS[
                            interval
                        ]
                    );

                },

                index * 3000
            );

        }
    );

}


// ============================================================================
// HTTP SERVER
// ============================================================================

const app =
    express();


// ============================================================================
// MAIN CANDLE ENDPOINT
// ============================================================================

app.get(
    '/candles',
    (
        req,
        res
    ) => {

        const interval =

            String(
                req.query.interval ||
                '5min'
            );


        if (
            !INTERVAL_TO_PERIOD[
                interval
            ]
        ) {

            return res
                .status(422)
                .json(
                    {

                        success: false,

                        error:
                            'Unsupported interval.'

                    }
                );

        }


        const cached =
            candleCache[
                interval
            ];


        if (!cached) {

            return res
                .status(503)
                .json(
                    {

                        success: false,

                        error:
                            'Not ready yet — still fetching initial data.'

                    }
                );

        }


        res.json(
            cached
        );

    }
);


// ============================================================================
// HEALTH ENDPOINT
// ============================================================================

app.get(
    '/health',
    (
        req,
        res
    ) => {

        const cacheStatus = {};


        for (
            const interval
            of Object.keys(
                candleCache
            )
        ) {

            cacheStatus[
                interval
            ] = {

                candles:

                    candleCache[
                        interval
                    ]
                    ?.candles_count || 0,

                latest:

                    candleCache[
                        interval
                    ]
                    ?.latest
                    ?.datetime || null

            };

        }


        res.json(
            {

                connected:
                    !!connection,

                accountId:
                    ctidTraderAccountId,

                symbolId,

                cachedIntervals:
                    Object.keys(
                        candleCache
                    ),

                cache:
                    cacheStatus

            }
        );

    }
);


// ============================================================================
// ROOT ENDPOINT
// ============================================================================

app.get(
    '/',
    (
        req,
        res
    ) => {

        res.json(
            {

                service:
                    'DG Capital AI cTrader Gold Connector',

                status:
                    connection
                        ? 'ONLINE'
                        : 'STARTING',

                symbol:
                    SYMBOL_NAME,

                account:
                    ACCOUNT_LOGIN

            }
        );

    }
);


// ============================================================================
// START
// ============================================================================

(async () => {

    try {

        log(
            'DG Capital AI Gold Connector starting...'
        );


        await connectAndAuth();


        startRefreshLoops();


        app.listen(
            HTTP_PORT,
            () => {

                log(
                    `HTTP server listening on port ${HTTP_PORT}`
                );

            }
        );

    }

    catch (err) {

        log(
            'FATAL startup error:',
            err.message
        );


        process.exit(1);

    }

})();
