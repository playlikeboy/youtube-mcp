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
