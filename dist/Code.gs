// ===== 00_config.js =====
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
  'Controls YouTube channels through the YouTube Data, Analytics and Reporting APIs.',
  'Every tool takes an optional "account" alias; omit it to use the default account (see youtube_accounts_list).',
  'Connect more channels with youtube_accounts_connect.',
  'List tools accept "part", "fields", "maxResults" and "pageToken"; pass "fields" to keep responses small.',
  'Video uploads are chunked: call youtube_videos_upload, then youtube_videos_upload_continue until status is "completed".',
  'Anything without a dedicated tool is reachable through youtube_api_request.',
].join(' ');

const API_BASES = Object.freeze({
  data: 'https://www.googleapis.com/youtube/v3',
  analytics: 'https://youtubeanalytics.googleapis.com/v2',
  reporting: 'https://youtubereporting.googleapis.com/v1',
});

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
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.channel-memberships.creator',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
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
  MAX_BANNER_BYTES: 6 * 1024 * 1024,
  MAX_WATERMARK_BYTES: 1024 * 1024,
  ERROR_BODY_PREVIEW_CHARS: 300,
  DEFAULT_ANALYTICS_DAYS: 28,
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

// ===== 01_util.js =====
/** Small pure helpers shared by every other file. */

function isPlainObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns a copy without undefined / null entries. */
function compact_(object) {
  return Object.keys(object || {}).reduce(function (result, key) {
    const value = object[key];
    return value === undefined || value === null ? result : { ...result, [key]: value };
  }, {});
}

function pick_(object, keys) {
  return keys.reduce(function (result, key) {
    return object && object[key] !== undefined ? { ...result, [key]: object[key] } : result;
  }, {});
}

function isEmptyObject_(object) {
  return Object.keys(object).length === 0;
}

/** Arrays become comma-separated lists, which is how the YouTube APIs take multi-values. */
function csv_(value) {
  return Array.isArray(value) ? value.join(',') : String(value);
}

function toQueryString_(query) {
  const source = query || {};
  const pairs = Object.keys(source)
    .filter(function (key) {
      return source[key] !== undefined && source[key] !== null && source[key] !== '';
    })
    .map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(csv_(source[key]));
    });
  return pairs.length > 0 ? '?' + pairs.join('&') : '';
}

/** UrlFetchApp does not normalise header casing, so look names up case-insensitively. */
function findHeader_(headers, name) {
  const wanted = name.toLowerCase();
  const match = Object.keys(headers || {}).filter(function (key) {
    return key.toLowerCase() === wanted;
  })[0];
  return match === undefined ? null : String(headers[match]);
}

function safeJsonParse_(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (ignored) {
    return fallback;
  }
}

/** An error whose message is safe and useful to show to the MCP client. */
function createError_(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

/** An error that maps to a JSON-RPC protocol error instead of a tool result. */
function rpcException_(code, message) {
  const error = new Error(message);
  error.rpcCode = code;
  return error;
}

/** Strips query strings and bearer tokens so capability URLs never reach a client or a log. */
function redactSecrets_(text) {
  return String(text)
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, 'Bearer <redacted>')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '<redacted-token>');
}

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** YYYY-MM-DD (UTC) for the day `days` before `now`. */
function isoDateDaysAgo_(days, now) {
  const base = now ? new Date(now.getTime()) : new Date();
  const millisPerDay = 24 * 60 * 60 * 1000;
  return new Date(base.getTime() - days * millisPerDay).toISOString().slice(0, 10);
}

/** Compares two strings through their SHA-256 digests so timing does not leak the secret. */
function secureEquals_(left, right) {
  const leftDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(left));
  const rightDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(right));
  const difference = leftDigest.reduce(function (acc, byte, index) {
    return acc | (byte ^ rightDigest[index]);
  }, 0);
  return difference === 0;
}

function scriptProps_() {
  return PropertiesService.getScriptProperties();
}

function getProp_(key) {
  return scriptProps_().getProperty(key);
}

function scriptCache_() {
  return CacheService.getScriptCache();
}

// ===== 02_accounts.js =====
/**
 * Account store. "owner" is the Google account that deployed the script and is
 * authorised by Apps Script itself. Every other alias is a channel connected
 * through OAuth whose refresh token is kept in Script Properties.
 */

const ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function assertValidAlias_(alias) {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    throw createError_('Account alias must be 1-40 characters: letters, digits, "_" or "-".');
  }
  return alias;
}

function accountPropKey_(alias) {
  return PROP_KEYS.ACCOUNT_PREFIX + alias;
}

function readAccount_(alias) {
  const raw = getProp_(accountPropKey_(alias));
  return raw ? safeJsonParse_(raw, null) : null;
}

function saveAccount_(alias, record) {
  scriptProps_().setProperty(accountPropKey_(alias), JSON.stringify(record));
}

function getDefaultAlias_() {
  return getProp_(PROP_KEYS.DEFAULT_ACCOUNT) || OWNER_ACCOUNT;
}

/** Public view of every account. Refresh tokens are never included. */
function listAccounts_() {
  const defaultAlias = getDefaultAlias_();
  const prefix = PROP_KEYS.ACCOUNT_PREFIX;
  const connected = scriptProps_()
    .getKeys()
    .filter(function (key) {
      return key.indexOf(prefix) === 0;
    })
    .sort()
    .map(function (key) {
      const alias = key.slice(prefix.length);
      const record = readAccount_(alias) || {};
      return {
        alias: alias,
        type: 'oauth',
        channelId: record.channelId || null,
        channelTitle: record.channelTitle || null,
        connectedAt: record.connectedAt || null,
        isDefault: alias === defaultAlias,
      };
    });
  const owner = { alias: OWNER_ACCOUNT, type: 'script-owner', isDefault: defaultAlias === OWNER_ACCOUNT };
  return [owner].concat(connected);
}

/** Turns an optional alias into a concrete, existing one. */
function resolveAccountAlias_(alias) {
  const resolved = alias || getDefaultAlias_();
  if (resolved === OWNER_ACCOUNT) {
    return resolved;
  }
  assertValidAlias_(resolved);
  if (!readAccount_(resolved)) {
    throw createError_(
      'No connected account named "' + resolved + '". Call youtube_accounts_list to see the available aliases.'
    );
  }
  return resolved;
}

function getAccessToken_(alias) {
  const resolved = resolveAccountAlias_(alias);
  if (resolved === OWNER_ACCOUNT) {
    return ScriptApp.getOAuthToken();
  }
  const cached = scriptCache_().get(CACHE_KEYS.TOKEN + resolved);
  return cached || refreshAccessToken_(resolved, readAccount_(resolved));
}

function refreshAccessToken_(alias, record) {
  const client = getOAuthClient_();
  const tokens = postTokenRequest_(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
    },
    'refresh access for account "' + alias + '" (reconnect it with youtube_accounts_connect if this persists)'
  );
  cacheAccessToken_(alias, tokens);
  return tokens.access_token;
}

function cacheAccessToken_(alias, tokens) {
  const lifetime = Number(tokens.expires_in) || 0;
  const ttl = Math.min(lifetime - LIMITS.TOKEN_EXPIRY_MARGIN_S, LIMITS.MAX_TOKEN_CACHE_S);
  if (ttl > 0) {
    scriptCache_().put(CACHE_KEYS.TOKEN + alias, tokens.access_token, ttl);
  }
}

/** Calls Google's token endpoint. `action` only shapes the error message. */
function postTokenRequest_(form, action) {
  const response = UrlFetchApp.fetch(OAUTH_TOKEN_URL, { method: 'post', payload: form, muteHttpExceptions: true });
  const code = response.getResponseCode();
  const body = safeJsonParse_(response.getContentText(), {}) || {};
  if (code !== 200 || !body.access_token) {
    const reason = body.error_description || body.error || 'HTTP ' + code;
    throw createError_('Could not ' + action + ': ' + reason + '.');
  }
  return body;
}

/** Best effort: tells Google to invalidate a refresh token. Returns whether it worked. */
function revokeToken_(token) {
  const response = UrlFetchApp.fetch(OAUTH_REVOKE_URL, {
    method: 'post',
    payload: { token: token },
    muteHttpExceptions: true,
  });
  return response.getResponseCode() === 200;
}

function removeAccount_(alias) {
  assertValidAlias_(alias);
  const record = readAccount_(alias);
  if (alias === OWNER_ACCOUNT || !record) {
    throw createError_('No connected account named "' + alias + '". The "owner" account cannot be removed.');
  }
  const tokenRevoked = revokeToken_(record.refreshToken);
  scriptProps_().deleteProperty(accountPropKey_(alias));
  scriptCache_().remove(CACHE_KEYS.TOKEN + alias);
  if (getDefaultAlias_() === alias) {
    scriptProps_().deleteProperty(PROP_KEYS.DEFAULT_ACCOUNT);
  }
  return { removed: alias, tokenRevoked: tokenRevoked, defaultAccount: getDefaultAlias_() };
}

function setDefaultAccount_(alias) {
  const resolved = resolveAccountAlias_(assertValidAlias_(alias));
  scriptProps_().setProperty(PROP_KEYS.DEFAULT_ACCOUNT, resolved);
  return { defaultAccount: resolved };
}

// ===== 03_oauth.js =====
/**
 * OAuth flow used to connect additional YouTube channels. The web app URL is the
 * redirect URI, so doGet() receives the authorisation code.
 */

const STATE_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const WEBAPP_URL_PATTERN = /^https:\/\/script\.google\.com\/.+\/exec$/;

function isOAuthConfigured_() {
  return Boolean(getProp_(PROP_KEYS.OAUTH_CLIENT_ID) && getProp_(PROP_KEYS.OAUTH_CLIENT_SECRET));
}

function getOAuthClient_() {
  if (!isOAuthConfigured_()) {
    throw createError_(
      'Connecting extra channels needs an OAuth client. Set the Script Properties OAUTH_CLIENT_ID and ' +
        'OAUTH_CLIENT_SECRET (see the README), then try again.'
    );
  }
  return {
    clientId: getProp_(PROP_KEYS.OAUTH_CLIENT_ID),
    clientSecret: getProp_(PROP_KEYS.OAUTH_CLIENT_SECRET),
  };
}

/** The deployed /exec URL. WEBAPP_URL overrides auto-detection when it guesses wrong. */
function getWebAppUrl_() {
  const url = getProp_(PROP_KEYS.WEBAPP_URL) || ScriptApp.getService().getUrl() || '';
  if (!WEBAPP_URL_PATTERN.test(url)) {
    throw createError_(
      'The web app URL is unknown. Deploy the script as a web app, or set the Script Property WEBAPP_URL ' +
        'to the deployment URL ending in /exec.'
    );
  }
  return url;
}

/** Creates a single-use consent link bound to `alias` for a few minutes. */
function buildAuthUrl_(alias) {
  const client = getOAuthClient_();
  const state = Utilities.getUuid();
  const authUrl =
    OAUTH_AUTH_URL +
    toQueryString_({
      client_id: client.clientId,
      redirect_uri: getWebAppUrl_(),
      response_type: 'code',
      scope: ACCOUNT_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      state: state,
    });
  scriptCache_().put(CACHE_KEYS.OAUTH_STATE + state, alias, LIMITS.OAUTH_STATE_TTL_S);
  return authUrl;
}

