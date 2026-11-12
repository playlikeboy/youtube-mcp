/**
 * Static configuration. No secrets live here: the MCP key, the OAuth client and
 * every refresh token are stored in Script Properties.
 */

const SERVER_INFO = Object.freeze({
  name: 'youtube-mcp-gas',
  title: 'YouTube MCP (Google Apps Script)',
  version: '1.0.0',
});

/** Newest first. The first entry is offered when a client asks for an unknown version. */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const SERVER_INSTRUCTIONS = [
  'Uploads and edits YouTube videos through the YouTube Data API.',
  'Every tool takes an optional "account" alias; omit it to use the default account (see youtube_accounts_list).',
  'Connect more channels with youtube_accounts_connect.',
  'Video uploads are chunked: call youtube_videos_upload, then youtube_videos_upload_continue until status is "completed".',
].join(' ');

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';
const DRIVE_FILES_BASE = 'https://www.googleapis.com/drive/v3/files';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const PROP_KEYS = Object.freeze({
  API_KEY: 'MCP_API_KEY',
  OAUTH_CLIENT_ID: 'OAUTH_CLIENT_ID',
  OAUTH_CLIENT_SECRET: 'OAUTH_CLIENT_SECRET',
  WEBAPP_URL: 'WEBAPP_URL',
  DEFAULT_ACCOUNT: 'DEFAULT_ACCOUNT',
  ACCOUNT_PREFIX: 'YT_ACCOUNT_',
});

const CACHE_KEYS = Object.freeze({
  TOKEN: 'yt_token_',
  OAUTH_STATE: 'oauth_state_',
  UPLOAD: 'upload_',
});

/** Alias of the account that deployed the script; it needs no OAuth client. */
const OWNER_ACCOUNT = 'owner';

/** Scopes requested when an extra channel is connected through OAuth. */
const ACCOUNT_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
]);

const LIMITS = Object.freeze({
  /** Must be a multiple of 256 KiB (resumable upload rule) and below UrlFetchApp's 50 MB cap. */
  UPLOAD_CHUNK_BYTES: 8 * 1024 * 1024,
  DEFAULT_TIME_BUDGET_S: 40,
  MAX_TIME_BUDGET_S: 300,
  /** CacheService maximum (6 hours). */
  UPLOAD_STATE_TTL_S: 21600,
  OAUTH_STATE_TTL_S: 600,
  TOKEN_EXPIRY_MARGIN_S: 120,
  MAX_TOKEN_CACHE_S: 21600,
  MAX_THUMBNAIL_BYTES: 2 * 1024 * 1024,
  ERROR_BODY_PREVIEW_CHARS: 300,
});

const RPC_ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
});

const API_ERROR_HINTS = Object.freeze({
  quotaExceeded: 'The daily YouTube API quota is used up; it resets at midnight Pacific time.',
  insufficientPermissions: 'Reconnect the account so it grants every requested scope.',
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'Reconnect the account so it grants every requested scope.',
  accessNotConfigured: 'Enable this API in the Google Cloud project that issued the token.',
  SERVICE_DISABLED: 'Enable this API in the Google Cloud project that issued the token.',
  youtubeSignupRequired: 'This Google account has no YouTube channel yet.',
  authError: 'The credentials were rejected; reconnect the account.',
  UNAUTHENTICATED: 'The credentials were rejected; reconnect the account.',
});
