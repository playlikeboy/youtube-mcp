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

/** A resource rich enough for every read-merge-write handler. */
const ITEM = {
  id: 'ID1',
  snippet: { title: 'Old title', description: 'Old description', categoryId: '10', tags: ['a'], scheduledStartTime: '2030-01-01T00:00:00Z', thumbnails: {} },
  status: { privacyStatus: 'private', uploadStatus: 'processed' },
  contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
  brandingSettings: { channel: { title: 'Chan', description: 'Old' }, image: { bannerExternalUrl: 'old' } },
};

function withConnectedAccount(gas) {
  gas.props.set('OAUTH_CLIENT_ID', 'cid');
  gas.props.set('OAUTH_CLIENT_SECRET', 'csecret');
  gas.props.set('WEBAPP_URL', WEBAPP_URL);
  gas.props.set('YT_ACCOUNT_second', JSON.stringify({ refreshToken: 'rt', channelId: 'UC2', channelTitle: 'Second' }));
  return gas;
}

const SPECIAL_ARGS = {
  youtube_accounts_connect: { alias: 'third' },
  youtube_accounts_remove: { alias: 'second' },
  youtube_accounts_set_default: { alias: 'second' },
  youtube_channels_update: { description: 'New' },
  youtube_channel_banner_set: { url: 'https://img.test/banner.png' },
  youtube_watermark_set: { driveFileId: 'drive-file-id-1' },
  youtube_thumbnails_set: { videoId: 'v1', url: 'https://img.test/t.png' },
  youtube_videos_update: { videoId: 'ID1', title: 'New' },
  youtube_playlists_update: { playlistId: 'ID1', privacyStatus: 'public' },
  youtube_live_broadcasts_update: { broadcastId: 'ID1', title: 'New' },
  youtube_comment_threads_list: { videoId: 'v1' },
  youtube_comments_list: { parentId: 'c1' },
  youtube_captions_update: { captionId: 'cap1', isDraft: true },
  youtube_videos_rate: { videoId: 'v1', rating: 'like' },
  youtube_comments_set_moderation_status: { commentId: 'c1', moderationStatus: 'rejected' },
  youtube_live_broadcasts_transition: { broadcastId: 'b1', broadcastStatus: 'live' },
  youtube_api_request: { path: '/activities', query: { part: 'snippet', mine: true } },
};
const UPLOAD_TOOLS = ['youtube_videos_upload', 'youtube_videos_upload_continue'];

function dummyArgs(tool) {
  const fill = (name) => {
    const prop = tool.inputSchema.properties[name];
    if (prop.enum) return prop.enum[0];
    if (prop.type === 'integer') return prop.minimum || 1;
    return prop.type === 'boolean' ? true : 'value-' + name;
  };
  return Object.fromEntries(tool.inputSchema.required.map((name) => [name, fill(name)]));
}