function startAccountConnection_(alias) {
  assertValidAlias_(alias);
  if (alias === OWNER_ACCOUNT) {
    throw createError_('"owner" is reserved for the account that deployed the script. Pick another alias.');
  }
  return {
    alias: alias,
    authUrl: buildAuthUrl_(alias),
    expiresInMinutes: LIMITS.OAUTH_STATE_TTL_S / 60,
    instructions:
      'Open authUrl in a browser, sign in, pick the channel (brand channels appear in the picker) and approve. ' +
      'Afterwards the channel is available as account "' + alias + '".',
  };
}

/** Consumes the single-use state value and returns the alias it was issued for. */
function consumeOAuthState_(state) {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
    return null;
  }
  const key = CACHE_KEYS.OAUTH_STATE + state;
  const alias = scriptCache_().get(key);
  scriptCache_().remove(key);
  return alias || null;
}

function exchangeAuthCode_(code) {
  const client = getOAuthClient_();
  return postTokenRequest_(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: code,
      redirect_uri: getWebAppUrl_(),
      grant_type: 'authorization_code',
    },
    'complete the authorisation'
  );
}

function fetchOwnChannel_(accessToken) {
  const url = API_BASES.data + '/channels' + toQueryString_({ part: 'snippet', mine: true });
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true,
  });
  const body = parseApiResponse_(response, false);
  const channel = (body.items || [])[0];
  if (!channel) {
    throw createError_('That Google account has no YouTube channel.');
  }
  return { channelId: channel.id, channelTitle: (channel.snippet || {}).title || '' };
}

/** Handles the redirect from Google. Returns { ok, heading, detail } for the result page. */
function handleOAuthCallback_(params) {
  const alias = consumeOAuthState_(params.state);
  if (!alias) {
    return oauthOutcome_(false, 'Link expired', 'This link is invalid or was already used. Request a new one.');
  }
  if (params.error || !params.code) {
    return oauthOutcome_(false, 'Not connected', 'Authorisation was not granted (' + (params.error || 'no code') + ').');
  }
  try {
    const channel = storeConnectedAccount_(alias, exchangeAuthCode_(params.code));
    return oauthOutcome_(true, 'Channel connected', '"' + channel.channelTitle + '" is now available as "' + alias + '".');
  } catch (error) {
    console.error('OAuth callback failed: ' + redactSecrets_(error.message));
    const detail = error.userFacing ? redactSecrets_(error.message) : 'Unexpected error. Check the execution log.';
    return oauthOutcome_(false, 'Not connected', detail);
  }
}

function storeConnectedAccount_(alias, tokens) {
  if (!tokens.refresh_token) {
    throw createError_(
      'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and try again.'
    );
  }
  const channel = fetchOwnChannel_(tokens.access_token);
  saveAccount_(alias, {
    refreshToken: tokens.refresh_token,
    channelId: channel.channelId,
    channelTitle: channel.channelTitle,
    connectedAt: new Date().toISOString(),
  });
  cacheAccessToken_(alias, tokens);
  return channel;
}

function oauthOutcome_(ok, heading, detail) {
  return { ok: ok, heading: heading, detail: detail };
}

function renderPage_(heading, detail) {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;' +
    'line-height:1.5}</style></head><body><h1>' + escapeHtml_(heading) + '</h1><p>' + escapeHtml_(detail) +
    '</p></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('YouTube MCP');
}

// ===== 04_http.js =====
/** Thin client for the YouTube Data, Analytics and Reporting REST APIs. */

function buildApiUrl_(api, path, query) {
  const base = API_BASES[api];
  if (!base) {
    throw createError_('Unknown API "' + api + '". Use one of: ' + Object.keys(API_BASES).join(', ') + '.');
  }
  return base + path + toQueryString_(query);
}

function authHeaders_(account) {
  return { Authorization: 'Bearer ' + getAccessToken_(account) };
}

/**
 * Sends one API request.
 * req: { api?, method?, path, query?, body?, account?, raw? }
 * Returns the parsed JSON, { success: true } for empty responses, or
 * { content } when req.raw is set (caption downloads are not JSON).
 */
function ytRequest_(req) {
  const hasBody = req.body !== undefined && req.body !== null;
  const options = compact_({
    method: String(req.method || 'GET').toLowerCase(),
    headers: authHeaders_(req.account),
    muteHttpExceptions: true,
    contentType: hasBody ? 'application/json' : undefined,
    payload: hasBody ? JSON.stringify(req.body) : undefined,
  });
  const url = buildApiUrl_(req.api || 'data', req.path, req.query);
  return parseApiResponse_(UrlFetchApp.fetch(url, options), req.raw === true);
}

/**
 * Uploads media bytes (thumbnails, banners, captions, watermarks).
 * req: { method?, path, query?, contentType, payload, account? }
 */
function uploadMedia_(req) {
  const url = UPLOAD_BASE + req.path + toQueryString_(req.query);
  const response = UrlFetchApp.fetch(url, {
    method: String(req.method || 'POST').toLowerCase(),
    headers: authHeaders_(req.account),
    contentType: req.contentType,
    payload: req.payload,
    muteHttpExceptions: true,
  });
  return parseApiResponse_(response, false);
}

function parseApiResponse_(response, raw) {
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw createError_(describeApiError_(code, text));
  }
  if (raw) {
    return { content: text };
  }
  return text ? safeJsonParse_(text, { content: text }) : { success: true };
}

/** Builds a readable message from Google's error envelope, with a hint when one is known. */
function describeApiError_(code, text) {
  const parsed = safeJsonParse_(text, null);
  const error = parsed && parsed.error;
  if (!isPlainObject_(error)) {
    const preview = String(text || '').slice(0, LIMITS.ERROR_BODY_PREVIEW_CHARS) || 'no details';
    return 'YouTube API error ' + code + ': ' + preview;
  }
  const first = (error.errors || [])[0] || {};
  const reason = first.reason || error.status || 'unknown';
  const hint = API_ERROR_HINTS[reason];
  const message = error.message || 'no message';
  return 'YouTube API error ' + code + ' (' + reason + '): ' + message + (hint ? ' Hint: ' + hint : '');
}

/** Fetches exactly one resource by id or fails with a clear message. */
function getSingleItem_(path, id, part, account, label) {
  const result = ytRequest_({ path: path, query: { part: part, id: id }, account: account });
  const item = (result.items || [])[0];
  if (!item) {
    throw createError_(label + ' "' + id + '" was not found or is not accessible to this account.');
  }
  return item;
}

/** The given channel, or the authenticated account's own channel when no id is given. */
function getChannel_(channelId, part, account) {
  if (channelId) {
    return getSingleItem_('/channels', channelId, part, account, 'Channel');
  }
  const result = ytRequest_({ path: '/channels', query: { part: part, mine: true }, account: account });
  const channel = (result.items || [])[0];
  if (!channel) {
    throw createError_('This account has no YouTube channel.');
  }
  return channel;
}

/**
 * Read-merge-write update. YouTube replaces a whole part on update, so the
 * current values of the mutable fields are fetched and overlaid with the changes.
 * spec: { path, id, account, label, parts: { partName: { fields, changes } } }
 */
function mergeUpdate_(spec) {
  const parts = Object.keys(spec.parts).filter(function (part) {
    return !isEmptyObject_(spec.parts[part].changes);
  });
  if (parts.length === 0) {
    throw createError_('Provide at least one field to change.');
  }
  const partList = parts.join(',');
  const existing = getSingleItem_(spec.path, spec.id, partList, spec.account, spec.label);
  const body = parts.reduce(
    function (result, part) {
      const current = compact_(pick_(existing[part] || {}, spec.parts[part].fields));
      return { ...result, [part]: { ...current, ...spec.parts[part].changes } };
    },
    { id: spec.id }
  );
  return ytRequest_({ method: 'PUT', path: spec.path, query: { part: partList }, body: body, account: spec.account });
}

function partChanges_(args, fields) {
  return { fields: fields, changes: compact_(pick_(args, fields)) };
}

// ===== 05_media.js =====
/**
 * Media sources. A file comes either from the script owner's Google Drive
 * ("driveFileId") or from a public https URL ("url").
 */

const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

/** Validates the driveFileId / url pair and returns { kind, ref }. */
function pickSource_(args) {
  const hasDrive = Boolean(args.driveFileId);
  const hasUrl = Boolean(args.url);
  if (hasDrive === hasUrl) {
    throw createError_('Provide exactly one of "driveFileId" or "url".');
  }
  if (hasDrive) {
    if (!DRIVE_ID_PATTERN.test(args.driveFileId)) {
      throw createError_('"driveFileId" is not a valid Google Drive file ID.');
    }
    return { kind: 'drive', ref: args.driveFileId };
  }
  if (!/^https:\/\/[^\s]+$/i.test(args.url)) {
    throw createError_('"url" must be an https:// URL.');
  }
  return { kind: 'url', ref: args.url };
}

function driveFetch_(fileId, query, headers) {
  const url = DRIVE_FILES_BASE + '/' + encodeURIComponent(fileId) + toQueryString_(query);
  return UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { ...headers, Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
}

/** GETs the source, optionally a byte range of it. */
function fetchSource_(source, range) {
  const headers = range ? { Range: range } : {};
  if (source.kind === 'drive') {
    return driveFetch_(source.ref, { alt: 'media', supportsAllDrives: true }, headers);
  }
  return UrlFetchApp.fetch(source.ref, { method: 'get', headers: headers, muteHttpExceptions: true });
}

/** Adds size and mimeType to a source so it can be uploaded in ranges. */
function describeSource_(source) {
  const info = source.kind === 'drive' ? describeDriveFile_(source) : probeUrl_(source);
  if (!(info.size > 0)) {
    throw createError_('The source file is empty or its size could not be determined.');
  }
  return info;
}

function describeDriveFile_(source) {
  const response = driveFetch_(source.ref, { fields: 'name,size,mimeType', supportsAllDrives: true }, {});
  if (response.getResponseCode() !== 200) {
    throw createError_(
      'Could not read Drive file (HTTP ' + response.getResponseCode() + '). It must be readable by the script owner.'
    );
  }
  const meta = safeJsonParse_(response.getContentText(), {}) || {};
  return { ...source, size: Number(meta.size), mimeType: meta.mimeType || 'application/octet-stream' };
}

/** Asks for the first byte to learn the total size and confirm range support. */
function probeUrl_(source) {
  const response = fetchSource_(source, 'bytes=0-0');
  const contentRange = findHeader_(response.getHeaders(), 'Content-Range') || '';
  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (response.getResponseCode() !== 206 || !match) {
    throw createError_(
      'That URL does not support HTTP range requests, which chunked uploads need. Put the file in Google Drive ' +
        'and pass "driveFileId" instead.'
    );
  }
  const mimeType = (findHeader_(response.getHeaders(), 'Content-Type') || 'application/octet-stream').split(';')[0];
  return { ...source, size: Number(match[1]), mimeType: mimeType.trim() };
}

/** Returns bytes start..end (inclusive) of a described source. */
function fetchSourceRange_(source, start, end) {
  const response = fetchSource_(source, 'bytes=' + start + '-' + end);
  const code = response.getResponseCode();
  const bytes = code === 206 || code === 200 ? response.getContent() : [];
  if (bytes.length !== end - start + 1) {
    throw createError_('Could not read bytes ' + start + '-' + end + ' of the source (HTTP ' + code + ').');
  }
  return bytes;
}

/** Downloads a small file (image) in one request. */
function fetchSourceBlob_(source, maxBytes) {
  const response = fetchSource_(source, null);
  if (response.getResponseCode() !== 200) {
    throw createError_('Could not download the source file (HTTP ' + response.getResponseCode() + ').');
  }
  const bytes = response.getContent();
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw createError_('The file must be between 1 byte and ' + maxBytes + ' bytes; it is ' + bytes.length + '.');
  }
  const mimeType = (findHeader_(response.getHeaders(), 'Content-Type') || 'application/octet-stream').split(';')[0];
  return { bytes: bytes, mimeType: mimeType.trim() };
}

