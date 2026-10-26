import http from 'node:http';
import { run } from '@grammyjs/runner';
import { buildBot } from './bot.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { logMailerStatus } from './services/mailer.js';
import {
  handleHealthRequest,
  handleResellerApiRequest,
} from './services/resellerApiHttp.js';
import { handleCryptoPayWebhook } from './services/cryptoPayWebhookHttp.js';
import { handleZiniPayWebhook } from './services/zinipayWebhookHttp.js';
import { startSupplierStockSyncLoop } from './services/supplierAutoSync.js';
import { startCryptoPayReconciliationLoop } from './services/cryptoPayReconcile.js';

async function main() {
  const bot = await buildBot();
  logMailerStatus();
  startSupplierStockSyncLoop(bot.api);
  startCryptoPayReconciliationLoop(bot.api);

  const startHttpServer = (telegramHandler?: http.RequestListener) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        if (handleHealthRequest(req, res)) return;
        if (await handleResellerApiRequest(req, res, bot.api)) return;
        if (await handleCryptoPayWebhook(req, res, bot.api)) return;
        if (await handleZiniPayWebhook(req, res, bot.api)) return;
        if (telegramHandler) {
          telegramHandler(req, res);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      })().catch((err) => {
        logger.error({ err }, 'HTTP request handler failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      });
    });
    server.listen(env.PORT, '0.0.0.0', () => {
      logger.info({ port: env.PORT, mode: env.BOT_MODE }, 'HTTP server started');
    });
  };

  if (env.BOT_MODE === 'webhook') {
    if (!env.WEBHOOK_URL) {
      logger.fatal('BOT_MODE=webhook but WEBHOOK_URL is empty');
      process.exit(1);
    }
    const { webhookCallback } = await import('grammy');

    await bot.api.setWebhook(env.WEBHOOK_URL, {
      secret_token: env.WEBHOOK_SECRET || undefined,
    });

    const handler = webhookCallback(bot, 'http', {
      secretToken: env.WEBHOOK_SECRET || undefined,
    });
    startHttpServer(handler);
  } else {
    startHttpServer();
    await bot.api.deleteWebhook({ drop_pending_updates: true });

    logger.info('Starting bot with long-polling (concurrent runner)…');
    const me = await bot.api.getMe();
    logger.info({ username: me.username }, 'Bot is online');

    // Render keeps the previous instance alive until the new one
    // reports healthy. Two long-polling instances sharing one token
    // make Telegram reject the newcomer with:
    //   409 Conflict: terminated by other getUpdates request
    // Crashing here would fail every deploy forever, so instead we
    // keep retrying: the HTTP port is already open, Render marks this
    // instance healthy, retires the old one, and the next attempt
    // succeeds.
    const POLL_RETRY_MS = 5_000;
    const POLL_RETRY_LIMIT = 60; // ~5 minutes of handover tolerance

    const isConflict = (err: unknown): boolean =>
      typeof err === 'object' &&
      err !== null &&
      (err as { error_code?: number }).error_code === 409;

    for (let attempt = 1; ; attempt += 1) {
      const runner = run(bot);
      const stop = async () => {
        if (runner.isRunning()) await runner.stop();
        process.exit(0);
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());

      try {
        await runner.task();
        return; // stopped cleanly
      } catch (err) {
        if (!isConflict(err) || attempt >= POLL_RETRY_LIMIT) throw err;
        logger.warn(
          { attempt },
          'Another instance still polling (409); retrying after handover…',
        );
        await new Promise((r) => setTimeout(r, POLL_RETRY_MS));
      }
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
