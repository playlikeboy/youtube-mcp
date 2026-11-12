'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, installGas, response } = require('./helpers/gas');

const app = loadBundle();
const WEBAPP_URL = 'https://script.google.com/macros/s/DEPLOY/exec';

function run(name, args) {
  const result = app.callTool_({ name, arguments: args || {} });
  const text = result.content[0].text;
  return { isError: result.isError, text, data: result.isError ? null : JSON.parse(text) };
}

function queryOf(call) {
  return Object.fromEntries(new URL(call.url).searchParams);
}

function bodyOf(call) {
  return JSON.parse(call.options.payload);
}

const VIDEO = {
  id: 'ID1',
  snippet: { title: 'Old title', description: 'Old description', categoryId: '10', tags: ['a'], thumbnails: {} },
  status: { privacyStatus: 'private', uploadStatus: 'processed' },
};
const CHANNEL = { id: 'UC1', contentDetails: { relatedPlaylists: { uploads: 'UU1' } } };

function withConnectedAccount(gas) {
  gas.props.set('OAUTH_CLIENT_ID', 'cid');
  gas.props.set('OAUTH_CLIENT_SECRET', 'csecret');
  gas.props.set('WEBAPP_URL', WEBAPP_URL);
  gas.props.set('YT_ACCOUNT_second', JSON.stringify({ refreshToken: 'rt', channelId: 'UC2', channelTitle: 'Second' }));
  return gas;
}

test('requests carry the owner token by default', () => {
  const gas = installGas();
  gas.on('/videos', response(200, { items: [VIDEO] }));
  run('youtube_videos_list', { id: 'ID1' });
  assert.equal(gas.calls[0].options.headers.Authorization, 'Bearer owner-token');
  assert.equal(gas.calls[0].url.split('?')[0], 'https://www.googleapis.com/youtube/v3/videos');
  assert.deepEqual(queryOf(gas.calls[0]), { part: 'snippet,contentDetails,statistics,status', id: 'ID1' });
});

