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
