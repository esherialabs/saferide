import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

import { corsOriginList, env } from './config/env.js';
import { decodePartnerKey } from './config/partnerKey.js';
import { parseTrustedProxyCidrs, partnerRealmRefusal } from './config/partnerNetwork.js';
import { registerErrorHandler } from './http/errorHandler.js';
import { REQUEST_ID_OPTIONS } from './http/requestId.js';
import { privacySafeSerializers } from './logging/privacySafeSerializers.js';
import { registerRequestContext } from './middleware/requestContext.js';
import { closeDb } from './plugins/db.js';
import { registerMetrics } from './plugins/metrics.js';
import { redis } from './plugins/redis.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerRuntimeConfigRoutes } from './routes/runtimeConfig.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerRsiRoutes } from './routes/rsi.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPartnerApi } from './routes/partnerAuth.js';
import { startScannerHealthMonitor } from './services/clamav/scannerHealth.js';
import { startEvidenceScanWorker } from './services/evidenceMalwareScan.js';
import { partnerPushConfig } from './services/partnerPushProtocol.js';
import { startPartnerPushWorker } from './services/partnerPushWorker.js';

const pushConfig = partnerPushConfig(decodePartnerKey(env.partnerTotpKey));

export async function buildApp() {
  const app: FastifyInstance = Fastify({
    logger: {
      level: env.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.apikey',
          'req.headers.cookie',
          'req.headers.x-api-key',
          'req.headers.x-forwarded-for',
          'request.headers.authorization',
          'request.headers.apikey',
        ],
        censor: '[redacted]',
      },
      serializers: privacySafeSerializers,
    },
    ...REQUEST_ID_OPTIONS,
  });

  registerErrorHandler(app);
  await app.register(cors, { origin: corsOriginList(), credentials: true });
  await app.register(helmet);
  await registerRequestContext(app);
  await registerMetrics(app);
  await registerAuthRoutes(app);
  await registerHealthRoutes(app);
  await registerRuntimeConfigRoutes(app);
  await registerPrivacyRoutes(app);
  await registerRsiRoutes(app);
  await registerCatalogRoutes(app);
  await registerDraftRoutes(app);
  await registerCaseRoutes(app);
  await registerChatRoutes(app);

  // The partner realm is off unless its origin, TOTP key and trusted gateway
  // range are all set; a partial configuration is refused and logged.
  const partnerTotpKey = decodePartnerKey(env.partnerTotpKey);
  const partnerRefusal = partnerRealmRefusal({
    publicOrigin: env.partnerPublicOrigin,
    totpKey: partnerTotpKey,
    trustedProxies: parseTrustedProxyCidrs(env.partnerTrustedProxyCidrs),
  });
  if (partnerRefusal) app.log.error(partnerRefusal);
  if (env.partnerPublicOrigin && partnerTotpKey && !partnerRefusal) {
    await registerPartnerApi(app, {
      publicOrigin: env.partnerPublicOrigin,
      totpKey: partnerTotpKey,
      trustedProxies: parseTrustedProxyCidrs(env.partnerTrustedProxyCidrs),
      callbackKey: decodePartnerKey(env.partnerCallbackKey),
      evidenceDownload: env.partnerEvidenceDownload,
      push: pushConfig,
    });
  }

  return app;
}

const app = await buildApp();

// Evidence malware scanning (ClamAV). Without CLAMD_HOST there is no
// scanner: ingestion stays refused and the worker never claims anything.
const stopScannerMonitor = startScannerHealthMonitor();
const pushWorker = pushConfig ? startPartnerPushWorker(pushConfig, app.log) : null;
const scanWorker = env.clamdHost
  ? startEvidenceScanWorker({ concurrency: env.evidenceScanConcurrency, log: app.log })
  : null;
if (!env.clamdHost) app.log.warn('CLAMD_HOST is not set: evidence malware scanning is off and evidence ingestion is refused');

const shutdown = async () => {
  app.log.info('Shutting down SafeRide API');
  stopScannerMonitor();
  await Promise.race([pushWorker?.stop(), new Promise(resolve => setTimeout(resolve, 13_000).unref())]);
  // An interrupted scan's claim lapses and the attachment is scanned again later.
  await Promise.race([scanWorker?.stop(), new Promise(resolve => setTimeout(resolve, 5_000).unref())]);
  await app.close();
  await closeDb();
  redis.disconnect();
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: env.apiHost, port: env.apiPort });