function toBytes_(text) {
  return Utilities.newBlob(text).getBytes();
}

/** Builds a multipart/related body: JSON metadata followed by the media bytes. */
function buildMultipartRelated_(metadata, mediaBytes, mediaType) {
  const boundary = 'ytmcp' + Utilities.getUuid().replace(/-/g, '');
  const head =
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
    '\r\n--' + boundary + '\r\nContent-Type: ' + mediaType + '\r\n\r\n';
  const tail = '\r\n--' + boundary + '--';
  return {
    contentType: 'multipart/related; boundary=' + boundary,
    payload: toBytes_(head).concat(mediaBytes, toBytes_(tail)),
  };
}

// ===== 06_upload.js =====
/**
 * Resumable video upload. Apps Script cannot hold a large file in memory or run
 * for long, so the video is streamed chunk by chunk from the source. One call
 * uploads as many chunks as fit in its time budget; the rest is picked up by
 * youtube_videos_upload_continue using state kept in the script cache.
 */

function buildVideoResource_(args) {
  return {
    snippet: compact_({
      title: args.title,
      description: args.description,
      tags: args.tags,
      categoryId: args.categoryId || '22',
      defaultLanguage: args.defaultLanguage,
    }),
    status: compact_({
      privacyStatus: args.privacyStatus || 'private',
      publishAt: args.publishAt,
      selfDeclaredMadeForKids: args.selfDeclaredMadeForKids === true,
      embeddable: args.embeddable,
      license: args.license,
      containsSyntheticMedia: args.containsSyntheticMedia,
    }),
  };
}

/** Opens a resumable session and returns its upload URL. */
function openUploadSession_(resource, source, account, notifySubscribers) {
  const url =
    UPLOAD_BASE +
    '/videos' +
    toQueryString_({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: notifySubscribers });
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      ...authHeaders_(account),
      'X-Upload-Content-Type': source.mimeType,
      'X-Upload-Content-Length': String(source.size),
    },
    payload: JSON.stringify(resource),
    muteHttpExceptions: true,
  });
  const sessionUrl = findHeader_(response.getHeaders(), 'Location');
  if (response.getResponseCode() !== 200 || !sessionUrl) {
    throw createError_(describeApiError_(response.getResponseCode(), response.getContentText()));
  }
  return sessionUrl;
}

function startVideoUpload_(args) {
  const source = describeSource_(pickSource_(args));
  const account = resolveAccountAlias_(args.account);
  const sessionUrl = openUploadSession_(buildVideoResource_(args), source, account, args.notifySubscribers);
  const state = { id: Utilities.getUuid(), sessionUrl: sessionUrl, source: source, account: account, offset: 0 };
  return runUpload_(state, args.timeBudgetSeconds);
}

function resumeVideoUpload_(args) {
  const raw = scriptCache_().get(CACHE_KEYS.UPLOAD + args.uploadId);
  const state = raw ? safeJsonParse_(raw, null) : null;
  if (!state) {
    throw createError_('Unknown or expired uploadId. Start again with youtube_videos_upload.');
  }
  return runUpload_(state, args.timeBudgetSeconds);
}

function saveUploadState_(state) {
  scriptCache_().put(CACHE_KEYS.UPLOAD + state.id, JSON.stringify(state), LIMITS.UPLOAD_STATE_TTL_S);
}

function clampBudgetSeconds_(seconds) {
  const wanted = Number(seconds) || LIMITS.DEFAULT_TIME_BUDGET_S;
  return Math.max(1, Math.min(wanted, LIMITS.MAX_TIME_BUDGET_S));
}

/** Uploads chunks until the video is complete or the time budget is spent. */
function runUpload_(initialState, budgetSeconds) {
  const deadline = Date.now() + clampBudgetSeconds_(budgetSeconds) * 1000;
  let state = initialState;
  saveUploadState_(state);
  do {
    state = uploadChunkOrExplain_(state);
    saveUploadState_(state);
  } while (!state.video && Date.now() < deadline);
  if (state.video) {
    scriptCache_().remove(CACHE_KEYS.UPLOAD + state.id);
  }
  return uploadProgress_(state);
}

/** Adds the uploadId to failures so the caller knows the upload can be resumed. */
function uploadChunkOrExplain_(state) {
  try {
    return uploadNextChunk_(state);
  } catch (error) {
    throw createError_(
      redactSecrets_(error.message) + ' Upload "' + state.id + '" kept its progress (' + state.offset +
        ' bytes); retry with youtube_videos_upload_continue.'
    );
  }
}

/** Sends one chunk and returns the next state (with `video` once YouTube has the whole file). */
function uploadNextChunk_(state) {
  const size = state.source.size;
  const end = Math.min(state.offset + LIMITS.UPLOAD_CHUNK_BYTES, size) - 1;
  const bytes = fetchSourceRange_(state.source, state.offset, end);
  const response = UrlFetchApp.fetch(state.sessionUrl, {
    method: 'put',
    contentType: state.source.mimeType,
    headers: { ...authHeaders_(state.account), 'Content-Range': 'bytes ' + state.offset + '-' + end + '/' + size },
    payload: bytes,
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const code = response.getResponseCode();
  if (code === 308) {
    return { ...state, offset: nextOffset_(response) };
  }
  if (code === 200 || code === 201) {
    return { ...state, offset: size, video: safeJsonParse_(response.getContentText(), {}) };
  }
  throw createError_(describeApiError_(code, response.getContentText()));
}

/** A 308 reply carries "Range: bytes=0-N"; the next byte to send is N + 1. */
function nextOffset_(response) {
  const match = /-(\d+)\s*$/.exec(findHeader_(response.getHeaders(), 'Range') || '');
  return match ? Number(match[1]) + 1 : 0;
}

function uploadProgress_(state) {
  const total = state.source.size;
  if (state.video) {
    const videoId = state.video.id;
    return { status: 'completed', videoId: videoId, url: 'https://www.youtube.com/watch?v=' + videoId, video: state.video };
  }
  return {
    status: 'in_progress',
    uploadId: state.id,
    bytesUploaded: state.offset,
    totalBytes: total,
    percent: Math.floor((state.offset / total) * 100),
    next: 'Call youtube_videos_upload_continue with this uploadId until status is "completed".',
  };
}

// ===== 10_registry.js =====
/** Tool definition helpers, argument validation and the tool registry. */

function strProp_(description, enumValues) {
  return compact_({ type: 'string', description: description, enum: enumValues });
}

function intProp_(description, minimum, maximum) {
  return compact_({ type: 'integer', description: description, minimum: minimum, maximum: maximum });
}

function boolProp_(description) {
  return { type: 'boolean', description: description };
}

function listProp_(description) {
  return { type: 'array', items: { type: 'string' }, description: description };
}

function objProp_(description) {
  return { type: 'object', description: description };
}

const ACCOUNT_PROP = strProp_('Alias of the connected account to act as. Omit for the default account.');

const SOURCE_PROPS = Object.freeze({
  driveFileId: strProp_("ID of a file in the script owner's Google Drive. Use this or \"url\"."),
  url: strProp_('Public https:// URL of the file. Use this or "driveFileId".'),
});

const PRIVACY_VALUES = Object.freeze(['private', 'unlisted', 'public']);

/** part / fields / maxResults / pageToken, shared by every list tool. */
function listProps_(defaultPart, maxPageSize) {
  return {
    part: strProp_('Resource parts to return, comma-separated. Default: ' + defaultPart + '.'),
    fields: strProp_('Partial-response selector to shrink the result, e.g. "items(id,snippet/title),nextPageToken".'),
    maxResults: intProp_('Page size, 1-' + maxPageSize + '.', 1, maxPageSize),
    pageToken: strProp_('nextPageToken (or prevPageToken) from an earlier call.'),
  };
}

function listQuery_(args, defaultPart, extra) {
  return {
    part: args.part || defaultPart,
    fields: args.fields,
    maxResults: args.maxResults,
    pageToken: args.pageToken,
    ...extra,
  };
}

const ANNOTATIONS_BY_KIND = Object.freeze({
  read: { readOnlyHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
});

/**
 * spec: { name, title, description, kind: 'read'|'write'|'delete', props, required?, noAccount?, handler }
 * Every tool gets the optional "account" argument unless noAccount is set.
 */
function defineTool_(spec) {
  const properties = spec.noAccount ? { ...spec.props } : { ...spec.props, account: ACCOUNT_PROP };
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: properties,
      required: spec.required || [],
      additionalProperties: false,
    },
    annotations: ANNOTATIONS_BY_KIND[spec.kind],
    handler: spec.handler,
  };
}

/** A tool that maps straight onto one REST call. spec.request(args) returns the ytRequest_ input. */
function apiTool_(spec) {
  return defineTool_({
    ...spec,
    handler: function (args) {
      return ytRequest_({ ...spec.request(args), account: args.account });
    },
  });
}

function allTools_() {
  return [].concat(
    accountTools_(),
    channelTools_(),
    videoTools_(),
    playlistTools_(),
    commentTools_(),
    communityTools_(),
    liveTools_(),
    analyticsTools_()
  );
}

function findTool_(name) {
  const matches = allTools_().filter(function (tool) {
    return tool.name === name;
  });
  return matches[0] || null;
}

/** The tool as advertised by tools/list (no handler). */
function describeTool_(tool) {
  return pick_(tool, ['name', 'title', 'description', 'inputSchema', 'annotations']);
}

function matchesType_(type, value) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return isPlainObject_(value);
  if (type === 'array') {
    return Array.isArray(value) && value.every(function (item) { return typeof item === 'string'; });
  }
  return false;
}

function checkArgument_(name, prop, value) {
  if (!matchesType_(prop.type, value)) {
    return 'Argument "' + name + '" must be ' + (prop.type === 'array' ? 'an array of strings' : 'of type ' + prop.type) + '.';
  }
  if (prop.enum && prop.enum.indexOf(value) === -1) {
    return 'Argument "' + name + '" must be one of: ' + prop.enum.join(', ') + '.';
  }
  const belowMin = prop.minimum !== undefined && value < prop.minimum;
  const aboveMax = prop.maximum !== undefined && value > prop.maximum;
  if (belowMin || aboveMax) {
    return 'Argument "' + name + '" must be between ' + prop.minimum + ' and ' + prop.maximum + '.';
  }
  return null;
}

/** Returns a list of problems; an empty list means the arguments are valid. */
function validateArgs_(schema, args) {
  const props = schema.properties;
  const names = Object.keys(args);
  const missing = schema.required
    .filter(function (name) { return args[name] === undefined || args[name] === ''; })
    .map(function (name) { return 'Missing required argument "' + name + '".'; });
  const unknown = names
    .filter(function (name) { return !Object.prototype.hasOwnProperty.call(props, name); })
    .map(function (name) { return 'Unknown argument "' + name + '".'; });
  const invalid = names
    .filter(function (name) { return Object.prototype.hasOwnProperty.call(props, name); })
    .map(function (name) { return checkArgument_(name, props[name], args[name]); })
    .filter(Boolean);
  return missing.concat(unknown, invalid);
}

