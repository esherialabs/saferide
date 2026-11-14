import { FastifyInstance } from 'fastify';

import { env } from '../config/env.js';
import { isCaseSubmissionAdvertised } from '../services/caseSubmissionFeature.js';
import { getPartnerSharingRuntimeConfig } from '../services/partnerSharingFeatures.js';
import { loadPublicTunedArtifactRuntimeConfig } from '../services/tunedArtifactRuntimeConfig.js';

export async function registerRuntimeConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config/runtime', async () => {
    const partnerSharing = getPartnerSharingRuntimeConfig();
    const caseSubmission = isCaseSubmissionAdvertised();
    return {
      environment: env.appEnvironment,
      apiBaseUrl: env.apiPublicBaseUrl,
      wsBaseUrl: env.wsPublicBaseUrl,
      authBaseUrl: env.authPublicBaseUrl,
      storageBaseUrl: env.storagePublicBaseUrl,
      features: {
        ownedApi: true,
        ownedStorage: true,
        ownedRealtime: true,
        remoteTranscription: false,
        // The app sends reports to SafeRide only while this is true (fails closed when absent or stale).
        caseSubmission,
        partnerRouting: caseSubmission && partnerSharing.features.partnerRouting,
        partnerCallback: caseSubmission && partnerSharing.features.partnerCallback,
      },
      partnerConsentVersions: caseSubmission ? partnerSharing.consentVersions : { partner_follow_up: null, partner_callback: null },
      localAi: loadPublicTunedArtifactRuntimeConfig(),
      refreshedAt: new Date().toISOString(),
    };
  });
}
