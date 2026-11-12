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
