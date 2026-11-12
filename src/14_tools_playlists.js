/** Playlists and the videos inside them. */

const PLAYLIST_PARTS = 'snippet,status,contentDetails';
const PLAYLIST_ITEM_PARTS = 'snippet,contentDetails,status';

function playlistItemBody_(args) {
  return compact_({
    id: args.playlistItemId,
    snippet: compact_({
      playlistId: args.playlistId,
      position: args.position,
      resourceId: { kind: 'youtube#video', videoId: args.videoId },
    }),
  });
}

function playlistTools_() {
  const playlistIdProp = strProp_('Playlist ID.');
  const positionProp = intProp_('Zero-based position in the playlist.', 0);
  return [
    apiTool_({
      name: 'youtube_playlists_list',
      title: 'List playlists',
      description: "List playlists by ID or channel. With no filter it returns the account's own playlists.",
      kind: 'read',
      props: { id: strProp_('Playlist ID(s), comma-separated.'), channelId: strProp_('Channel ID.'), ...listProps_(PLAYLIST_PARTS, 50) },
      request: function (a) {
        const filter = a.id ? { id: a.id } : a.channelId ? { channelId: a.channelId } : { mine: true };
        return { path: '/playlists', query: listQuery_(a, PLAYLIST_PARTS, filter) };
      },
    }),
    apiTool_({
      name: 'youtube_playlists_create',
      title: 'Create a playlist',
      description: 'Create a new playlist on the account\'s channel.',
      kind: 'write',
      props: {
        title: strProp_('Playlist title.'),
        description: strProp_('Playlist description.'),
        privacyStatus: strProp_('Visibility. Default private.', PRIVACY_VALUES),
        defaultLanguage: strProp_('BCP-47 language code.'),
      },
      required: ['title'],
      request: function (a) {
        const body = {
          snippet: compact_(pick_(a, ['title', 'description', 'defaultLanguage'])),
          status: { privacyStatus: a.privacyStatus || 'private' },
        };
        return { method: 'POST', path: '/playlists', query: { part: 'snippet,status' }, body: body };
      },
    }),
    defineTool_({
      name: 'youtube_playlists_update',
      title: 'Update a playlist',
      description: 'Change a playlist\'s title, description, language or visibility. Fields you omit are preserved.',
      kind: 'write',
      props: {
        playlistId: playlistIdProp,
        title: strProp_('Playlist title.'),
        description: strProp_('Playlist description.'),
        defaultLanguage: strProp_('BCP-47 language code.'),
        privacyStatus: strProp_('Visibility.', PRIVACY_VALUES),
      },
      required: ['playlistId'],
      handler: function (a) {
        return mergeUpdate_({
          path: '/playlists',
          id: a.playlistId,
          account: a.account,
          label: 'Playlist',
          parts: {
            snippet: partChanges_(a, ['title', 'description', 'defaultLanguage']),
            status: partChanges_(a, ['privacyStatus']),
          },
        });
      },
    }),
    apiTool_({
      name: 'youtube_playlists_delete',
      title: 'Delete a playlist',
      description: 'Permanently delete a playlist. The videos themselves are not deleted.',
      kind: 'delete',
      props: { playlistId: playlistIdProp },
      required: ['playlistId'],
      request: function (a) {
        return { method: 'DELETE', path: '/playlists', query: { id: a.playlistId } };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_list',
      title: 'List videos in a playlist',
      description: 'List the videos in a playlist, in order. Each item has its own playlistItemId, needed to move or remove it.',
      kind: 'read',
      props: { playlistId: playlistIdProp, ...listProps_(PLAYLIST_ITEM_PARTS, 50) },
      required: ['playlistId'],
      request: function (a) {
        return { path: '/playlistItems', query: listQuery_(a, PLAYLIST_ITEM_PARTS, { playlistId: a.playlistId }) };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_add',
      title: 'Add a video to a playlist',
      description: 'Add a video to a playlist, optionally at a given position.',
      kind: 'write',
      props: { playlistId: playlistIdProp, videoId: strProp_('Video ID.'), position: positionProp },
      required: ['playlistId', 'videoId'],
      request: function (a) {
        return { method: 'POST', path: '/playlistItems', query: { part: 'snippet' }, body: playlistItemBody_(a) };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_move',
      title: 'Move a video within a playlist',
      description: 'Change the position of an item in a playlist.',
      kind: 'write',
      props: {
        playlistItemId: strProp_('Playlist item ID (from youtube_playlist_items_list).'),
        playlistId: playlistIdProp,
        videoId: strProp_('Video ID of that item.'),
        position: positionProp,
      },
      required: ['playlistItemId', 'playlistId', 'videoId', 'position'],
      request: function (a) {
        return { method: 'PUT', path: '/playlistItems', query: { part: 'snippet' }, body: playlistItemBody_(a) };
      },
    }),
    apiTool_({
      name: 'youtube_playlist_items_remove',
      title: 'Remove a video from a playlist',
      description: 'Remove an item from a playlist. The video itself is not deleted.',
      kind: 'delete',
      props: { playlistItemId: strProp_('Playlist item ID (from youtube_playlist_items_list).') },
      required: ['playlistItemId'],
      request: function (a) {
        return { method: 'DELETE', path: '/playlistItems', query: { id: a.playlistItemId } };
      },
    }),
  ];
}
