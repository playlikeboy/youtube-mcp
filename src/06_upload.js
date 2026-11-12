/**
 * Resumable video upload. Apps Script cannot hold a large file in memory or run
 * for long, so the video is streamed chunk by chunk from the source. One call
 * uploads as many chunks as fit in its time budget; the rest is picked up by
 * youtube_videos_upload_continue using state kept in the script cache.
 */

function buildVideoResource_(args) {
  return {
    snippet: compact_({
      title: args.title,
      description: args.description,
      tags: args.tags,
      categoryId: args.categoryId || '22',
      defaultLanguage: args.defaultLanguage,
    }),
    status: compact_({
      privacyStatus: args.privacyStatus || 'private',
      publishAt: args.publishAt,
      selfDeclaredMadeForKids: args.selfDeclaredMadeForKids === true,
      embeddable: args.embeddable,
      license: args.license,
      containsSyntheticMedia: args.containsSyntheticMedia,
    }),
  };
}

/** Opens a resumable session and returns its upload URL. */
function openUploadSession_(resource, source, account, notifySubscribers) {
  const url =
    UPLOAD_BASE +
    '/videos' +
    toQueryString_({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: notifySubscribers });
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      ...authHeaders_(account),
      'X-Upload-Content-Type': source.mimeType,
      'X-Upload-Content-Length': String(source.size),
    },
    payload: JSON.stringify(resource),
    muteHttpExceptions: true,
  });
  const sessionUrl = findHeader_(response.getHeaders(), 'Location');
  if (response.getResponseCode() !== 200 || !sessionUrl) {
    throw createError_(describeApiError_(response.getResponseCode(), response.getContentText()));
  }
  return sessionUrl;
}

function startVideoUpload_(args) {
  const source = describeSource_(pickSource_(args));
  const account = resolveAccountAlias_(args.account);
  const sessionUrl = openUploadSession_(buildVideoResource_(args), source, account, args.notifySubscribers);
  const state = { id: Utilities.getUuid(), sessionUrl: sessionUrl, source: source, account: account, offset: 0 };
  return runUpload_(state, args.timeBudgetSeconds);
}

function resumeVideoUpload_(args) {
  const raw = scriptCache_().get(CACHE_KEYS.UPLOAD + args.uploadId);
  const state = raw ? safeJsonParse_(raw, null) : null;
  if (!state) {
    throw createError_('Unknown or expired uploadId. Start again with youtube_videos_upload.');
  }
  return runUpload_(state, args.timeBudgetSeconds);
}

function saveUploadState_(state) {
  scriptCache_().put(CACHE_KEYS.UPLOAD + state.id, JSON.stringify(state), LIMITS.UPLOAD_STATE_TTL_S);
}

function clampBudgetSeconds_(seconds) {
  const wanted = Number(seconds) || LIMITS.DEFAULT_TIME_BUDGET_S;
  return Math.max(1, Math.min(wanted, LIMITS.MAX_TIME_BUDGET_S));
}

/** Uploads chunks until the video is complete or the time budget is spent. */
function runUpload_(initialState, budgetSeconds) {
  const deadline = Date.now() + clampBudgetSeconds_(budgetSeconds) * 1000;
  let state = initialState;
  saveUploadState_(state);
  do {
    state = uploadChunkOrExplain_(state);
    saveUploadState_(state);
  } while (!state.video && Date.now() < deadline);
  if (state.video) {
    scriptCache_().remove(CACHE_KEYS.UPLOAD + state.id);
  }
  return uploadProgress_(state);
}

/** Adds the uploadId to failures so the caller knows the upload can be resumed. */
function uploadChunkOrExplain_(state) {
  try {
    return uploadNextChunk_(state);
  } catch (error) {
    throw createError_(
      redactSecrets_(error.message) + ' Upload "' + state.id + '" kept its progress (' + state.offset +
        ' bytes); retry with youtube_videos_upload_continue.'
    );
  }
}

/** Sends one chunk and returns the next state (with `video` once YouTube has the whole file). */
function uploadNextChunk_(state) {
  const size = state.source.size;
  const end = Math.min(state.offset + LIMITS.UPLOAD_CHUNK_BYTES, size) - 1;
  const bytes = fetchSourceRange_(state.source, state.offset, end);
  const response = UrlFetchApp.fetch(state.sessionUrl, {
    method: 'put',
    contentType: state.source.mimeType,
    headers: { ...authHeaders_(state.account), 'Content-Range': 'bytes ' + state.offset + '-' + end + '/' + size },
    payload: bytes,
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const code = response.getResponseCode();
  if (code === 308) {
    return { ...state, offset: nextOffset_(response) };
  }
  if (code === 200 || code === 201) {
    return { ...state, offset: size, video: safeJsonParse_(response.getContentText(), {}) };
  }
  throw createError_(describeApiError_(code, response.getContentText()));
}

/** A 308 reply carries "Range: bytes=0-N"; the next byte to send is N + 1. */
function nextOffset_(response) {
  const match = /-(\d+)\s*$/.exec(findHeader_(response.getHeaders(), 'Range') || '');
  return match ? Number(match[1]) + 1 : 0;
}

function uploadProgress_(state) {
  const total = state.source.size;
  if (state.video) {
    const videoId = state.video.id;
    return { status: 'completed', videoId: videoId, url: 'https://www.youtube.com/watch?v=' + videoId, video: state.video };
  }
  return {
    status: 'in_progress',
    uploadId: state.id,
    bytesUploaded: state.offset,
    totalBytes: total,
    percent: Math.floor((state.offset / total) * 100),
    next: 'Call youtube_videos_upload_continue with this uploadId until status is "completed".',
  };
}