test('every tool runs against a generic API reply and targets a Google API host', () => {
  app
    .allTools_()
    .filter((tool) => !UPLOAD_TOOLS.includes(tool.name))
    .forEach((tool) => {
      const gas = withConnectedAccount(installGas());
      gas.on(() => true, response(200, { items: [ITEM], url: 'https://banner.test/x', columnHeaders: [], rows: [] }, { 'Content-Type': 'image/png' }));
      const outcome = run(tool.name, SPECIAL_ARGS[tool.name] || dummyArgs(tool));
      assert.equal(outcome.isError, false, tool.name + ': ' + outcome.text);
      gas.calls
        .filter((call) => !call.url.startsWith('https://img.test/'))
        .forEach((call) => assert.match(call.url, /^https:\/\/(www|oauth2|youtubeanalytics|youtubereporting)\.googleapis\.com\//, tool.name));
    });
});

test('requests carry the owner token by default', () => {
  const gas = installGas();
  gas.on('/playlists', response(200, { items: [] }));
  run('youtube_playlists_list');
  assert.equal(gas.calls[0].options.headers.Authorization, 'Bearer owner-token');
  assert.deepEqual(queryOf(gas.calls[0]), { part: 'snippet,status,contentDetails', mine: 'true' });
});

test('a connected account refreshes its token once and caches it', () => {
  const gas = withConnectedAccount(installGas());
  gas.on('oauth2.googleapis.com/token', response(200, { access_token: 'second-token', expires_in: 3600 }));
  gas.on('/playlists', response(200, { items: [] }));
  run('youtube_playlists_list', { account: 'second' });
  run('youtube_playlists_list', { account: 'second' });
  const tokenCalls = gas.calls.filter((call) => call.url.includes('/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].options.payload.refresh_token, 'rt');
  assert.equal(gas.calls[2].options.headers.Authorization, 'Bearer second-token');
});

test('an unknown account is rejected before any request is sent', () => {
  const gas = installGas();
  const outcome = run('youtube_playlists_list', { account: 'ghost' });
  assert.equal(outcome.isError, true);
  assert.equal(gas.calls.length, 0);
});

test('accounts_list never exposes refresh tokens', () => {
  withConnectedAccount(installGas());
  const outcome = run('youtube_accounts_list');
  assert.doesNotMatch(outcome.text, /"rt"|refreshToken/);
  assert.deepEqual(outcome.data.accounts.map((account) => account.alias), ['owner', 'second']);
});

test('removing the default account revokes it and falls back to owner', () => {
  const gas = withConnectedAccount(installGas());
  gas.on('/revoke', response(200, {}));
  run('youtube_accounts_set_default', { alias: 'second' });
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

test('OAuth callback rejects forged state, denial and a missing refresh token', () => {
  const gas = withConnectedAccount(installGas());
  assert.match(app.doGet({ parameter: { state: 'forged-state-value-000', code: 'c' } }).html, /Link expired/);
  const stateOf = () => new URL(run('youtube_accounts_connect', { alias: 'brand' }).data.authUrl).searchParams.get('state');
  assert.match(app.doGet({ parameter: { state: stateOf(), error: 'access_denied' } }).html, /access_denied/);
  gas.on('oauth2.googleapis.com/token', response(200, { access_token: 'at' }));
  assert.match(app.doGet({ parameter: { state: stateOf(), code: 'c' } }).html, /refresh token/);
  assert.equal(gas.props.has('YT_ACCOUNT_brand'), false);
});

test('video update merges changes into the existing mutable fields only', () => {
  const gas = installGas();
  gas.on((call) => call.options.method === 'get', response(200, { items: [ITEM] }));
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

test('video update with nothing to change fails without calling the API', () => {
  const gas = installGas();
  assert.match(run('youtube_videos_update', { videoId: 'ID1' }).text, /at least one field/);
  assert.equal(gas.calls.length, 0);
});

test('a missing resource gives a clear not-found error', () => {
  const gas = installGas();
  gas.on('/videos', response(200, { items: [] }));
  assert.match(run('youtube_videos_update', { videoId: 'gone', title: 'x' }).text, /Video "gone" was not found/);
});

test('channel update keeps the other branding settings', () => {
  const gas = installGas();
  gas.on((call) => call.options.method === 'get', response(200, { items: [ITEM] }));
  gas.on((call) => call.options.method === 'put', response(200, {}));
  run('youtube_channels_update', { description: 'New', selfDeclaredMadeForKids: false });
  const put = gas.calls[1];
  assert.equal(queryOf(put).part, 'brandingSettings,status');
  assert.deepEqual(bodyOf(put).brandingSettings, { channel: { title: 'Chan', description: 'New' }, image: { bannerExternalUrl: 'old' } });
  assert.deepEqual(bodyOf(put).status, { selfDeclaredMadeForKids: false });
});

test('posting a comment and moderating build the documented requests', () => {
  const gas = installGas();
  gas.on(() => true, response(204, ''));
  run('youtube_comments_post', { videoId: 'v1', text: 'Nice' });
  assert.deepEqual(bodyOf(gas.calls[0]), { snippet: { videoId: 'v1', topLevelComment: { snippet: { textOriginal: 'Nice' } } } });
  const moderated = run('youtube_comments_set_moderation_status', { commentId: 'c1,c2', moderationStatus: 'rejected', banAuthor: true });
  assert.deepEqual(moderated.data, { success: true });
  assert.deepEqual(queryOf(gas.calls[1]), { id: 'c1,c2', moderationStatus: 'rejected', banAuthor: 'true' });
});

test('list_mine reads the uploads playlist', () => {
  const gas = installGas();
  gas.on('/channels', response(200, { items: [ITEM] }));
  gas.on('/playlistItems', response(200, { items: [] }));
  run('youtube_videos_list_mine', { maxResults: 5 });
  assert.deepEqual(queryOf(gas.calls[1]), { part: 'snippet,contentDetails,status', maxResults: '5', playlistId: 'UU1' });
});

test('analytics defaults to channel totals and returns rows as objects', () => {
  const gas = installGas();
  gas.on('youtubeanalytics', response(200, { columnHeaders: [{ name: 'day' }, { name: 'views' }], rows: [['2026-01-01', 5]] }));
  const outcome = run('youtube_analytics_query', { dimensions: 'day', startDate: '2026-01-01', endDate: '2026-01-02' });
  assert.deepEqual(outcome.data.rows, [{ day: '2026-01-01', views: 5 }]);
  assert.equal(queryOf(gas.calls[0]).ids, 'channel==MINE');
});

test('caption download returns raw text; caption upload is multipart', () => {
  const gas = installGas();
  gas.on('/captions/cap1', response(200, '1\n00:00:01,000 --> 00:00:02,000\nHi'));
  gas.on('/upload/youtube/v3/captions', response(200, { id: 'cap2' }));
  assert.match(run('youtube_captions_download', { captionId: 'cap1' }).data.content, /Hi$/);
  run('youtube_captions_upload', { videoId: 'v1', language: 'en', content: 'WEBVTT' });
  const upload = gas.calls[1];
  assert.match(upload.options.contentType, /^multipart\/related; boundary=/);
  const sent = Buffer.from(upload.options.payload).toString('utf8');
  assert.match(sent, /"language":"en"/);
  assert.match(sent, /WEBVTT\r\n--ytmcp[0-9a-f]+--$/);
});

test('generic request validates the path and the API name', () => {
  const gas = installGas();
  gas.on('/activities', response(200, { items: [] }));
  assert.equal(run('youtube_api_request', { path: '/activities', query: { part: 'snippet', mine: true } }).isError, false);
  assert.equal(gas.calls[0].url, 'https://www.googleapis.com/youtube/v3/activities?part=snippet&mine=true');
  ['https://evil.test/x', '/../oauth2/v1', '/a?b=1', '//evil.test'].forEach((path) => {
    assert.equal(run('youtube_api_request', { path }).isError, true, path);
  });
  assert.equal(run('youtube_api_request', { path: '/x', api: 'drive' }).isError, true);
  assert.equal(gas.calls.length, 1);
});

test('media sources must be exactly one of a Drive ID or an https URL', () => {
  installGas();
  assert.match(run('youtube_thumbnails_set', { videoId: 'v' }).text, /exactly one/);
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', url: 'http://plain.test/a.png' }).text, /https/);
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', driveFileId: '../x' }).text, /not a valid/);
});

test('oversized images are refused', () => {
  const gas = installGas();
  gas.on('img.test', response(200, Buffer.alloc(app.LIMITS.MAX_THUMBNAIL_BYTES + 1), { 'content-type': 'image/png' }));
  assert.match(run('youtube_thumbnails_set', { videoId: 'v', url: 'https://img.test/big.png' }).text, /must be between/);
});