test('a connected account refreshes its token once and caches it', () => {
  const gas = withConnectedAccount(installGas());
  gas.on('oauth2.googleapis.com/token', response(200, { access_token: 'second-token', expires_in: 3600 }));
  gas.on('/videos', response(200, { items: [] }));
  run('youtube_videos_list', { id: 'x', account: 'second' });
  run('youtube_videos_list', { id: 'x', account: 'second' });
  const tokenCalls = gas.calls.filter((call) => call.url.includes('/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].options.payload.refresh_token, 'rt');
  assert.equal(gas.calls[2].options.headers.Authorization, 'Bearer second-token');
});

test('a rejected refresh token tells the user to reconnect', () => {
  const gas = withConnectedAccount(installGas());
  gas.on('oauth2.googleapis.com/token', response(400, { error: 'invalid_grant', error_description: 'Token has been revoked' }));
  assert.match(run('youtube_videos_list', { id: 'x', account: 'second' }).text, /Token has been revoked.*|reconnect/);
});

test('an unknown account is rejected before any request is sent', () => {
  const gas = installGas();
  assert.equal(run('youtube_videos_list', { id: 'x', account: 'ghost' }).isError, true);
  assert.equal(gas.calls.length, 0);
});

test('accounts_list never exposes refresh tokens', () => {
  withConnectedAccount(installGas());
  const outcome = run('youtube_accounts_list');
  assert.doesNotMatch(outcome.text, /"rt"|refreshToken/);
  assert.deepEqual(outcome.data.accounts.map((account) => account.alias), ['owner', 'second']);
  assert.equal(outcome.data.oauthClientConfigured, true);
});

test('removing the default account revokes it and falls back to owner', () => {
  const gas = withConnectedAccount(installGas());
  gas.on('/revoke', response(200, {}));
  assert.deepEqual(run('youtube_accounts_set_default', { alias: 'second' }).data, { defaultAccount: 'second' });
  const outcome = run('youtube_accounts_remove', { alias: 'second' });
  assert.deepEqual(outcome.data, { removed: 'second', tokenRevoked: true, defaultAccount: 'owner' });
  assert.equal(gas.props.has('YT_ACCOUNT_second'), false);
  assert.equal(run('youtube_accounts_remove', { alias: 'owner' }).isError, true);
});

test('connect needs an OAuth client and rejects the reserved alias', () => {
  installGas();
  assert.match(run('youtube_accounts_connect', { alias: 'x' }).text, /OAUTH_CLIENT_ID/);
  withConnectedAccount(installGas());
  assert.equal(run('youtube_accounts_connect', { alias: 'owner' }).isError, true);
  assert.equal(run('youtube_accounts_connect', { alias: 'bad alias!' }).isError, true);
});

test('connect fails clearly when the web app URL is unknown', () => {
  const gas = withConnectedAccount(installGas());
  gas.props.delete('WEBAPP_URL');
  assert.match(run('youtube_accounts_connect', { alias: 'x' }).text, /web app URL is unknown/);
});

test('OAuth round trip stores the channel and the state is single-use', () => {
  const gas = withConnectedAccount(installGas());
  gas.on('oauth2.googleapis.com/token', response(200, { access_token: 'at', refresh_token: 'new-rt', expires_in: 3600 }));
  gas.on('/channels', response(200, { items: [{ id: 'UC9', snippet: { title: '<b>Brand</b>' } }] }));
  const auth = new URL(run('youtube_accounts_connect', { alias: 'brand' }).data.authUrl);
  assert.equal(auth.searchParams.get('redirect_uri'), WEBAPP_URL);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  const params = { state: auth.searchParams.get('state'), code: 'auth-code' };

  const page = app.doGet({ parameter: params });
  assert.match(page.html, /Channel connected/);
  assert.match(page.html, /&lt;b&gt;Brand&lt;\/b&gt;/);
  assert.equal(JSON.parse(gas.props.get('YT_ACCOUNT_brand')).refreshToken, 'new-rt');
  assert.match(app.doGet({ parameter: params }).html, /Link expired/);
});

test('OAuth callback rejects forged state, denial, a missing refresh token and channel-less accounts', () => {
  const gas = withConnectedAccount(installGas());
  assert.match(app.doGet({ parameter: { state: 'forged-state-value-000', code: 'c' } }).html, /Link expired/);
  const stateOf = () => new URL(run('youtube_accounts_connect', { alias: 'brand' }).data.authUrl).searchParams.get('state');
  assert.match(app.doGet({ parameter: { state: stateOf(), error: 'access_denied' } }).html, /access_denied/);

  let tokens = { access_token: 'at' };
  gas.on('oauth2.googleapis.com/token', () => response(200, tokens));
  gas.on('/channels', response(200, { items: [] }));
  assert.match(app.doGet({ parameter: { state: stateOf(), code: 'c' } }).html, /refresh token/);
  tokens = { access_token: 'at', refresh_token: 'rt2' };
  assert.match(app.doGet({ parameter: { state: stateOf(), code: 'c' } }).html, /no YouTube channel/);
  assert.equal(gas.props.has('YT_ACCOUNT_brand'), false);
});

test('video update merges changes into the existing mutable fields only', () => {
  const gas = installGas();
  gas.on((call) => call.options.method === 'get', response(200, { items: [VIDEO] }));
  gas.on((call) => call.options.method === 'put', response(200, { id: 'ID1' }));
  run('youtube_videos_update', { videoId: 'ID1', title: 'New title', privacyStatus: 'public' });
  const put = gas.calls[1];
  assert.equal(queryOf(put).part, 'snippet,status');
  assert.deepEqual(bodyOf(put), {
    id: 'ID1',
    snippet: { title: 'New title', description: 'Old description', tags: ['a'], categoryId: '10' },
    status: { privacyStatus: 'public' },
  });
});

test('a status-only update leaves the snippet untouched', () => {
  const gas = installGas();
  gas.on((call) => call.options.method === 'get', response(200, { items: [VIDEO] }));
  gas.on((call) => call.options.method === 'put', response(200, { id: 'ID1' }));
  run('youtube_videos_update', { videoId: 'ID1', publishAt: '2030-01-01T00:00:00Z' });
  assert.equal(queryOf(gas.calls[0]).part, 'status');
  assert.deepEqual(bodyOf(gas.calls[1]), { id: 'ID1', status: { privacyStatus: 'private', publishAt: '2030-01-01T00:00:00Z' } });
});

test('video update with nothing to change fails without calling the API', () => {
  const gas = installGas();
  assert.match(run('youtube_videos_update', { videoId: 'ID1' }).text, /at least one field/);
  assert.equal(gas.calls.length, 0);
});

test('a missing video gives a clear not-found error', () => {
  const gas = installGas();
  gas.on('/videos', response(200, { items: [] }));
  assert.match(run('youtube_videos_update', { videoId: 'gone', title: 'x' }).text, /Video "gone" was not found/);
});

test('delete sends a DELETE and reports success for an empty reply', () => {
  const gas = installGas();
  gas.on('/videos', response(204, ''));
  assert.deepEqual(run('youtube_videos_delete', { videoId: 'ID1' }).data, { success: true });
  assert.equal(gas.calls[0].options.method, 'delete');
  assert.deepEqual(queryOf(gas.calls[0]), { id: 'ID1' });
});

test('list_mine reads the uploads playlist', () => {
  const gas = installGas();
  gas.on('/channels', response(200, { items: [CHANNEL] }));
  gas.on('/playlistItems', response(200, { items: [] }));
  run('youtube_videos_list_mine', { maxResults: 5 });
  assert.deepEqual(queryOf(gas.calls[1]), { part: 'snippet,contentDetails,status', maxResults: '5', playlistId: 'UU1' });
});

test('list_mine explains an account without a channel', () => {
  const gas = installGas();
  gas.on('/channels', response(200, { items: [] }));
  assert.match(run('youtube_videos_list_mine').text, /no YouTube channel/);
});

test('categories default to the US region', () => {
  const gas = installGas();
  gas.on('/videoCategories', response(200, { items: [] }));
  run('youtube_video_categories_list');
  assert.deepEqual(queryOf(gas.calls[0]), { part: 'snippet', regionCode: 'US' });
});

test('thumbnail upload sends the image bytes with their type', () => {
  const gas = installGas();
  gas.on('img.test', response(200, Buffer.from([1, 2, 3]), { 'content-type': 'image/png; charset=binary' }));
  gas.on('/upload/youtube/v3/thumbnails/set', response(200, { items: [] }));
  assert.equal(run('youtube_thumbnails_set', { videoId: 'v1', url: 'https://img.test/t.png' }).isError, false);
  const upload = gas.calls[1];
  assert.deepEqual(queryOf(upload), { videoId: 'v1', uploadType: 'media' });
  assert.equal(upload.options.contentType, 'image/png');
  assert.deepEqual(upload.options.payload, [1, 2, 3]);
  assert.equal(gas.calls[0].options.headers.Authorization, undefined);
});

test('a Drive thumbnail is read with the owner token', () => {
  const gas = installGas();
  gas.on('/drive/v3/files/', response(200, Buffer.from([9]), { 'Content-Type': 'image/jpeg' }));
  gas.on('/thumbnails/set', response(200, {}));
  run('youtube_thumbnails_set', { videoId: 'v1', driveFileId: 'drive-file-id-1' });
  assert.match(gas.calls[0].url, /\/drive\/v3\/files\/drive-file-id-1\?alt=media/);
  assert.equal(gas.calls[0].options.headers.Authorization, 'Bearer owner-token');
});

test('media sources must be exactly one of a Drive ID or an https URL', () => {
  installGas();
  assert.match(run('youtube_thumbnails_set', { videoId: 'v' }).text, /exactly one/);
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', url: 'http://plain.test/a.png' }).text, /https/);
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', driveFileId: '../x' }).text, /not a valid/);
});

test('oversized or unreachable images are refused', () => {
  const gas = installGas();
  gas.on('img.test/big', response(200, Buffer.alloc(app.LIMITS.MAX_THUMBNAIL_BYTES + 1), { 'content-type': 'image/png' }));
  gas.on('img.test/gone', response(404, ''));
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', url: 'https://img.test/big.png' }).text, /must be between/);
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', url: 'https://img.test/gone.png' }).text, /HTTP 404/);
});
