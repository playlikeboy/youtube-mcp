'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, installGas, response } = require('./helpers/gas');

const app = loadBundle();
const KEY = 'test-key';

function setup() {
  const gas = installGas();
  gas.props.set('MCP_API_KEY', KEY);
  return gas;
}

function post(body, key) {
  const event = { parameter: key === null ? {} : { key: key || KEY }, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } };
  const text = app.handleHttpPost_(event);
  return text === '' ? null : JSON.parse(text);
}

function call(name, args) {
  return post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });
}

test('rejects requests without the API key', () => {
  setup();
  const reply = post({ jsonrpc: '2.0', id: 1, method: 'ping' }, null);
  assert.equal(reply.error.code, app.RPC_ERRORS.UNAUTHORIZED);
});

test('rejects a wrong API key', () => {
  setup();
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong').error.code, app.RPC_ERRORS.UNAUTHORIZED);
});

test('rejects every request when no API key is configured', () => {
  installGas();
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, '').error.code, app.RPC_ERRORS.UNAUTHORIZED);
});

test('initialize echoes a supported protocol version and advertises tools', () => {
  setup();
  const reply = post({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(reply.id, 7);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
  assert.equal(reply.result.serverInfo.name, 'youtube-mcp-gas');
});

test('initialize falls back to the newest version for an unknown one', () => {
  setup();
  const reply = post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(reply.result.protocolVersion, app.SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test('notifications get no response body', () => {
  setup();
  assert.equal(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('unknown methods return method-not-found', () => {
  setup();
  assert.equal(post({ jsonrpc: '2.0', id: 1, method: 'resources/list' }).error.code, app.RPC_ERRORS.METHOD_NOT_FOUND);
});

test('malformed JSON returns a parse error', () => {
  setup();
  assert.equal(post('{not json').error.code, app.RPC_ERRORS.PARSE);
});

test('invalid envelopes return invalid-request', () => {
  setup();
  assert.equal(post({ id: 1, method: 'ping' }).error.code, app.RPC_ERRORS.INVALID_REQUEST);
  assert.equal(post([]).error.code, app.RPC_ERRORS.INVALID_REQUEST);
});

test('batches answer requests and skip notifications', () => {
  setup();
  const reply = post([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]);
  assert.deepEqual(reply.map((item) => item.id), [1, 2]);
});

test('tools/list returns unique, well-formed tool definitions', () => {
  setup();
  const tools = post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools;
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'youtube_accounts_list',
    'youtube_accounts_connect',
    'youtube_accounts_remove',
    'youtube_accounts_set_default',
    'youtube_videos_list',
    'youtube_videos_list_mine',
    'youtube_videos_upload',
    'youtube_videos_upload_continue',
    'youtube_videos_update',
    'youtube_videos_delete',
    'youtube_thumbnails_set',
    'youtube_video_categories_list',
  ]);
  tools.forEach((tool) => {
    assert.match(tool.name, /^youtube_[a-z_]+$/);
    assert.ok(tool.description.length > 10, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.handler, undefined);
    tool.inputSchema.required.forEach((key) => assert.ok(tool.inputSchema.properties[key], tool.name + '.' + key));
  });
});

test('unknown tool is a protocol error', () => {
  setup();
  assert.equal(call('youtube_nope').error.code, app.RPC_ERRORS.INVALID_PARAMS);
});

test('invalid arguments come back as a tool error the model can read', () => {
  setup();
  const result = call('youtube_videos_update', { videoId: 5, privacyStatus: 'secret', tags: [1], extra: true }).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /"videoId" must be of type string/);
  assert.match(result.content[0].text, /"privacyStatus" must be one of/);
  assert.match(result.content[0].text, /"tags" must be an array of strings/);
  assert.match(result.content[0].text, /Unknown argument "extra"/);
});

test('missing required arguments are reported', () => {
  setup();
  assert.match(call('youtube_videos_delete').result.content[0].text, /Missing required argument "videoId"/);
});

test('API errors surface the reason and a hint, never the token', () => {
  const gas = setup();
  gas.on('/videos', response(403, { error: { message: 'Quota exceeded', errors: [{ reason: 'quotaExceeded' }] } }));
  const result = call('youtube_videos_list', { id: 'abc' }).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /403 \(quotaExceeded\): Quota exceeded Hint:/);
  assert.doesNotMatch(result.content[0].text, /owner-token/);
});

test('doPost wraps the reply as JSON and doGet serves a plain status page', () => {
  setup();
  const output = app.doPost({ parameter: { key: KEY }, postData: { contents: '{"jsonrpc":"2.0","id":1,"method":"ping"}' } });
  assert.equal(output.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(output.text).result, {});
  assert.match(app.doGet({ parameter: {} }).html, /MCP over HTTP POST/);
});

test('setup creates a key once and logs the endpoint; rotate replaces it', () => {
  const gas = installGas();
  app.setup();
  const first = gas.props.get('MCP_API_KEY');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(gas.logs[0], /deploy/i);
  gas.webAppUrl = 'https://script.google.com/macros/s/ID/exec';
  app.setup();
  assert.equal(gas.props.get('MCP_API_KEY'), first);
  assert.ok(gas.logs[1].endsWith('/exec?key=' + first));
  app.rotateApiKey();
  assert.notEqual(gas.props.get('MCP_API_KEY'), first);
});

test('redactSecrets strips query strings and bearer tokens', () => {
  const text = app.redactSecrets_('GET https://x.test/upload?upload_id=SECRET failed with Bearer ya29.abc-DEF');
  assert.doesNotMatch(text, /SECRET|ya29/);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(app.escapeHtml_('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
});