// ===== 11_tools_accounts.js =====
/** Tools that manage which YouTube channels this server can act as. */

function accountTools_() {
  const aliasProp = strProp_('Short name for the account: letters, digits, "_" or "-".');
  return [
    defineTool_({
      name: 'youtube_accounts_list',
      title: 'List connected accounts',
      description:
        'List the YouTube accounts this server can act as. "owner" is the Google account that deployed the ' +
        'script; the others were added with youtube_accounts_connect. Shows which one is the default.',
      kind: 'read',
      noAccount: true,
      props: {},
      handler: function () {
        return { accounts: listAccounts_(), oauthClientConfigured: isOAuthConfigured_() };
      },
    }),
    defineTool_({
      name: 'youtube_accounts_connect',
      title: 'Connect a YouTube channel',
      description:
        'Start connecting another YouTube channel (any Google account or brand channel). Returns an authUrl the ' +
        'channel owner must open in a browser to approve access. Reusing an alias replaces that connection.',
      kind: 'write',
      noAccount: true,
      props: { alias: aliasProp },
      required: ['alias'],
      handler: function (args) {
        return startAccountConnection_(args.alias);
      },
    }),
    defineTool_({
      name: 'youtube_accounts_remove',
      title: 'Disconnect a YouTube channel',
      description: 'Remove a connected account and revoke its stored refresh token. The "owner" account cannot be removed.',
      kind: 'delete',
      noAccount: true,
      props: { alias: aliasProp },
      required: ['alias'],
      handler: function (args) {
        return removeAccount_(args.alias);
      },
    }),
    defineTool_({
      name: 'youtube_accounts_set_default',
      title: 'Set the default account',
      description: 'Choose which account is used when a tool call has no "account" argument. Use "owner" for the script owner.',
      kind: 'write',
      noAccount: true,
      props: { alias: aliasProp },
      required: ['alias'],
      handler: function (args) {
        return setDefaultAccount_(args.alias);
      },
    }),
  ];
}

// ===== 12_tools_channels.js =====
/** Channel details, branding, sections, banner and watermark. */

const CHANNEL_PARTS = 'snippet,statistics,contentDetails,status,brandingSettings';
const CHANNEL_BRANDING_FIELDS = Object.freeze(['description', 'keywords', 'country', 'defaultLanguage', 'unsubscribedTrailer']);
const SECTION_PARTS = 'snippet,contentDetails';

function channelFilter_(args) {
  if (args.id) return { id: args.id };
  if (args.forHandle) return { forHandle: args.forHandle };
  if (args.forUsername) return { forUsername: args.forUsername };
  return { mine: true };
}

function updateChannel_(args) {
  const changes = compact_(pick_(args, CHANNEL_BRANDING_FIELDS));
  const setsKids = args.selfDeclaredMadeForKids !== undefined;
  if (isEmptyObject_(changes) && !setsKids) {
    throw createError_('Provide at least one field to change.');
  }
  const existing = getChannel_(args.channelId, 'brandingSettings', args.account);
  const branding = existing.brandingSettings || {};
  const body = {
    id: existing.id,
    brandingSettings: { ...branding, channel: { ...(branding.channel || {}), ...changes } },
    ...(setsKids ? { status: { selfDeclaredMadeForKids: args.selfDeclaredMadeForKids } } : {}),
  };
  const part = setsKids ? 'brandingSettings,status' : 'brandingSettings';
  return ytRequest_({ method: 'PUT', path: '/channels', query: { part: part }, body: body, account: args.account });
}

function setChannelBanner_(args) {
  const image = fetchSourceBlob_(pickSource_(args), LIMITS.MAX_BANNER_BYTES);
  const uploaded = uploadMedia_({
    path: '/channelBanners/insert',
    query: { uploadType: 'media' },
    contentType: image.mimeType,
    payload: image.bytes,
    account: args.account,
  });
  const existing = getChannel_(args.channelId, 'brandingSettings', args.account);
  const branding = existing.brandingSettings || {};
  const body = {
    id: existing.id,
    brandingSettings: { ...branding, image: { ...(branding.image || {}), bannerExternalUrl: uploaded.url } },
  };
  return ytRequest_({ method: 'PUT', path: '/channels', query: { part: 'brandingSettings' }, body: body, account: args.account });
}

function setWatermark_(args) {
  const channel = getChannel_(args.channelId, 'id', args.account);
  const image = fetchSourceBlob_(pickSource_(args), LIMITS.MAX_WATERMARK_BYTES);
  const metadata = {
    timing: compact_({
      type: args.timingType || 'offsetFromStart',
      offsetMs: args.offsetMs === undefined ? 0 : args.offsetMs,
      durationMs: args.durationMs,
    }),
    position: { type: 'corner', cornerPosition: 'topRight' },
  };
  const multipart = buildMultipartRelated_(metadata, image.bytes, image.mimeType);
  return uploadMedia_({
    path: '/watermarks/set',
    query: { channelId: channel.id, uploadType: 'multipart' },
    contentType: multipart.contentType,
    payload: multipart.payload,
    account: args.account,
  });
}

function sectionRequest_(method, args) {
  const details = compact_({ playlists: args.playlists, channels: args.channels });
  const hasDetails = !isEmptyObject_(details);
  const body = compact_({
    id: args.sectionId,
    snippet: compact_({ type: args.type, title: args.title, position: args.position }),
    contentDetails: hasDetails ? details : undefined,
  });
  return { method: method, path: '/channelSections', query: { part: hasDetails ? SECTION_PARTS : 'snippet' }, body: body };
}

function sectionProps_() {
  return {
    type: strProp_('Section type, e.g. singlePlaylist, multiplePlaylists, multipleChannels, recentUploads, popularUploads.'),
    title: strProp_('Section title (needed for multiplePlaylists / multipleChannels).'),
    position: intProp_('Zero-based position on the channel page.', 0),
    playlists: listProp_('Playlist IDs shown in the section.'),
    channels: listProp_('Channel IDs shown in the section.'),
  };
}

