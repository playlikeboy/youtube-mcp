'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, installGas, response } = require('./helpers/gas');

const app = loadBundle();
const CHUNK = app.LIMITS.UPLOAD_CHUNK_BYTES;
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION';

function run(name, args) {
  const result = app.callTool_({ name, arguments: args });
  return { isError: result.isError, text: result.content[0].text, data: result.isError ? null : JSON.parse(result.content[0].text) };
}

function rangeOf(call) {
  const [start, end] = call.options.headers.Range.replace('bytes=', '').split('-').map(Number);
  return { start, end };
}

/** Fakes a Drive file of `size` bytes and a resumable session that accepts every chunk. */
function fakeUpload(gas, size) {
  gas.on((call) => call.url.includes('/drive/v3/files/') && call.url.includes('fields='), response(200, { size: String(size), mimeType: 'video/mp4' }));
  gas.on((call) => call.url.includes('alt=media'), (call) => {
    const { start, end } = rangeOf(call);
    return response(206, Buffer.alloc(end - start + 1));
  });
  gas.on((call) => call.options.method === 'post' && call.url.includes('uploadType=resumable'), response(200, '', { location: SESSION }));
  gas.on((call) => call.options.method === 'put', (call) => {
    const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(call.options.headers['Content-Range']).map(Number);
    return end + 1 === total ? response(200, { id: 'VIDEO1' }) : response(308, '', { Range: 'bytes=0-' + end });
  });
  return gas;
}

const UPLOAD_ARGS = { driveFileId: 'drive-file-id-1', title: 'My video', tags: ['x'], timeBudgetSeconds: 1 };

test('a small video uploads in one call with the metadata and defaults', () => {
  const gas = fakeUpload(installGas(), 1000);
  const outcome = run('youtube_videos_upload', UPLOAD_ARGS);
  assert.equal(outcome.data.status, 'completed');
  assert.equal(outcome.data.url, 'https://www.youtube.com/watch?v=VIDEO1');
  const open = gas.calls.find((call) => call.options.method === 'post');
  assert.equal(open.options.headers['X-Upload-Content-Length'], '1000');
  assert.deepEqual(JSON.parse(open.options.payload), {
    snippet: { title: 'My video', tags: ['x'], categoryId: '22' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  });
  const put = gas.calls.find((call) => call.options.method === 'put');
  assert.equal(put.options.headers['Content-Range'], 'bytes 0-999/1000');
  assert.equal(gas.cache.size, 0);
});

test('a large video continues across calls from the confirmed offset', (t) => {
  const size = CHUNK * 2 + 10;
  const gas = fakeUpload(installGas(), size);
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 5000));

  const first = run('youtube_videos_upload', UPLOAD_ARGS);
  assert.equal(first.data.status, 'in_progress');
  assert.equal(first.data.bytesUploaded, CHUNK);
  assert.doesNotMatch(first.text, /upload_id/);

  const second = run('youtube_videos_upload_continue', { uploadId: first.data.uploadId, timeBudgetSeconds: 300 });
  assert.equal(second.data.status, 'completed');
  const ranges = gas.calls.filter((call) => call.options.method === 'put').map((call) => call.options.headers['Content-Range']);
  assert.deepEqual(ranges, [
    'bytes 0-' + (CHUNK - 1) + '/' + size,
    'bytes ' + CHUNK + '-' + (CHUNK * 2 - 1) + '/' + size,
    'bytes ' + CHUNK * 2 + '-' + (size - 1) + '/' + size,
  ]);
});

test('a failed chunk keeps the upload resumable and hides the session URL', () => {
  const gas = installGas();
  gas.on((call) => call.options.method === 'put', response(503, 'backend error'));
  fakeUpload(gas, 1000);
  const outcome = run('youtube_videos_upload', UPLOAD_ARGS);
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /retry with youtube_videos_upload_continue/);
  assert.doesNotMatch(outcome.text, /upload_id=SESSION/);
  assert.equal(gas.cache.size, 1);
});

test('unknown upload ids and unreadable sources are rejected', () => {
  const gas = installGas();
  assert.match(run('youtube_videos_upload_continue', { uploadId: 'nope' }).text, /Unknown or expired/);
  gas.on('/drive/v3/files/', response(404, {}));
  assert.match(run('youtube_videos_upload', UPLOAD_ARGS).text, /Could not read Drive file/);
});

test('URL sources need range support', () => {
  const gas = installGas();
  gas.on('https://cdn.test/a.mp4', response(200, 'whole file'));
  assert.match(run('youtube_videos_upload', { url: 'https://cdn.test/a.mp4', title: 't' }).text, /range requests/);

  const ranged = fakeUpload(installGas(), 0);
  ranged.routes.unshift({
    test: (call) => call.url === 'https://cdn.test/b.mp4',
    reply: (call) => {
      const { start, end } = rangeOf(call);
      return response(206, Buffer.alloc(end - start + 1), { 'content-range': 'bytes ' + start + '-' + end + '/500', 'content-type': 'video/mp4; x=1' });
    },
  });
  assert.equal(run('youtube_videos_upload', { url: 'https://cdn.test/b.mp4', title: 't' }).data.status, 'completed');
});
