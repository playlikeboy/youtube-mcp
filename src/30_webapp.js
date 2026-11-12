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
