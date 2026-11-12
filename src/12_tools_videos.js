/** Videos: list, upload, update, delete, rate, thumbnails, categories. */

const VIDEO_PARTS = 'snippet,contentDetails,statistics,status';
const VIDEO_SNIPPET_FIELDS = Object.freeze(['title', 'description', 'tags', 'categoryId', 'defaultLanguage']);
const VIDEO_STATUS_FIELDS = Object.freeze([
  'privacyStatus', 'publishAt', 'embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia',
]);
const UPLOADS_PARTS = 'snippet,contentDetails,status';

function videoMetadataProps_() {
  return {
    title: strProp_('Video title (max 100 characters).'),
    description: strProp_('Video description.'),
    tags: listProp_('Keyword tags.'),
    categoryId: strProp_('Category ID from youtube_video_categories_list. Uploads default to "22" (People & Blogs).'),
    defaultLanguage: strProp_('BCP-47 language of the title and description.'),
    privacyStatus: strProp_('Visibility. Uploads default to private.', PRIVACY_VALUES),
    publishAt: strProp_('ISO 8601 time to publish automatically. Requires privacyStatus "private".'),
    embeddable: boolProp_('Whether the video can be embedded on other sites.'),
    license: strProp_('License.', ['youtube', 'creativeCommon']),
    selfDeclaredMadeForKids: boolProp_('Whether the video is made for kids.'),
    containsSyntheticMedia: boolProp_('Declare realistic altered or AI-generated content.'),
  };
}

/** The account's uploads, newest first, read from its "uploads" playlist (cheap on quota). */
function listMyUploads_(args) {
  const channel = getOwnChannel_('contentDetails', args.account);
  const uploads = ((channel.contentDetails || {}).relatedPlaylists || {}).uploads;
  if (!uploads) {
    throw createError_('This channel has no uploads playlist yet.');
  }
  return ytRequest_({
    path: '/playlistItems',
    query: listQuery_(args, UPLOADS_PARTS, { playlistId: uploads }),
    account: args.account,
  });
}

function updateVideo_(args) {
  return mergeUpdate_({
    path: '/videos',
    id: args.videoId,
    account: args.account,
    label: 'Video',
    parts: {
      snippet: partChanges_(args, VIDEO_SNIPPET_FIELDS),
      status: partChanges_(args, VIDEO_STATUS_FIELDS),
    },
  });
}

function setThumbnail_(args) {
  const image = fetchSourceBlob_(pickSource_(args), LIMITS.MAX_THUMBNAIL_BYTES);
  return uploadMedia_({
    path: '/thumbnails/set',
    query: { videoId: args.videoId, uploadType: 'media' },
    contentType: image.mimeType,
    payload: image.bytes,
    account: args.account,
  });
}

function videoTools_() {
  const videoIdProp = strProp_('Video ID.');
  const budgetProp = intProp_(
    'Seconds this call may spend uploading before it returns progress. Default 40; keep it below your client timeout.',
    1,
    LIMITS.MAX_TIME_BUDGET_S
  );
  return [
    apiTool_({
      name: 'youtube_videos_list',
      title: 'Get videos',
      description:
        'Get the current title, description, tags, visibility and statistics of videos by ID. ' +
        'Use youtube_videos_list_mine to find the IDs of a channel\'s own uploads.',
      kind: 'read',
      props: {
        id: strProp_('Video ID(s), comma-separated (max 50).'),
        part: strProp_('Resource parts to return, comma-separated. Default: ' + VIDEO_PARTS + '.'),
        fields: strProp_('Partial-response selector to shrink the result, e.g. "items(id,snippet/title)".'),
      },
      required: ['id'],
      request: function (a) {
        return { path: '/videos', query: { part: a.part || VIDEO_PARTS, fields: a.fields, id: a.id } };
      },
    }),
    defineTool_({
      name: 'youtube_videos_list_mine',
      title: 'List my uploads',
      description:
        "List the account's own uploaded videos, newest first, including private and unlisted ones. Returns " +
        'playlist items; the video ID is contentDetails.videoId. Pass those IDs to youtube_videos_list for statistics.',
      kind: 'read',
      props: listProps_(UPLOADS_PARTS, 50),
      handler: listMyUploads_,
    }),
    defineTool_({
      name: 'youtube_videos_upload',
      title: 'Upload a video',
      description:
        'Upload a video from Google Drive or an https URL. Large files take several calls: when the result has ' +
        'status "in_progress", call youtube_videos_upload_continue with the returned uploadId until it is ' +
        '"completed". Costs a large share of daily API quota. Videos uploaded through an unaudited API project ' +
        'are locked to private by YouTube.',
      kind: 'write',
      props: {
        ...SOURCE_PROPS,
        ...videoMetadataProps_(),
        notifySubscribers: boolProp_('Notify subscribers about the upload. Default true.'),
        timeBudgetSeconds: budgetProp,
      },
      required: ['title'],
      handler: startVideoUpload_,
    }),
    defineTool_({
      name: 'youtube_videos_upload_continue',
      title: 'Continue a video upload',
      description: 'Upload the next chunks of a video started with youtube_videos_upload. Repeat until status is "completed".',
      kind: 'write',
      noAccount: true,
      props: { uploadId: strProp_('uploadId returned by youtube_videos_upload.'), timeBudgetSeconds: budgetProp },
      required: ['uploadId'],
      handler: resumeVideoUpload_,
    }),
    defineTool_({
      name: 'youtube_videos_update',
      title: 'Update a video',
      description:
        'Change a video\'s title, description, tags, category, visibility, schedule or other settings. Only the ' +
        'fields you pass change; the rest are preserved.',
      kind: 'write',
      props: { videoId: videoIdProp, ...videoMetadataProps_(), publicStatsViewable: boolProp_('Show like counts publicly.') },
      required: ['videoId'],
      handler: updateVideo_,
    }),
    apiTool_({
      name: 'youtube_videos_delete',
      title: 'Delete a video',
      description: 'Permanently delete a video. This cannot be undone.',
      kind: 'delete',
      props: { videoId: videoIdProp },
      required: ['videoId'],
      request: function (a) {
        return { method: 'DELETE', path: '/videos', query: { id: a.videoId } };
      },
    }),
    defineTool_({
      name: 'youtube_thumbnails_set',
      title: 'Set video thumbnail',
      description: 'Upload a custom thumbnail (JPG or PNG, max 2 MB, 1280x720 recommended) for a video.',
      kind: 'write',
      props: { ...SOURCE_PROPS, videoId: videoIdProp },
      required: ['videoId'],
      handler: setThumbnail_,
    }),
    apiTool_({
      name: 'youtube_video_categories_list',
      title: 'List video categories',
      description: 'List the video categories (and their IDs) available in a region.',
      kind: 'read',
      props: { regionCode: strProp_('ISO country code. Default US.') },
      request: function (a) {
        return { path: '/videoCategories', query: { part: 'snippet', regionCode: a.regionCode || 'US' } };
      },
    }),
  ];
}
