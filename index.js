/*
|------------------------------------------------------------------------
| STARTUP
|------------------------------------------------------------------------
*/
(async () => {
  try {
    await connectAndAuth();

    startRefreshLoops();

    app.listen(HTTP_PORT, () => {
      log(`HTTP server listening on port ${HTTP_PORT}`);
    });

  } catch (err) {

    let fullError;

    try {
      if (err instanceof Error) {
        fullError = {
          name: err.name,
          message: err.message,
          stack: err.stack,
          cause: err.cause
        };
      } else if (typeof err === 'object' && err !== null) {
        fullError = err;
      } else {
        fullError = String(err);
      }
    } catch (formatError) {
      fullError = String(err);
    }

    console.error('====================================================');
    console.error('DG CAPITAL AI — CTRADER STARTUP FAILURE');
    console.error('====================================================');
    console.error('RAW ERROR:');
    console.error(err);

    console.error('FORMATTED ERROR:');

    try {
      console.error(JSON.stringify(fullError, null, 2));
    } catch (_) {
      console.error(fullError);
    }

    console.error('====================================================');

    log(
      'FATAL startup error:',
      err?.message ||
      err?.errorCode ||
      err?.code ||
      (() => {
        try {
          return JSON.stringify(err);
        } catch (_) {
          return String(err);
        }
      })()
    );

    process.exit(1);
  }
})();
