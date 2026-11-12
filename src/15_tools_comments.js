/** Comments: read, post, reply, edit, delete and moderate. */

const THREAD_PARTS = 'snippet,replies';

function threadFilter_(args) {
  if (args.id) return { id: args.id };
  if (args.videoId) return { videoId: args.videoId };
  if (args.channelId) return { allThreadsRelatedToChannelId: args.channelId };
  throw createError_('Provide "videoId", "channelId" or "id".');
}

function commentTools_() {
  const commentIdProp = strProp_('Comment ID.');
  const textProp = strProp_('Comment text.');
  return [
    apiTool_({
      name: 'youtube_comment_threads_list',
      title: 'List comments',
      description:
        'List top-level comments (with their first replies) on a video, or across a whole channel. Use ' +
        'moderationStatus "heldForReview" to see comments waiting for approval on your own videos.',
      kind: 'read',
      props: {
        videoId: strProp_('Video ID.'),
        channelId: strProp_('Channel ID: returns comments on all of its videos.'),
        id: strProp_('Comment thread ID(s), comma-separated.'),
        order: strProp_('Sort order. Default time.', ['time', 'relevance']),
        searchTerms: strProp_('Only comments containing these words.'),
        moderationStatus: strProp_('Default published.', ['published', 'heldForReview', 'likelySpam']),
        ...listProps_(THREAD_PARTS, 100),
      },
      request: function (a) {
        const extra = { ...threadFilter_(a), ...pick_(a, ['order', 'searchTerms', 'moderationStatus']), textFormat: 'plainText' };
        return { path: '/commentThreads', query: listQuery_(a, THREAD_PARTS, extra) };
      },
    }),
    apiTool_({
      name: 'youtube_comments_list',
      title: 'List replies',
      description: 'List all replies to a comment, or fetch specific comments by ID.',
      kind: 'read',
      props: {
        parentId: strProp_('ID of the top-level comment whose replies to list.'),
        id: strProp_('Comment ID(s), comma-separated.'),
        ...listProps_('snippet', 100),
      },
      request: function (a) {
        if (!a.parentId && !a.id) {
          throw createError_('Provide "parentId" or "id".');
        }
        const filter = a.id ? { id: a.id } : { parentId: a.parentId };
        return { path: '/comments', query: listQuery_(a, 'snippet', { ...filter, textFormat: 'plainText' }) };
      },
    }),
    apiTool_({
      name: 'youtube_comments_post',
      title: 'Post a comment',
      description: 'Post a new top-level comment on a video as the account\'s channel.',
      kind: 'write',
      props: { videoId: strProp_('Video ID.'), text: textProp },
      required: ['videoId', 'text'],
      request: function (a) {
        const body = { snippet: { videoId: a.videoId, topLevelComment: { snippet: { textOriginal: a.text } } } };
        return { method: 'POST', path: '/commentThreads', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_comments_reply',
      title: 'Reply to a comment',
      description: 'Reply to a top-level comment.',
      kind: 'write',
      props: { parentId: strProp_('ID of the top-level comment to reply to.'), text: textProp },
      required: ['parentId', 'text'],
      request: function (a) {
        const body = { snippet: { parentId: a.parentId, textOriginal: a.text } };
        return { method: 'POST', path: '/comments', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_comments_update',
      title: 'Edit a comment',
      description: 'Edit the text of a comment written by the account.',
      kind: 'write',
      props: { commentId: commentIdProp, text: textProp },
      required: ['commentId', 'text'],
      request: function (a) {
        const body = { id: a.commentId, snippet: { textOriginal: a.text } };
        return { method: 'PUT', path: '/comments', query: { part: 'snippet' }, body: body };
      },
    }),
    apiTool_({
      name: 'youtube_comments_delete',
      title: 'Delete a comment',
      description: 'Permanently delete a comment the account wrote, or one on the account\'s own videos.',
      kind: 'delete',
      props: { commentId: commentIdProp },
      required: ['commentId'],
      request: function (a) {
        return { method: 'DELETE', path: '/comments', query: { id: a.commentId } };
      },
    }),
    apiTool_({
      name: 'youtube_comments_set_moderation_status',
      title: 'Moderate comments',
      description:
        'Approve (published), hold (heldForReview) or reject comments on the account\'s own videos. banAuthor ' +
        'also blocks the author from commenting and only applies when rejecting.',
      kind: 'write',
      props: {
        commentId: strProp_('Comment ID(s), comma-separated.'),
        moderationStatus: strProp_('New status.', ['published', 'heldForReview', 'rejected']),
        banAuthor: boolProp_('Also ban the author from the channel. Only with "rejected".'),
      },
      required: ['commentId', 'moderationStatus'],
      request: function (a) {
        const query = { id: a.commentId, moderationStatus: a.moderationStatus, banAuthor: a.banAuthor };
        return { method: 'POST', path: '/comments/setModerationStatus', query: query };
      },
    }),
  ];
}
