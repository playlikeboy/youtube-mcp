/** Search, subscriptions, captions and channel memberships. */

const SUBSCRIPTION_PARTS = 'snippet,contentDetails';
const SEARCH_FILTERS = Object.freeze([
  'q', 'type', 'channelId', 'order', 'publishedAfter', 'publishedBefore', 'regionCode', 'relevanceLanguage',
  'videoDuration', 'eventType', 'safeSearch',
]);

function subscriptionFilter_(args) {
  if (args.mySubscribers) return { mySubscribers: true };
  if (args.channelId) return { channelId: args.channelId };
  return { mine: true };
}

function uploadCaption_(method, metadata, args) {
  const multipart = buildMultipartRelated_(metadata, toBytes_(args.content), 'application/octet-stream');
  return uploadMedia_({
    method: method,
    path: '/captions',
    query: { part: 'snippet', uploadType: 'multipart' },
    contentType: multipart.contentType,
    payload: multipart.payload,
    account: args.account,
  });
}

function updateCaption_(args) {
  const snippet = compact_({ isDraft: args.isDraft });
  if (args.content === undefined && isEmptyObject_(snippet)) {
    throw createError_('Provide "content" and/or "isDraft".');
  }
  const metadata = { id: args.captionId, snippet: snippet };
  if (args.content !== undefined) {
    return uploadCaption_('PUT', metadata, args);
  }
  return ytRequest_({ method: 'PUT', path: '/captions', query: { part: 'snippet' }, body: metadata, account: args.account });
}

function searchTools_() {
  return [
    apiTool_({
      name: 'youtube_search',
      title: 'Search YouTube',
      description:
        'Search videos, channels and playlists across YouTube, or within one channel. Set forMine to search the ' +
        "account's own videos, including private ones. Costs 100 quota units per call, so prefer the list tools when possible.",
      kind: 'read',
      props: {
        q: strProp_('Search query.'),
        type: strProp_('Result types, comma-separated: video, channel, playlist.'),
        channelId: strProp_('Only results from this channel.'),
        forMine: boolProp_("Only the account's own videos."),
        order: strProp_('Sort order.', ['relevance', 'date', 'viewCount', 'rating', 'title', 'videoCount']),
        publishedAfter: strProp_('ISO 8601 lower bound.'),
        publishedBefore: strProp_('ISO 8601 upper bound.'),
        regionCode: strProp_('ISO country code.'),
        relevanceLanguage: strProp_('ISO 639-1 language code.'),
        videoDuration: strProp_('Requires type=video.', ['any', 'short', 'medium', 'long']),
        eventType: strProp_('Live filter; requires type=video.', ['live', 'upcoming', 'completed']),
        safeSearch: strProp_('Content filter.', ['none', 'moderate', 'strict']),
        ...listProps_('snippet', 50),
      },
      request: function (a) {
        const mine = a.forMine ? { forMine: true, type: 'video' } : {};
        return { path: '/search', query: listQuery_(a, 'snippet', { ...pick_(a, SEARCH_FILTERS), ...mine }) };
      },
    }),
  ];
}

