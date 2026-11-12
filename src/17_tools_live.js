/** Live streaming: broadcasts, ingestion streams and live chat. */

const BROADCAST_PARTS = 'snippet,status,contentDetails';
const STREAM_PARTS = 'snippet,cdn,status,contentDetails';
const BROADCAST_SNIPPET_FIELDS = Object.freeze(['title', 'description', 'scheduledStartTime', 'scheduledEndTime']);
const BROADCAST_STATUS_FIELDS = Object.freeze(['privacyStatus', 'selfDeclaredMadeForKids']);

function broadcastProps_() {
  return {
    title: strProp_('Broadcast title.'),
    description: strProp_('Broadcast description.'),
    scheduledStartTime: strProp_('ISO 8601 start time.'),
    scheduledEndTime: strProp_('ISO 8601 end time.'),
    privacyStatus: strProp_('Visibility.', PRIVACY_VALUES),
    selfDeclaredMadeForKids: boolProp_('Whether the broadcast is made for kids.'),
  };
}

/** The API accepts exactly one of id / broadcastStatus / mine. */
function broadcastFilter_(args) {
  if (args.id) return { id: args.id };
  if (args.broadcastStatus) return { broadcastStatus: args.broadcastStatus };
  return { mine: true };
}

function createBroadcastRequest_(args) {
  const body = {
    snippet: compact_(pick_(args, BROADCAST_SNIPPET_FIELDS)),
    status: compact_({
      privacyStatus: args.privacyStatus || 'private',
      selfDeclaredMadeForKids: args.selfDeclaredMadeForKids === true,
    }),
    contentDetails: compact_({
      enableAutoStart: args.enableAutoStart,
      enableAutoStop: args.enableAutoStop,
      enableDvr: args.enableDvr,
    }),
  };
  return { method: 'POST', path: '/liveBroadcasts', query: { part: BROADCAST_PARTS }, body: body };
}

function createStreamRequest_(args) {
  const body = {
    snippet: compact_(pick_(args, ['title', 'description'])),
    cdn: {
      ingestionType: args.ingestionType || 'rtmp',
      resolution: args.resolution || 'variable',
      frameRate: args.frameRate || 'variable',
    },
    contentDetails: { isReusable: args.isReusable !== false },
  };
  return { method: 'POST', path: '/liveStreams', query: { part: 'snippet,cdn,contentDetails' }, body: body };
}