function channelTools_() {
  const channelIdProp = strProp_("Channel ID. Omit for the account's own channel.");
  return [
    apiTool_({
      name: 'youtube_channels_get',
      title: 'Get channel details',
      description:
        "Get channel info, statistics (subscribers, views, video count) and branding. With no filter it returns the account's own channel.",
      kind: 'read',
      props: {
        id: strProp_('Channel ID(s), comma-separated.'),
        forHandle: strProp_('Channel handle, e.g. "@GoogleDevelopers".'),
        forUsername: strProp_('Legacy YouTube username.'),
        ...listProps_(CHANNEL_PARTS, 50),
      },
      request: function (a) {
        return { path: '/channels', query: listQuery_(a, CHANNEL_PARTS, channelFilter_(a)) };
      },
    }),
    defineTool_({
      name: 'youtube_channels_update',
      title: 'Update channel settings',
      description:
        'Change channel description, keywords, country, default language, trailer or made-for-kids status. Other ' +
        'branding settings are preserved. The channel name and handle cannot be changed through the API.',
      kind: 'write',
      props: {
        channelId: channelIdProp,
        description: strProp_('Channel description.'),
        keywords: strProp_('Space-separated channel keywords; quote multi-word keywords.'),
        country: strProp_('ISO 3166-1 alpha-2 country code.'),
        defaultLanguage: strProp_('BCP-47 language code.'),
        unsubscribedTrailer: strProp_('Video ID of the trailer shown to non-subscribers.'),
        selfDeclaredMadeForKids: boolProp_('Whether the whole channel is made for kids.'),
      },
      handler: updateChannel_,
    }),
    defineTool_({
      name: 'youtube_channel_banner_set',
      title: 'Set channel banner',
      description: 'Upload an image (16:9, at least 2048x1152, max 6 MB) and set it as the channel banner.',
      kind: 'write',
      props: { ...SOURCE_PROPS, channelId: channelIdProp },
      handler: setChannelBanner_,
    }),
    defineTool_({
      name: 'youtube_watermark_set',
      title: 'Set video watermark',
      description: 'Upload a square PNG/JPG (max 1 MB) shown as the branding watermark on all of the channel\'s videos.',
      kind: 'write',
      props: {
        ...SOURCE_PROPS,
        channelId: channelIdProp,
        timingType: strProp_('When the watermark appears. Default offsetFromStart.', ['offsetFromStart', 'offsetFromEnd']),
        offsetMs: intProp_('Offset in milliseconds. Default 0.', 0),
        durationMs: intProp_('How long it stays visible, in milliseconds. Omit for the rest of the video.', 0),
      },
      handler: setWatermark_,
    }),
    defineTool_({
      name: 'youtube_watermark_unset',
      title: 'Remove video watermark',
      description: "Remove the channel's branding watermark.",
      kind: 'delete',
      props: { channelId: channelIdProp },
      handler: function (a) {
        const channel = getChannel_(a.channelId, 'id', a.account);
        return ytRequest_({ method: 'POST', path: '/watermarks/unset', query: { channelId: channel.id }, account: a.account });
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_list',
      title: 'List channel sections',
      description: "List the shelves on a channel's home page. Defaults to the account's own channel.",
      kind: 'read',
      props: { channelId: strProp_('Channel ID.'), id: strProp_('Section ID(s), comma-separated.'), part: strProp_('Default: ' + SECTION_PARTS + '.') },
      request: function (a) {
        const filter = a.id ? { id: a.id } : a.channelId ? { channelId: a.channelId } : { mine: true };
        return { path: '/channelSections', query: { part: a.part || SECTION_PARTS, ...filter } };
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_create',
      title: 'Create channel section',
      description: 'Add a shelf to the channel home page.',
      kind: 'write',
      props: sectionProps_(),
      required: ['type'],
      request: function (a) {
        return sectionRequest_('POST', a);
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_update',
      title: 'Update channel section',
      description: 'Replace a shelf\'s type, title, position and contents. Send every value the section should keep.',
      kind: 'write',
      props: { sectionId: strProp_('Section ID.'), ...sectionProps_() },
      required: ['sectionId', 'type'],
      request: function (a) {
        return sectionRequest_('PUT', a);
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_delete',
      title: 'Delete channel section',
      description: 'Remove a shelf from the channel home page.',
      kind: 'delete',
      props: { sectionId: strProp_('Section ID.') },
      required: ['sectionId'],
      request: function (a) {
        return { method: 'DELETE', path: '/channelSections', query: { id: a.sectionId } };
      },
    }),
  ];
}

// ===== 13_tools_videos.js =====
/** Videos: list, upload, update, delete, rate, thumbnails, categories. */

const VIDEO_PARTS = 'snippet,contentDetails,statistics,status';
const VIDEO_SNIPPET_FIELDS = Object.freeze(['title', 'description', 'tags', 'categoryId', 'defaultLanguage']);
const VIDEO_STATUS_FIELDS = Object.freeze([
  'privacyStatus', 'publishAt', 'embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia',
]);
const UPLOADS_PARTS = 'snippet,contentDetails,status';

function videoMetadataProps_() {
  return {
    title: strProp_('Video title (max 100 characters).'),
    description: strProp_('Video description.'),
    tags: listProp_('Keyword tags.'),
    categoryId: strProp_('Category ID from youtube_video_categories_list. Uploads default to "22" (People & Blogs).'),
    defaultLanguage: strProp_('BCP-47 language of the title and description.'),
    privacyStatus: strProp_('Visibility. Uploads default to private.', PRIVACY_VALUES),
    publishAt: strProp_('ISO 8601 time to publish automatically. Requires privacyStatus "private".'),
    embeddable: boolProp_('Whether the video can be embedded on other sites.'),
    license: strProp_('License.', ['youtube', 'creativeCommon']),
    selfDeclaredMadeForKids: boolProp_('Whether the video is made for kids.'),
    containsSyntheticMedia: boolProp_('Declare realistic altered or AI-generated content.'),
  };
}

/** The account's uploads, newest first, read from its "uploads" playlist (cheap on quota). */
function listMyUploads_(args) {
  const channel = getChannel_(null, 'contentDetails', args.account);
  const uploads = ((channel.contentDetails || {}).relatedPlaylists || {}).uploads;
  if (!uploads) {
    throw createError_('This channel has no uploads playlist yet.');
  }
  return ytRequest_({
    path: '/playlistItems',
    query: listQuery_(args, UPLOADS_PARTS, { playlistId: uploads }),
    account: args.account,
  });
}

function updateVideo_(args) {
  return mergeUpdate_({
    path: '/videos',
    id: args.videoId,
    account: args.account,
    label: 'Video',
    parts: {
      snippet: partChanges_(args, VIDEO_SNIPPET_FIELDS),
      status: partChanges_(args, VIDEO_STATUS_FIELDS),
    },
  });
}

function setThumbnail_(args) {
  const image = fetchSourceBlob_(pickSource_(args), LIMITS.MAX_THUMBNAIL_BYTES);
  return uploadMedia_({
    path: '/thumbnails/set',
    query: { videoId: args.videoId, uploadType: 'media' },
    contentType: image.mimeType,
    payload: image.bytes,
    account: args.account,
  });
}

function videoTools_() {
  const videoIdProp = strProp_('Video ID.');
  const budgetProp = intProp_(
    'Seconds this call may spend uploading before it returns progress. Default 40; keep it below your client timeout.',
    1,
    LIMITS.MAX_TIME_BUDGET_S
  );
  return [
    apiTool_({
      name: 'youtube_videos_list',
      title: 'Get videos',
      description:
        'Get details and statistics for videos by ID, the most popular chart, or videos the account rated. ' +
        'Use youtube_videos_list_mine to enumerate a channel\'s own uploads.',
      kind: 'read',
      props: {
        id: strProp_('Video ID(s), comma-separated (max 50).'),
        chart: strProp_('Set to mostPopular for the trending chart.', ['mostPopular']),
        myRating: strProp_('Videos the account liked or disliked.', ['like', 'dislike']),
        regionCode: strProp_('ISO country code for the chart.'),
        videoCategoryId: strProp_('Restrict the chart to one category.'),
        ...listProps_(VIDEO_PARTS, 50),
      },
      request: function (a) {
        const filter = pick_(a, ['id', 'chart', 'myRating', 'regionCode', 'videoCategoryId']);
        return { path: '/videos', query: listQuery_(a, VIDEO_PARTS, filter) };
      },
    }),
    defineTool_({
      name: 'youtube_videos_list_mine',
      title: 'List my uploads',
      description:
        "List the account's own uploaded videos, newest first, including private and unlisted ones. Returns " +
        'playlist items; the video ID is contentDetails.videoId. Pass those IDs to youtube_videos_list for statistics.',
      kind: 'read',
      props: listProps_(UPLOADS_PARTS, 50),
      handler: listMyUploads_,
    }),
    defineTool_({
      name: 'youtube_videos_upload',
      title: 'Upload a video',
      description:
        'Upload a video from Google Drive or an https URL. Large files take several calls: when the result has ' +
        'status "in_progress", call youtube_videos_upload_continue with the returned uploadId until it is ' +
        '"completed". Costs a large share of daily API quota. Videos uploaded through an unaudited API project ' +
        'are locked to private by YouTube.',
      kind: 'write',
      props: {
        ...SOURCE_PROPS,
        ...videoMetadataProps_(),
        notifySubscribers: boolProp_('Notify subscribers about the upload. Default true.'),
        timeBudgetSeconds: budgetProp,
      },
      required: ['title'],
      handler: startVideoUpload_,
    }),
    defineTool_({
      name: 'youtube_videos_upload_continue',
      title: 'Continue a video upload',
      description: 'Upload the next chunks of a video started with youtube_videos_upload. Repeat until status is "completed".',
      kind: 'write',
      noAccount: true,
      props: { uploadId: strProp_('uploadId returned by youtube_videos_upload.'), timeBudgetSeconds: budgetProp },
      required: ['uploadId'],
      handler: resumeVideoUpload_,
    }),
    defineTool_({
      name: 'youtube_videos_update',
      title: 'Update a video',
      description:
        'Change a video\'s title, description, tags, category, visibility, schedule or other settings. Only the ' +
        'fields you pass change; the rest are preserved.',
      kind: 'write',
      props: { videoId: videoIdProp, ...videoMetadataProps_(), publicStatsViewable: boolProp_('Show like counts publicly.') },
      required: ['videoId'],
      handler: updateVideo_,
    }),
    apiTool_({
      name: 'youtube_videos_delete',
      title: 'Delete a video',
      description: 'Permanently delete a video. This cannot be undone.',
      kind: 'delete',
      props: { videoId: videoIdProp },
      required: ['videoId'],
      request: function (a) {
        return { method: 'DELETE', path: '/videos', query: { id: a.videoId } };
      },
    }),
    apiTool_({
      name: 'youtube_videos_rate',
      title: 'Like or dislike a video',
      description: 'Like, dislike, or clear the account\'s rating on a video.',
      kind: 'write',
      props: { videoId: videoIdProp, rating: strProp_('Rating to apply.', ['like', 'dislike', 'none']) },
      required: ['videoId', 'rating'],
      request: function (a) {
        return { method: 'POST', path: '/videos/rate', query: { id: a.videoId, rating: a.rating } };
      },
    }),
    apiTool_({
      name: 'youtube_videos_get_rating',
      title: 'Get my rating of videos',
      description: 'Check whether the account liked or disliked the given videos.',
      kind: 'read',
      props: { videoId: strProp_('Video ID(s), comma-separated.') },
      required: ['videoId'],
      request: function (a) {
        return { path: '/videos/getRating', query: { id: a.videoId } };
      },
    }),
    defineTool_({
      name: 'youtube_thumbnails_set',
      title: 'Set video thumbnail',
      description: 'Upload a custom thumbnail (JPG or PNG, max 2 MB, 1280x720 recommended) for a video.',
      kind: 'write',
      props: { ...SOURCE_PROPS, videoId: videoIdProp },
      required: ['videoId'],
      handler: setThumbnail_,
    }),
    apiTool_({
      name: 'youtube_video_categories_list',
      title: 'List video categories',
      description: 'List the video categories (and their IDs) available in a region.',
      kind: 'read',
      props: { regionCode: strProp_('ISO country code. Default US.') },
      request: function (a) {
        return { path: '/videoCategories', query: { part: 'snippet', regionCode: a.regionCode || 'US' } };
      },
    }),
  ];
}

// ===== 14_tools_playlists.js =====
/** Playlists and the videos inside them. */

const PLAYLIST_PARTS = 'snippet,status,contentDetails';
const PLAYLIST_ITEM_PARTS = 'snippet,contentDetails,status';

function playlistItemBody_(args) {
  return compact_({
    id: args.playlistItemId,
    snippet: compact_({
      playlistId: args.playlistId,
      position: args.position,
      resourceId: { kind: 'youtube#video', videoId: args.videoId },
    }),
  });
}

function playlistTools_() {
  const playlistIdProp = strProp_('Playlist ID.');
  const positionProp = intProp_('Zero-based position in the playlist.', 0);
  return [
    apiTool_({
      name: 'youtube_playlists_list',
      title: 'List playlists',
      description: "List playlists by ID or channel. With no filter it returns the account's own playlists.",
      kind: 'read',
      props: { id: strProp_('Playlist ID(s), comma-separated.'), channelId: strProp_('Channel ID.'), ...listProps_(PLAYLIST_PARTS, 50) },
      request: function (a) {
        const filter = a.id ? { id: a.id } : a.channelId ? { channelId: a.channelId } : { mine: true };
        return { path: '/playlists', query: listQuery_(a, PLAYLIST_PARTS, filter) };
      },
    }),
    apiTool_({
      name: 'youtube_playlists_create',
      title: 'Create a playlist',
      description: 'Create a new playlist on the account\'s channel.',
      kind: 'write',
      props: {
        title: strProp_('Playlist title.'),
        description: strProp_('Playlist description.'),
        privacyStatus: strProp_('Visibility. Default private.', PRIVACY_VALUES),
        defaultLanguage: strProp_('BCP-47 language code.'),
      },
      required: ['title'],
      request: function (a) {
        const body = {
          snippet: compact_(pick_(a, ['title', 'description', 'defaultLanguage'])),
          status: { privacyStatus: a.privacyStatus || 'private' },
        };
        return { method: 'POST', path: '/playlists', query: { part: 'snippet,status' }, body: body };
      },
    }),
    defineTool_({
      name: 'youtube_playlists_update',
      title: 'Update a playlist',
      description: 'Change a playlist\'s title, description, language or visibility. Fields you omit are preserved.',
      kind: 'write',
      props: {
        playlistId: playlistIdProp,
        title: strProp_('Playlist title.'),
        description: strProp_('Playlist description.'),
        defaultLanguage: strProp_('BCP-47 language code.'),
        privacyStatus: strProp_('Visibility.', PRIVACY_VALUES),
      },
      required: ['playlistId'],
      handler: function (a) {
        return mergeUpdate_({
          path: '/playlists',
          id: a.playlistId,
          account: a.account,
          label: 'Playlist',
          parts: {
            snippet: partChanges_(a, ['title', 'description', 'defaultLanguage']),
            status: partChanges_(a, ['privacyStatus']),
          },
        });
      },
    }),
    apiTool_({
      name: 'youtube_playlists_delete',
      title: 'Delete a playlist',
      description: 'Permanently delete a playlist. The videos themselves are not deleted.',
      kind: 'delete',
      props: { playlistId: playlistIdProp },
      required: ['playlistId'],
      request: function (a) {
        return { method: 'DELETE', path: '/playlists', query: { id: a.playlistId } };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_list',
      title: 'List videos in a playlist',
      description: 'List the videos in a playlist, in order. Each item has its own playlistItemId, needed to move or remove it.',
      kind: 'read',
      props: { playlistId: playlistIdProp, ...listProps_(PLAYLIST_ITEM_PARTS, 50) },
      required: ['playlistId'],
      request: function (a) {
        return { path: '/playlistItems', query: listQuery_(a, PLAYLIST_ITEM_PARTS, { playlistId: a.playlistId }) };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_add',
      title: 'Add a video to a playlist',
      description: 'Add a video to a playlist, optionally at a given position.',
      kind: 'write',
      props: { playlistId: playlistIdProp, videoId: strProp_('Video ID.'), position: positionProp },
      required: ['playlistId', 'videoId'],
      request: function (a) {
        return { method: 'POST', path: '/playlistItems', query: { part: 'snippet' }, body: playlistItemBody_(a) };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_move',
      title: 'Move a video within a playlist',
      description: 'Change the position of an item in a playlist.',
      kind: 'write',
      props: {
        playlistItemId: strProp_('Playlist item ID (from youtube_playlist_items_list).'),
        playlistId: playlistIdProp,
        videoId: strProp_('Video ID of that item.'),
        position: positionProp,
      },
      required: ['playlistItemId', 'playlistId', 'videoId', 'position'],
      request: function (a) {
        return { method: 'PUT', path: '/playlistItems', query: { part: 'snippet' }, body: playlistItemBody_(a) };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_remove',
      title: 'Remove a video from a playlist',
      description: 'Remove an item from a playlist. The video itself is not deleted.',
      kind: 'delete',
      props: { playlistItemId: strProp_('Playlist item ID (from youtube_playlist_items_list).') },
      required: ['playlistItemId'],
      request: function (a) {
        return { method: 'DELETE', path: '/playlistItems', query: { id: a.playlistItemId } };
      },
    }),
  ];
}

// ===== 15_tools_comments.js =====
/** Comments: read, post, reply, edit, delete and moderate. */

const THREAD_PARTS = 'snippet,replies';

function threadFilter_(args) {
  if (args.id) return { id: args.id };
  if (args.videoId) return { videoId: args.videoId };
  if (args.channelId) return { allThreadsRelatedToChannelId: args.channelId };
  throw createError_('Provide "videoId", "channelId" or "id".');
}

function commentTools_() {
  const commentIdProp = strProp_('Comment ID.');
  const textProp = strProp_('Comment text.');
  return [
    apiTool_({
      name: 'youtube_comment_threads_list',
      title: 'List comments',
      description:
        'List top-level comments (with their first replies) on a video, or across a whole channel. Use ' +
        'moderationStatus "heldForReview" to see comments waiting for approval on your own videos.',
      kind: 'read',
      props: {
        videoId: strProp_('Video ID.'),
        channelId: strProp_('Channel ID: returns comments on all of its videos.'),
        id: strProp_('Comment thread ID(s), comma-separated.'),
        order: strProp_('Sort order. Default time.', ['time', 'relevance']),
        searchTerms: strProp_('Only comments containing these words.'),
        moderationStatus: strProp_('Default published.', ['published', 'heldForReview', 'likelySpam']),
        ...listProps_(THREAD_PARTS, 100),
      },
      request: function (a) {
        const extra = { ...threadFilter_(a), ...pick_(a, ['order', 'searchTerms', 'moderationStatus']), textFormat: 'plainText' };
        return { path: '/commentThreads', query: listQuery_(a, THREAD_PARTS, extra) };
      },
    }),
    apiTool_({
      name: 'youtube_comments_list',
      title: 'List replies',
      description: 'List all replies to a comment, or fetch specific comments by ID.',
      kind: 'read',
      props: {
        parentId: strProp_('ID of the top-level comment whose replies to list.'),
        id: strProp_('Comment ID(s), comma-separated.'),
        ...listProps_('snippet', 100),
      },
      request: function (a) {
        if (!a.parentId && !a.id) {
          throw createError_('Provide "parentId" or "id".');
        }
        const filter = a.id ? { id: a.id } : { parentId: a.parentId };
        return { path: '/comments', query: listQuery_(a, 'snippet', { ...filter, textFormat: 'plainText' }) };
      },
    }),
    apiTool_({
      name: 'youtube_comments_post',
      title: 'Post a comment',
      description: 'Post a new top-level comment on a video as the account\'s channel.',
      kind: 'write',
      props: { videoId: strProp_('Video ID.'), text: textProp },
      required: ['videoId', 'text'],
      request: function (a) {
        const body = { snippet: { videoId: a.videoId, topLevelComment: { snippet: { textOriginal: a.text } } } };
        return { method: 'POST', path: '/commentThreads', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_comments_reply',
      title: 'Reply to a comment',
      description: 'Reply to a top-level comment.',
      kind: 'write',
      props: { parentId: strProp_('ID of the top-level comment to reply to.'), text: textProp },
      required: ['parentId', 'text'],
      request: function (a) {
        const body = { snippet: { parentId: a.parentId, textOriginal: a.text } };
        return { method: 'POST', path: '/comments', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_comments_update',
      title: 'Edit a comment',
      description: 'Edit the text of a comment written by the account.',
      kind: 'write',
      props: { commentId: commentIdProp, text: textProp },
      required: ['commentId', 'text'],
      request: function (a) {
        const body = { id: a.commentId, snippet: { textOriginal: a.text } };
        return { method: 'PUT', path: '/comments', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_comments_delete',
      title: 'Delete a comment',
      description: 'Permanently delete a comment the account wrote, or one on the account\'s own videos.',
      kind: 'delete',
      props: { commentId: commentIdProp },
      required: ['commentId'],
      request: function (a) {
        return { method: 'DELETE', path: '/comments', query: { id: a.commentId } };
      },
    }),
    apiTool_({
      name: 'youtube_comments_set_moderation_status',
      title: 'Moderate comments',
      description:
        'Approve (published), hold (heldForReview) or reject comments on the account\'s own videos. banAuthor ' +
        'also blocks the author from commenting and only applies when rejecting.',
      kind: 'write',
      props: {
        commentId: strProp_('Comment ID(s), comma-separated.'),
        moderationStatus: strProp_('New status.', ['published', 'heldForReview', 'rejected']),
        banAuthor: boolProp_('Also ban the author from the channel. Only with "rejected".'),
      },
      required: ['commentId', 'moderationStatus'],
      request: function (a) {
        const query = { id: a.commentId, moderationStatus: a.moderationStatus, banAuthor: a.banAuthor };
        return { method: 'POST', path: '/comments/setModerationStatus', query: query };
      },
    }),
  ];
}

// ===== 16_tools_community.js =====
/** Search, subscriptions, captions and channel memberships. */

const SUBSCRIPTION_PARTS = 'snippet,contentDetails';
const SEARCH_FILTERS = Object.freeze([
  'q', 'type', 'channelId', 'order', 'publishedAfter', 'publishedBefore', 'regionCode', 'relevanceLanguage',
  'videoDuration', 'eventType', 'safeSearch',
]);

function subscriptionFilter_(args) {
  if (args.mySubscribers) return { mySubscribers: true };
  if (args.channelId) return { channelId: args.channelId };
  return { mine: true };
}

function uploadCaption_(method, metadata, args) {
  const multipart = buildMultipartRelated_(metadata, toBytes_(args.content), 'application/octet-stream');
  return uploadMedia_({
    method: method,
    path: '/captions',
    query: { part: 'snippet', uploadType: 'multipart' },
    contentType: multipart.contentType,
    payload: multipart.payload,
    account: args.account,
  });
}

function updateCaption_(args) {
  const snippet = compact_({ isDraft: args.isDraft });
  if (args.content === undefined && isEmptyObject_(snippet)) {
    throw createError_('Provide "content" and/or "isDraft".');
  }
  const metadata = { id: args.captionId, snippet: snippet };
  if (args.content !== undefined) {
    return uploadCaption_('PUT', metadata, args);
  }
  return ytRequest_({ method: 'PUT', path: '/captions', query: { part: 'snippet' }, body: metadata, account: args.account });
}

function searchTools_() {
  return [
    apiTool_({
      name: 'youtube_search',
      title: 'Search YouTube',
      description:
        'Search videos, channels and playlists across YouTube, or within one channel. Set forMine to search the ' +
        "account's own videos, including private ones. Costs 100 quota units per call, so prefer the list tools when possible.",
      kind: 'read',
      props: {
        q: strProp_('Search query.'),
        type: strProp_('Result types, comma-separated: video, channel, playlist.'),
        channelId: strProp_('Only results from this channel.'),
        forMine: boolProp_("Only the account's own videos."),
        order: strProp_('Sort order.', ['relevance', 'date', 'viewCount', 'rating', 'title', 'videoCount']),
        publishedAfter: strProp_('ISO 8601 lower bound.'),
        publishedBefore: strProp_('ISO 8601 upper bound.'),
        regionCode: strProp_('ISO country code.'),
        relevanceLanguage: strProp_('ISO 639-1 language code.'),
        videoDuration: strProp_('Requires type=video.', ['any', 'short', 'medium', 'long']),
        eventType: strProp_('Live filter; requires type=video.', ['live', 'upcoming', 'completed']),
        safeSearch: strProp_('Content filter.', ['none', 'moderate', 'strict']),
        ...listProps_('snippet', 50),
      },
      request: function (a) {
        const mine = a.forMine ? { forMine: true, type: 'video' } : {};
        return { path: '/search', query: listQuery_(a, 'snippet', { ...pick_(a, SEARCH_FILTERS), ...mine }) };
      },
    }),
  ];
}

function subscriptionTools_() {
  return [
    apiTool_({
      name: 'youtube_subscriptions_list',
      title: 'List subscriptions or subscribers',
      description:
        'List the channels the account subscribes to, or (mySubscribers) the public subscribers of the account\'s channel.',
      kind: 'read',
      props: {
        mySubscribers: boolProp_("List the account's subscribers instead of its subscriptions."),
        channelId: strProp_("List another channel's public subscriptions."),
        forChannelId: strProp_('Check whether the listed subscriptions include these channel ID(s).'),
        order: strProp_('Sort order.', ['relevance', 'unread', 'alphabetical']),
        ...listProps_(SUBSCRIPTION_PARTS, 50),
      },
      request: function (a) {
        const extra = { ...subscriptionFilter_(a), ...pick_(a, ['forChannelId', 'order']) };
        return { path: '/subscriptions', query: listQuery_(a, SUBSCRIPTION_PARTS, extra) };
      },
    }),
    apiTool_({
      name: 'youtube_subscriptions_subscribe',
      title: 'Subscribe to a channel',
      description: 'Subscribe the account to a channel.',
      kind: 'write',
      props: { channelId: strProp_('Channel ID to subscribe to.') },
      required: ['channelId'],
      request: function (a) {
        const body = { snippet: { resourceId: { kind: 'youtube#channel', channelId: a.channelId } } };
        return { method: 'POST', path: '/subscriptions', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_subscriptions_unsubscribe',
      title: 'Unsubscribe from a channel',
      description: 'Remove a subscription. Needs the subscription ID from youtube_subscriptions_list, not the channel ID.',
      kind: 'delete',
      props: { subscriptionId: strProp_('Subscription ID.') },
      required: ['subscriptionId'],
      request: function (a) {
        return { method: 'DELETE', path: '/subscriptions', query: { id: a.subscriptionId } };
      },
    }),
  ];
}

function captionTools_() {
  const captionIdProp = strProp_('Caption track ID.');
  const contentProp = strProp_('Full text of the caption file (SRT, VTT, SBV or TTML).');
  return [
    apiTool_({
      name: 'youtube_captions_list',
      title: 'List caption tracks',
      description: 'List the caption tracks of a video.',
      kind: 'read',
      props: { videoId: strProp_('Video ID.') },
      required: ['videoId'],
      request: function (a) {
        return { path: '/captions', query: { part: 'snippet', videoId: a.videoId } };
      },
    }),
    apiTool_({
      name: 'youtube_captions_download',
      title: 'Download a caption track',
      description: "Download a caption track's text. Only works for videos the account owns.",
      kind: 'read',
      props: {
        captionId: captionIdProp,
        format: strProp_('Output format. Default srt.', ['srt', 'vtt', 'sbv', 'ttml', 'scc']),
        translateTo: strProp_('ISO 639-1 language to machine-translate the track into.'),
      },
      required: ['captionId'],
      request: function (a) {
        const query = { tfmt: a.format || 'srt', tlang: a.translateTo };
        return { path: '/captions/' + encodeURIComponent(a.captionId), query: query, raw: true };
      },
    }),
    defineTool_({
      name: 'youtube_captions_upload',
      title: 'Upload a caption track',
      description: 'Add a caption track to a video from caption file text.',
      kind: 'write',
      props: {
        videoId: strProp_('Video ID.'),
        language: strProp_('BCP-47 language of the track, e.g. "en".'),
        name: strProp_('Track name shown to viewers. Default empty.'),
        content: contentProp,
        isDraft: boolProp_('Keep the track hidden from viewers.'),
      },
      required: ['videoId', 'language', 'content'],
      handler: function (a) {
        const snippet = compact_({ videoId: a.videoId, language: a.language, name: a.name || '', isDraft: a.isDraft });
        return uploadCaption_('POST', { snippet: snippet }, a);
      },
    }),
    defineTool_({
      name: 'youtube_captions_update',
      title: 'Update a caption track',
      description: 'Replace the text of a caption track and/or publish or unpublish it.',
      kind: 'write',
      props: { captionId: captionIdProp, content: contentProp, isDraft: boolProp_('Whether the track is hidden from viewers.') },
      required: ['captionId'],
      handler: updateCaption_,
    }),
    apiTool_({
      name: 'youtube_captions_delete',
      title: 'Delete a caption track',
      description: 'Permanently delete a caption track.',
      kind: 'delete',
      props: { captionId: captionIdProp },
      required: ['captionId'],
      request: function (a) {
        return { method: 'DELETE', path: '/captions', query: { id: a.captionId } };
      },
    }),
  ];
}

function memberTools_() {
  return [
    apiTool_({
      name: 'youtube_members_list',
      title: 'List channel members',
      description: 'List paying channel members. Only works for channels with memberships enabled.',
      kind: 'read',
      props: {
        mode: strProp_('all_current (default) or updates for new members since the last call.', ['all_current', 'updates']),
        hasAccessToLevel: strProp_('Only members with access to this level ID.'),
        maxResults: intProp_('Page size, 1-1000.', 1, 1000),
        pageToken: strProp_('nextPageToken from an earlier call.'),
      },
      request: function (a) {
        const query = { part: 'snippet', ...pick_(a, ['mode', 'hasAccessToLevel', 'maxResults', 'pageToken']) };
        return { path: '/members', query: query };
      },
    }),
    apiTool_({
      name: 'youtube_membership_levels_list',
      title: 'List membership levels',
      description: "List the channel's membership levels.",
      kind: 'read',
      props: {},
      request: function () {
        return { path: '/membershipsLevels', query: { part: 'id,snippet' } };
      },
    }),
  ];
}

function communityTools_() {
  return [].concat(searchTools_(), subscriptionTools_(), captionTools_(), memberTools_());
}

// ===== 17_tools_live.js =====
/** Live streaming: broadcasts, ingestion streams and live chat. */

const BROADCAST_PARTS = 'snippet,status,contentDetails';
const STREAM_PARTS = 'snippet,cdn,status,contentDetails';
const BROADCAST_SNIPPET_FIELDS = Object.freeze(['title', 'description', 'scheduledStartTime', 'scheduledEndTime']);
const BROADCAST_STATUS_FIELDS = Object.freeze(['privacyStatus', 'selfDeclaredMadeForKids']);

function broadcastProps_() {
  return {
    title: strProp_('Broadcast title.'),
    description: strProp_('Broadcast description.'),
    scheduledStartTime: strProp_('ISO 8601 start time.'),
    scheduledEndTime: strProp_('ISO 8601 end time.'),
    privacyStatus: strProp_('Visibility.', PRIVACY_VALUES),
    selfDeclaredMadeForKids: boolProp_('Whether the broadcast is made for kids.'),
  };
}

/** The API accepts exactly one of id / broadcastStatus / mine. */
function broadcastFilter_(args) {
  if (args.id) return { id: args.id };
  if (args.broadcastStatus) return { broadcastStatus: args.broadcastStatus };
  return { mine: true };
}

function createBroadcastRequest_(args) {
  const body = {
    snippet: compact_(pick_(args, BROADCAST_SNIPPET_FIELDS)),
    status: compact_({
      privacyStatus: args.privacyStatus || 'private',
      selfDeclaredMadeForKids: args.selfDeclaredMadeForKids === true,
    }),
    contentDetails: compact_({
      enableAutoStart: args.enableAutoStart,
      enableAutoStop: args.enableAutoStop,
      enableDvr: args.enableDvr,
    }),
  };
  return { method: 'POST', path: '/liveBroadcasts', query: { part: BROADCAST_PARTS }, body: body };
}

function createStreamRequest_(args) {
  const body = {
    snippet: compact_(pick_(args, ['title', 'description'])),
    cdn: {
      ingestionType: args.ingestionType || 'rtmp',
      resolution: args.resolution || 'variable',
      frameRate: args.frameRate || 'variable',
    },
    contentDetails: { isReusable: args.isReusable !== false },
  };
  return { method: 'POST', path: '/liveStreams', query: { part: 'snippet,cdn,contentDetails' }, body: body };
}

function broadcastTools_() {
  const broadcastIdProp = strProp_('Broadcast ID (same as its video ID).');
  return [
    apiTool_({
      name: 'youtube_live_broadcasts_list',
      title: 'List live broadcasts',
      description: "List the account's live broadcasts, optionally by status. The liveChatId is in snippet.liveChatId.",
      kind: 'read',
      props: {
        id: strProp_('Broadcast ID(s), comma-separated.'),
        broadcastStatus: strProp_('Filter by status.', ['active', 'all', 'completed', 'upcoming']),
        ...listProps_(BROADCAST_PARTS, 50),
      },
      request: function (a) {
        return { path: '/liveBroadcasts', query: listQuery_(a, BROADCAST_PARTS, broadcastFilter_(a)) };
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_create',
      title: 'Schedule a live broadcast',
      description:
        'Schedule a live broadcast. To go live, also create a stream (youtube_live_streams_create), bind it ' +
        '(youtube_live_broadcasts_bind), send video to the ingestion address, then transition to live.',
      kind: 'write',
      props: {
        ...broadcastProps_(),
        enableAutoStart: boolProp_('Go live automatically when the stream starts sending data.'),
        enableAutoStop: boolProp_('End automatically when the stream stops.'),
        enableDvr: boolProp_('Let viewers rewind during the broadcast.'),
      },
      required: ['title', 'scheduledStartTime'],
      request: createBroadcastRequest_,
    }),
    defineTool_({
      name: 'youtube_live_broadcasts_update',
      title: 'Update a live broadcast',
      description: 'Change a broadcast\'s title, description, schedule or visibility. Fields you omit are preserved.',
      kind: 'write',
      props: { broadcastId: broadcastIdProp, ...broadcastProps_() },
      required: ['broadcastId'],
      handler: function (a) {
        return mergeUpdate_({
          path: '/liveBroadcasts',
          id: a.broadcastId,
          account: a.account,
          label: 'Broadcast',
          parts: {
            snippet: partChanges_(a, BROADCAST_SNIPPET_FIELDS),
            status: partChanges_(a, BROADCAST_STATUS_FIELDS),
          },
        });
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_delete',
      title: 'Delete a live broadcast',
      description: 'Permanently delete a broadcast.',
      kind: 'delete',
      props: { broadcastId: broadcastIdProp },
      required: ['broadcastId'],
      request: function (a) {
        return { method: 'DELETE', path: '/liveBroadcasts', query: { id: a.broadcastId } };
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_bind',
      title: 'Bind a stream to a broadcast',
      description: 'Attach an ingestion stream to a broadcast. Omit streamId to unbind.',
      kind: 'write',
      props: { broadcastId: broadcastIdProp, streamId: strProp_('Stream ID. Omit to unbind.') },
      required: ['broadcastId'],
      request: function (a) {
        const query = { id: a.broadcastId, streamId: a.streamId, part: BROADCAST_PARTS };
        return { method: 'POST', path: '/liveBroadcasts/bind', query: query };
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_transition',
      title: 'Start or end a live broadcast',
      description: 'Move a broadcast to testing, live or complete. The bound stream must be active before going live.',
      kind: 'write',
      props: { broadcastId: broadcastIdProp, broadcastStatus: strProp_('Target status.', ['testing', 'live', 'complete']) },
      required: ['broadcastId', 'broadcastStatus'],
      request: function (a) {
        const query = { id: a.broadcastId, broadcastStatus: a.broadcastStatus, part: 'snippet,status' };
        return { method: 'POST', path: '/liveBroadcasts/transition', query: query };
      },
    }),
  ];
}

function streamTools_() {
  return [
    apiTool_({
      name: 'youtube_live_streams_list',
      title: 'List live streams',
      description:
        "List the account's ingestion streams. The response includes the RTMP address and the secret stream key " +
        '(cdn.ingestionInfo); do not share it.',
      kind: 'read',
      props: { id: strProp_('Stream ID(s), comma-separated.'), ...listProps_(STREAM_PARTS, 50) },
      request: function (a) {
        return { path: '/liveStreams', query: listQuery_(a, STREAM_PARTS, a.id ? { id: a.id } : { mine: true }) };
      },
    }),
    apiTool_({
      name: 'youtube_live_streams_create',
      title: 'Create a live stream',
      description: 'Create an ingestion stream (the encoder endpoint) to bind to broadcasts.',
      kind: 'write',
      props: {
        title: strProp_('Stream title.'),
        description: strProp_('Stream description.'),
        ingestionType: strProp_('Default rtmp.', ['rtmp', 'dash', 'hls', 'webrtc']),
        resolution: strProp_('e.g. 1080p, 720p or variable (default).'),
        frameRate: strProp_('30fps, 60fps or variable (default).'),
        isReusable: boolProp_('Whether the stream can serve several broadcasts. Default true.'),
      },
      required: ['title'],
      request: createStreamRequest_,
    }),
    apiTool_({
      name: 'youtube_live_streams_delete',
      title: 'Delete a live stream',
      description: 'Permanently delete an ingestion stream.',
      kind: 'delete',
      props: { streamId: strProp_('Stream ID.') },
      required: ['streamId'],
      request: function (a) {
        return { method: 'DELETE', path: '/liveStreams', query: { id: a.streamId } };
      },
    }),
  ];
}

function liveChatTools_() {
  const chatIdProp = strProp_('Live chat ID (snippet.liveChatId of the broadcast).');
  return [
    apiTool_({
      name: 'youtube_live_chat_messages_list',
      title: 'Read live chat',
      description: 'Read messages from a live chat. Pass the returned nextPageToken to fetch only newer messages.',
      kind: 'read',
      props: { liveChatId: chatIdProp, maxResults: intProp_('Page size, 200-2000.', 200, 2000), pageToken: strProp_('nextPageToken from an earlier call.') },
      required: ['liveChatId'],
      request: function (a) {
        const query = { part: 'snippet,authorDetails', ...pick_(a, ['liveChatId', 'maxResults', 'pageToken']) };
        return { path: '/liveChat/messages', query: query };
      },
    }),
    apiTool_({
      name: 'youtube_live_chat_messages_send',
      title: 'Send a live chat message',
      description: "Post a message to a live chat as the account's channel.",
      kind: 'write',
      props: { liveChatId: chatIdProp, text: strProp_('Message text (max 200 characters).') },
      required: ['liveChatId', 'text'],
      request: function (a) {
        const snippet = { liveChatId: a.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: a.text } };
        return { method: 'POST', path: '/liveChat/messages', query: { part: 'snippet' }, body: { snippet: snippet } };
      },
    }),
    apiTool_({
      name: 'youtube_live_chat_messages_delete',
      title: 'Delete a live chat message',
      description: 'Delete a message from a live chat the account moderates.',
      kind: 'delete',
      props: { messageId: strProp_('Live chat message ID.') },
      required: ['messageId'],
      request: function (a) {
        return { method: 'DELETE', path: '/liveChat/messages', query: { id: a.messageId } };
      },
    }),
  ];
}

function liveTools_() {
  return [].concat(broadcastTools_(), streamTools_(), liveChatTools_());
}

// ===== 18_tools_analytics.js =====
/** YouTube Analytics reports and the generic escape hatch for every other endpoint. */

const DEFAULT_ANALYTICS_METRICS =
  'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares';
const GENERIC_PATH_PATTERN = /^\/[A-Za-z0-9_\-\/.]*$/;

/** Turns the column-header + row-array report into a list of plain objects. */
function tabulateReport_(report) {
  const columns = (report.columnHeaders || []).map(function (header) {
    return header.name;
  });
  const rows = (report.rows || []).map(function (row) {
    return columns.reduce(function (record, name, index) {
      return { ...record, [name]: row[index] };
    }, {});
  });
  return { columns: columns, rowCount: rows.length, rows: rows };
}

function queryAnalytics_(args) {
  const query = {
    ids: args.ids || 'channel==MINE',
    startDate: args.startDate || isoDateDaysAgo_(LIMITS.DEFAULT_ANALYTICS_DAYS),
    endDate: args.endDate || isoDateDaysAgo_(0),
    metrics: args.metrics || DEFAULT_ANALYTICS_METRICS,
    ...pick_(args, ['dimensions', 'filters', 'sort', 'maxResults', 'startIndex', 'currency']),
  };
  const report = ytRequest_({ api: 'analytics', path: '/reports', query: query, account: args.account });
  return { startDate: query.startDate, endDate: query.endDate, ...tabulateReport_(report) };
}

function genericApiRequest_(args) {
  const path = args.path;
  if (!GENERIC_PATH_PATTERN.test(path) || path.indexOf('..') !== -1 || path.indexOf('//') !== -1) {
    throw createError_('"path" must be an API path such as "/activities" (letters, digits, "/", "_", "-", ".").');
  }
  return ytRequest_({
    api: args.api || 'data',
    method: args.method || 'GET',
    path: path,
    query: args.query || {},
    body: args.body,
    account: args.account,
  });
}

function analyticsTools_() {
  return [
    defineTool_({
      name: 'youtube_analytics_query',
      title: 'Query channel analytics',
      description:
        'Run a YouTube Analytics report for the account\'s channel (the numbers shown in YouTube Studio). ' +
        'Defaults to channel totals for the last 28 days. Examples: daily trend: dimensions="day", sort="day"; ' +
        'top videos: dimensions="video", metrics="views,estimatedMinutesWatched", sort="-views", maxResults=10; ' +
        'one video: filters="video==VIDEO_ID"; traffic sources: dimensions="insightTrafficSourceType"; ' +
        'audience: dimensions="ageGroup,gender", metrics="viewerPercentage"; countries: dimensions="country"; ' +
        'revenue (monetised channels): metrics="estimatedRevenue,cpm,playbackBasedCpm".',
      kind: 'read',
      props: {
        startDate: strProp_('YYYY-MM-DD. Default 28 days ago.'),
        endDate: strProp_('YYYY-MM-DD. Default today.'),
        metrics: strProp_('Comma-separated metrics. Default: ' + DEFAULT_ANALYTICS_METRICS + '.'),
        dimensions: strProp_('Comma-separated dimensions, e.g. day, video, country, deviceType.'),
        filters: strProp_('Semicolon-separated filters, e.g. "video==abc123;country==IN".'),
        sort: strProp_('Comma-separated sort keys; prefix with "-" for descending.'),
        maxResults: intProp_('Maximum rows.', 1, 1000),
        startIndex: intProp_('1-based index of the first row, for paging.', 1),
        currency: strProp_('ISO 4217 currency for revenue metrics. Default USD.'),
        ids: strProp_('Default "channel==MINE". Content owners can pass "contentOwner==NAME".'),
      },
      handler: queryAnalytics_,
    }),
    defineTool_({
      name: 'youtube_api_request',
      title: 'Call any YouTube API endpoint',
      description:
        'Escape hatch: call any endpoint of the YouTube Data API v3 (api="data"), Analytics API v2 ' +
        '("analytics") or Reporting API v1 ("reporting") that has no dedicated tool, e.g. /activities, ' +
        '/playlistImages, /liveChat/moderators, /liveChat/bans, /videos/reportAbuse, /i18nLanguages, analytics ' +
        '/groups and /groupItems, reporting /jobs. Prefer the dedicated tools when one exists.',
      kind: 'delete',
      props: {
        api: strProp_('Which API. Default data.', Object.keys(API_BASES)),
        method: strProp_('HTTP method. Default GET.', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: strProp_('Path below the API root, e.g. "/activities".'),
        query: objProp_('Query parameters, e.g. {"part":"snippet","mine":true}.'),
        body: objProp_('JSON request body for POST / PUT / PATCH.'),
      },
      required: ['path'],
      handler: genericApiRequest_,
    }),
  ];
}

// ===== 20_mcp.js =====
/** MCP over JSON-RPC 2.0: initialize, ping, tools/list and tools/call. Stateless. */

function rpcResult_(id, result) {
  return { jsonrpc: '2.0', id: id, result: result };
}

function rpcError_(id, code, message) {
  return { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
}

function toolSuccess_(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

/** Tool failures go back as results so the model can read them and correct itself. */
function toolError_(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function initialize_(params) {
  const requested = params.protocolVersion;
  const supported = SUPPORTED_PROTOCOL_VERSIONS.indexOf(requested) !== -1;
  return {
    protocolVersion: supported ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  };
}

function listTools_() {
  return { tools: allTools_().map(describeTool_) };
}

function callTool_(params) {
  const tool = findTool_(params.name);
  if (!tool) {
    throw rpcException_(RPC_ERRORS.INVALID_PARAMS, 'Unknown tool: ' + String(params.name));
  }
  const args = compact_(isPlainObject_(params.arguments) ? params.arguments : {});
  const problems = validateArgs_(tool.inputSchema, args);
  if (problems.length > 0) {
    return toolError_('Invalid arguments for ' + tool.name + ': ' + problems.join(' '));
  }
  try {
    return toolSuccess_(tool.handler(args));
  } catch (error) {
    const message = redactSecrets_(error && error.message ? error.message : String(error));
    console.error('Tool ' + tool.name + ' failed: ' + message);
    return toolError_(message);
  }
}

const RPC_METHODS = Object.freeze({
  initialize: initialize_,
  ping: function () {
    return {};
  },
  'tools/list': listTools_,
  'tools/call': callTool_,
});

function dispatchMethod_(method, params) {
  if (!Object.prototype.hasOwnProperty.call(RPC_METHODS, method)) {
    throw rpcException_(RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found: ' + method);
  }
  return RPC_METHODS[method](isPlainObject_(params) ? params : {});
}

/** Returns a JSON-RPC response, or null when the message needs none (notifications, client responses). */
function handleRpcMessage_(message) {
  const isObject = isPlainObject_(message);
  const hasId = isObject && message.id !== undefined && message.id !== null;
  if (isObject && typeof message.method !== 'string' && ('result' in message || 'error' in message)) {
    return null;
  }
  if (!isObject || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError_(hasId ? message.id : null, RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request.');
  }
  if (!hasId) {
    return null;
  }
  try {
    return rpcResult_(message.id, dispatchMethod_(message.method, message.params));
  } catch (error) {
    if (error.rpcCode) {
      return rpcError_(message.id, error.rpcCode, error.message);
    }
    console.error('RPC ' + message.method + ' failed: ' + redactSecrets_(error.message));
    return rpcError_(message.id, RPC_ERRORS.INTERNAL, 'Internal error.');
  }
}

/** Handles a single message or a batch. Returns null when nothing should be sent back. */
function handleRpcPayload_(payload) {
  if (!Array.isArray(payload)) {
    return handleRpcMessage_(payload);
  }
  if (payload.length === 0) {
    return rpcError_(null, RPC_ERRORS.INVALID_REQUEST, 'Empty batch.');
  }
  const responses = payload.map(handleRpcMessage_).filter(function (response) {
    return response !== null;
  });
  return responses.length > 0 ? responses : null;
}

// ===== 30_webapp.js =====
/**
 * Web app entry points.
 *   POST <exec url>?key=<MCP_API_KEY>   MCP endpoint (JSON-RPC)
 *   GET  <exec url>?state=..&code=..    OAuth redirect when connecting a channel
 *
 * Apps Script hides request headers from doPost, so the key travels in the query string.
 */

/** Fails closed: with no key configured, nobody is authorised. */
function isAuthorized_(e) {
  const expected = getProp_(PROP_KEYS.API_KEY);
  const given = e && e.parameter ? e.parameter.key : null;
  return Boolean(expected) && typeof given === 'string' && secureEquals_(given, expected);
}

/** Returns the response body for a POST as a string ('' when no reply is due). */
function handleHttpPost_(e) {
  if (!isAuthorized_(e)) {
    return JSON.stringify(rpcError_(null, RPC_ERRORS.UNAUTHORIZED, 'Unauthorized: missing or invalid "key" query parameter.'));
  }
  const text = e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  const payload = safeJsonParse_(text, undefined);
  if (payload === undefined) {
    return JSON.stringify(rpcError_(null, RPC_ERRORS.PARSE, 'Parse error: body is not valid JSON.'));
  }
  const response = handleRpcPayload_(payload);
  return response === null ? '' : JSON.stringify(response);
}

function doPost(e) {
  return ContentService.createTextOutput(handleHttpPost_(e)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.state) {
    const outcome = handleOAuthCallback_(params);
    return renderPage_(outcome.heading, outcome.detail);
  }
  return renderPage_('YouTube MCP', 'This endpoint speaks MCP over HTTP POST.');
}

function generateApiKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function connectionInfo_() {
  const key = getProp_(PROP_KEYS.API_KEY);
  const url = getProp_(PROP_KEYS.WEBAPP_URL) || ScriptApp.getService().getUrl() || '';
  if (!/\/exec$/.test(url)) {
    return (
      'API key (keep it secret): ' + key + '\nDeploy > New deployment > Web app (Execute as: Me, Access: Anyone). ' +
      'Your MCP endpoint is the web app URL ending in /exec followed by ?key=' + key
    );
  }
  return 'MCP endpoint (keep it secret):\n' + url + '?key=' + key;
}

/** Run once from the editor: creates the API key and logs the MCP endpoint URL. */
function setup() {
  if (!getProp_(PROP_KEYS.API_KEY)) {
    scriptProps_().setProperty(PROP_KEYS.API_KEY, generateApiKey_());
  }
  Logger.log(connectionInfo_());
}

/** Run from the editor to invalidate the current key and log the new endpoint URL. */
function rotateApiKey() {
  scriptProps_().setProperty(PROP_KEYS.API_KEY, generateApiKey_());
  Logger.log(connectionInfo_());
}