function subscriptionTools_() {
  return [
    apiTool_({
      name: 'youtube_subscriptions_list',
      title: 'List subscriptions or subscribers',
      description:
        'List the channels the account subscribes to, or (mySubscribers) the public subscribers of the account\'s channel.',
      kind: 'read',
      props: {
        mySubscribers: boolProp_("List the account's subscribers instead of its subscriptions."),
        channelId: strProp_("List another channel's public subscriptions."),
        forChannelId: strProp_('Check whether the listed subscriptions include these channel ID(s).'),
        order: strProp_('Sort order.', ['relevance', 'unread', 'alphabetical']),
        ...listProps_(SUBSCRIPTION_PARTS, 50),
      },
      request: function (a) {
        const extra = { ...subscriptionFilter_(a), ...pick_(a, ['forChannelId', 'order']) };
        return { path: '/subscriptions', query: listQuery_(a, SUBSCRIPTION_PARTS, extra) };
      },
    }),
    apiTool_({
      name: 'youtube_subscriptions_subscribe',
      title: 'Subscribe to a channel',
      description: 'Subscribe the account to a channel.',
      kind: 'write',
      props: { channelId: strProp_('Channel ID to subscribe to.') },
      required: ['channelId'],
      request: function (a) {
        const body = { snippet: { resourceId: { kind: 'youtube#channel', channelId: a.channelId } } };
        return { method: 'POST', path: '/subscriptions', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_subscriptions_unsubscribe',
      title: 'Unsubscribe from a channel',
      description: 'Remove a subscription. Needs the subscription ID from youtube_subscriptions_list, not the channel ID.',
      kind: 'delete',
      props: { subscriptionId: strProp_('Subscription ID.') },
      required: ['subscriptionId'],
      request: function (a) {
        return { method: 'DELETE', path: '/subscriptions', query: { id: a.subscriptionId } };
      },
    }),
  ];
}

function captionTools_() {
  const captionIdProp = strProp_('Caption track ID.');
  const contentProp = strProp_('Full text of the caption file (SRT, VTT, SBV or TTML).');
  return [
    apiTool_({
      name: 'youtube_captions_list',
      title: 'List caption tracks',
      description: 'List the caption tracks of a video.',
      kind: 'read',
      props: { videoId: strProp_('Video ID.') },
      required: ['videoId'],
      request: function (a) {
        return { path: '/captions', query: { part: 'snippet', videoId: a.videoId } };
      },
    }),
    apiTool_({
      name: 'youtube_captions_download',
      title: 'Download a caption track',
      description: "Download a caption track's text. Only works for videos the account owns.",
      kind: 'read',
      props: {
        captionId: captionIdProp,
        format: strProp_('Output format. Default srt.', ['srt', 'vtt', 'sbv', 'ttml', 'scc']),
        translateTo: strProp_('ISO 639-1 language to machine-translate the track into.'),
      },
      required: ['captionId'],
      request: function (a) {
        const query = { tfmt: a.format || 'srt', tlang: a.translateTo };
        return { path: '/captions/' + encodeURIComponent(a.captionId), query: query, raw: true };
      },
    }),
    defineTool_({
      name: 'youtube_captions_upload',
      title: 'Upload a caption track',
      description: 'Add a caption track to a video from caption file text.',
      kind: 'write',
      props: {
        videoId: strProp_('Video ID.'),
        language: strProp_('BCP-47 language of the track, e.g. "en".'),
        name: strProp_('Track name shown to viewers. Default empty.'),
        content: contentProp,
        isDraft: boolProp_('Keep the track hidden from viewers.'),
      },
      required: ['videoId', 'language', 'content'],
      handler: function (a) {
        const snippet = compact_({ videoId: a.videoId, language: a.language, name: a.name || '', isDraft: a.isDraft });
        return uploadCaption_('POST', { snippet: snippet }, a);
      },
    }),
    defineTool_({
      name: 'youtube_captions_update',
      title: 'Update a caption track',
      description: 'Replace the text of a caption track and/or publish or unpublish it.',
      kind: 'write',
      props: { captionId: captionIdProp, content: contentProp, isDraft: boolProp_('Whether the track is hidden from viewers.') },
      required: ['captionId'],
      handler: updateCaption_,
    }),
    apiTool_({
      name: 'youtube_captions_delete',
      title: 'Delete a caption track',
      description: 'Permanently delete a caption track.',
      kind: 'delete',
      props: { captionId: captionIdProp },
      required: ['captionId'],
      request: function (a) {
        return { method: 'DELETE', path: '/captions', query: { id: a.captionId } };
      },
    }),
  ];
}

function memberTools_() {
  return [
    apiTool_({
      name: 'youtube_members_list',
      title: 'List channel members',
      description: 'List paying channel members. Only works for channels with memberships enabled.',
      kind: 'read',
      props: {
        mode: strProp_('all_current (default) or updates for new members since the last call.', ['all_current', 'updates']),
        hasAccessToLevel: strProp_('Only members with access to this level ID.'),
        maxResults: intProp_('Page size, 1-1000.', 1, 1000),
        pageToken: strProp_('nextPageToken from an earlier call.'),
      },
      request: function (a) {
        const query = { part: 'snippet', ...pick_(a, ['mode', 'hasAccessToLevel', 'maxResults', 'pageToken']) };
        return { path: '/members', query: query };
      },
    }),
    apiTool_({
      name: 'youtube_membership_levels_list',
      title: 'List membership levels',
      description: "List the channel's membership levels.",
      kind: 'read',
      props: {},
      request: function () {
        return { path: '/membershipsLevels', query: { part: 'id,snippet' } };
      },
    }),
  ];
}

function communityTools_() {
  return [].concat(searchTools_(), subscriptionTools_(), captionTools_(), memberTools_());
}
