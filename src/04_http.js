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