function broadcastTools_() {
  const broadcastIdProp = strProp_('Broadcast ID (same as its video ID).');
  return [
    apiTool_({
      name: 'youtube_live_broadcasts_list',
      title: 'List live broadcasts',
      description: "List the account's live broadcasts, optionally by status. The liveChatId is in snippet.liveChatId.",
      kind: 'read',
      props: {
        id: strProp_('Broadcast ID(s), comma-separated.'),
        broadcastStatus: strProp_('Filter by status.', ['active', 'all', 'completed', 'upcoming']),
        ...listProps_(BROADCAST_PARTS, 50),
      },
      request: function (a) {
        return { path: '/liveBroadcasts', query: listQuery_(a, BROADCAST_PARTS, broadcastFilter_(a)) };
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_create',
      title: 'Schedule a live broadcast',
      description:
        'Schedule a live broadcast. To go live, also create a stream (youtube_live_streams_create), bind it ' +
        '(youtube_live_broadcasts_bind), send video to the ingestion address, then transition to live.',
      kind: 'write',
      props: {
        ...broadcastProps_(),
        enableAutoStart: boolProp_('Go live automatically when the stream starts sending data.'),
        enableAutoStop: boolProp_('End automatically when the stream stops.'),
        enableDvr: boolProp_('Let viewers rewind during the broadcast.'),
      },
      required: ['title', 'scheduledStartTime'],
      request: createBroadcastRequest_,
    }),
    defineTool_({
      name: 'youtube_live_broadcasts_update',
      title: 'Update a live broadcast',
      description: 'Change a broadcast\'s title, description, schedule or visibility. Fields you omit are preserved.',
      kind: 'write',
      props: { broadcastId: broadcastIdProp, ...broadcastProps_() },
      required: ['broadcastId'],
      handler: function (a) {
        return mergeUpdate_({
          path: '/liveBroadcasts',
          id: a.broadcastId,
          account: a.account,
          label: 'Broadcast',
          parts: {
            snippet: partChanges_(a, BROADCAST_SNIPPET_FIELDS),
            status: partChanges_(a, BROADCAST_STATUS_FIELDS),
          },
        });
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_delete',
      title: 'Delete a live broadcast',
      description: 'Permanently delete a broadcast.',
      kind: 'delete',
      props: { broadcastId: broadcastIdProp },
      required: ['broadcastId'],
      request: function (a) {
        return { method: 'DELETE', path: '/liveBroadcasts', query: { id: a.broadcastId } };
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_bind',
      title: 'Bind a stream to a broadcast',
      description: 'Attach an ingestion stream to a broadcast. Omit streamId to unbind.',
      kind: 'write',
      props: { broadcastId: broadcastIdProp, streamId: strProp_('Stream ID. Omit to unbind.') },
      required: ['broadcastId'],
      request: function (a) {
        const query = { id: a.broadcastId, streamId: a.streamId, part: BROADCAST_PARTS };
        return { method: 'POST', path: '/liveBroadcasts/bind', query: query };
      },
    }),
    apiTool_({
      name: 'youtube_live_broadcasts_transition',
      title: 'Start or end a live broadcast',
      description: 'Move a broadcast to testing, live or complete. The bound stream must be active before going live.',
      kind: 'write',
      props: { broadcastId: broadcastIdProp, broadcastStatus: strProp_('Target status.', ['testing', 'live', 'complete']) },
      required: ['broadcastId', 'broadcastStatus'],
      request: function (a) {
        const query = { id: a.broadcastId, broadcastStatus: a.broadcastStatus, part: 'snippet,status' };
        return { method: 'POST', path: '/liveBroadcasts/transition', query: query };
      },
    }),
  ];
}

function streamTools_() {
  return [
    apiTool_({
      name: 'youtube_live_streams_list',
      title: 'List live streams',
      description:
        "List the account's ingestion streams. The response includes the RTMP address and the secret stream key " +
        '(cdn.ingestionInfo); do not share it.',
      kind: 'read',
      props: { id: strProp_('Stream ID(s), comma-separated.'), ...listProps_(STREAM_PARTS, 50) },
      request: function (a) {
        return { path: '/liveStreams', query: listQuery_(a, STREAM_PARTS, a.id ? { id: a.id } : { mine: true }) };
      },
    }),
    apiTool_({
      name: 'youtube_live_streams_create',
      title: 'Create a live stream',
      description: 'Create an ingestion stream (the encoder endpoint) to bind to broadcasts.',
      kind: 'write',
      props: {
        title: strProp_('Stream title.'),
        description: strProp_('Stream description.'),
        ingestionType: strProp_('Default rtmp.', ['rtmp', 'dash', 'hls', 'webrtc']),
        resolution: strProp_('e.g. 1080p, 720p or variable (default).'),
        frameRate: strProp_('30fps, 60fps or variable (default).'),
        isReusable: boolProp_('Whether the stream can serve several broadcasts. Default true.'),
      },
      required: ['title'],
      request: createStreamRequest_,
    }),
    apiTool_({
      name: 'youtube_live_streams_delete',
      title: 'Delete a live stream',
      description: 'Permanently delete an ingestion stream.',
      kind: 'delete',
      props: { streamId: strProp_('Stream ID.') },
      required: ['streamId'],
      request: function (a) {
        return { method: 'DELETE', path: '/liveStreams', query: { id: a.streamId } };
      },
    }),
  ];
}

function liveChatTools_() {
  const chatIdProp = strProp_('Live chat ID (snippet.liveChatId of the broadcast).');
  return [
    apiTool_({
      name: 'youtube_live_chat_messages_list',
      title: 'Read live chat',
      description: 'Read messages from a live chat. Pass the returned nextPageToken to fetch only newer messages.',
      kind: 'read',
      props: { liveChatId: chatIdProp, maxResults: intProp_('Page size, 200-2000.', 200, 2000), pageToken: strProp_('nextPageToken from an earlier call.') },
      required: ['liveChatId'],
      request: function (a) {
        const query = { part: 'snippet,authorDetails', ...pick_(a, ['liveChatId', 'maxResults', 'pageToken']) };
        return { path: '/liveChat/messages', query: query };
      },
    }),
    apiTool_({
      name: 'youtube_live_chat_messages_send',
      title: 'Send a live chat message',
      description: "Post a message to a live chat as the account's channel.",
      kind: 'write',
      props: { liveChatId: chatIdProp, text: strProp_('Message text (max 200 characters).') },
      required: ['liveChatId', 'text'],
      request: function (a) {
        const snippet = { liveChatId: a.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: a.text } };
        return { method: 'POST', path: '/liveChat/messages', query: { part: 'snippet' }, body: { snippet: snippet } };
      },
    }),
    apiTool_({
      name: 'youtube_live_chat_messages_delete',
      title: 'Delete a live chat message',
      description: 'Delete a message from a live chat the account moderates.',
      kind: 'delete',
      props: { messageId: strProp_('Live chat message ID.') },
      required: ['messageId'],
      request: function (a) {
        return { method: 'DELETE', path: '/liveChat/messages', query: { id: a.messageId } };
      },
    }),
  ];
}

function liveTools_() {
  return [].concat(broadcastTools_(), streamTools_(), liveChatTools_());
}
