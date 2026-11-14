/**
 * Central registry of local persistence keys.
 *
 * Every module that touches AsyncStorage / SQLite key-value rows for report
 * data must import its key from here so ownership stays auditable and keys
 * cannot silently drift between writers and readers.
 */

// Report drafts. Native SQLite rows and the active pointer are AES-GCM
// envelopes; these AsyncStorage keys are migration sources and an encrypted
// native fallback only.
export const DRAFT_STORAGE_KEY = 'incident_drafts';
export const ACTIVE_DRAFT_ID_KEY = 'incident_active_draft_id';
export const DRAFT_ROW_ENCRYPTION_KEY_PREFIX = 'incident_draft_records';
export const DRAFT_STORAGE_V2_MIGRATION_STATE_KEY = 'draft_storage_v2_migration_state';

// One-time migration flags.
export const DRAFT_MIGRATION_V1_FLAG_KEY = 'draft_migration_v1_done';

// Offline sync queue + cached offline payloads (encrypted AsyncStorage).
export const SYNC_QUEUE_KEY = '@sync_queue';
export const OFFLINE_DATA_KEY_PREFIX = '@offline_';
export const WORKFLOW_KEY_PREFIX = '@workflow_';

// Chat persistence (encrypted AsyncStorage).
export const CHAT_MESSAGES_KEY = 'chat_messages';
export const CHAT_MESSAGES_KEY_PREFIX = 'chat_messages:';
export const CHAT_LOCAL_SESSIONS_KEY_PREFIX = 'chat_local_sessions:';
export const MESSAGE_RETRY_QUEUE_KEY = 'message_retry_queue';
export const MESSAGE_RETRY_QUEUE_KEY_PREFIX = 'message_retry_queue:';

// Privacy decisions and history (encrypted AsyncStorage).
export const PRIVACY_RETENTION_POLICY_KEY = 'safe_ride_privacy_retention_policy';
export const PRIVACY_CONSENT_LEDGER_KEY = 'safe_ride_privacy_consent_ledger';

// Explicitly consented, content-free moderated-test state (encrypted and
// device-bound; never uploaded by the mobile client).
export const MEASUREMENT_CONSENT_KEY = 'safe_ride_measurement_consent_v1';
export const MEASUREMENT_SESSION_KEY = 'safe_ride_measurement_session_v1';
export const MEASUREMENT_EVENTS_KEY = 'safe_ride_measurement_events_v1';
export const MEASUREMENT_ISSUES_KEY = 'safe_ride_measurement_issues_v1';

// Content-free local AI pilot diagnostics for QA tuned-model builds (encrypted
// and device-bound; never uploaded; exported only after explicit tester consent).
export const AI_PILOT_DIAGNOSTICS_KEY = 'safe_ride_ai_pilot_diagnostics_v1';
export const AI_PILOT_INFLIGHT_KEY = 'safe_ride_ai_pilot_inflight_v1';

// Content-free, device-local assignment for an explicitly approved tuned-model
// rollout. It is never created while the bundled rollout remains disabled.
export const TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY = '@saferide_tuned_artifact_rollout_bucket_v1';

// Legacy SecureStore-backed settings (src/lib/storage.ts).
export const LEGACY_SETTINGS_KEY = 'app_settings';
export const LEGACY_DRAFTS_KEY = 'incident_drafts';
export const LEGACY_USER_DATA_KEY = 'user_data';

// Decoy PIN verifier and its unlock-attempt record (SecureStore). The verifier
// key is also the legacy AsyncStorage location, migrated on read.
export const DECOY_PIN_STORE_KEY = 'safe_ride_decoy_pin';
export const DECOY_PIN_ATTEMPTS_STORE_KEY = 'safe_ride_decoy_pin_attempts';
