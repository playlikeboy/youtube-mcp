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
