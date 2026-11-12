/** Channel details, branding, sections, banner and watermark. */

const CHANNEL_PARTS = 'snippet,statistics,contentDetails,status,brandingSettings';
const CHANNEL_BRANDING_FIELDS = Object.freeze(['description', 'keywords', 'country', 'defaultLanguage', 'unsubscribedTrailer']);
const SECTION_PARTS = 'snippet,contentDetails';

function channelFilter_(args) {
  if (args.id) return { id: args.id };
  if (args.forHandle) return { forHandle: args.forHandle };
  if (args.forUsername) return { forUsername: args.forUsername };
  return { mine: true };
}

function updateChannel_(args) {
  const changes = compact_(pick_(args, CHANNEL_BRANDING_FIELDS));
  const setsKids = args.selfDeclaredMadeForKids !== undefined;
  if (isEmptyObject_(changes) && !setsKids) {
    throw createError_('Provide at least one field to change.');
  }
  const existing = getChannel_(args.channelId, 'brandingSettings', args.account);
  const branding = existing.brandingSettings || {};
  const body = {
    id: existing.id,
    brandingSettings: { ...branding, channel: { ...(branding.channel || {}), ...changes } },
    ...(setsKids ? { status: { selfDeclaredMadeForKids: args.selfDeclaredMadeForKids } } : {}),
  };
  const part = setsKids ? 'brandingSettings,status' : 'brandingSettings';
  return ytRequest_({ method: 'PUT', path: '/channels', query: { part: part }, body: body, account: args.account });
}

function setChannelBanner_(args) {
  const image = fetchSourceBlob_(pickSource_(args), LIMITS.MAX_BANNER_BYTES);
  const uploaded = uploadMedia_({
    path: '/channelBanners/insert',
    query: { uploadType: 'media' },
    contentType: image.mimeType,
    payload: image.bytes,
    account: args.account,
  });
  const existing = getChannel_(args.channelId, 'brandingSettings', args.account);
  const branding = existing.brandingSettings || {};
  const body = {
    id: existing.id,
    brandingSettings: { ...branding, image: { ...(branding.image || {}), bannerExternalUrl: uploaded.url } },
  };
  return ytRequest_({ method: 'PUT', path: '/channels', query: { part: 'brandingSettings' }, body: body, account: args.account });
}

function setWatermark_(args) {
  const channel = getChannel_(args.channelId, 'id', args.account);
  const image = fetchSourceBlob_(pickSource_(args), LIMITS.MAX_WATERMARK_BYTES);
  const metadata = {
    timing: compact_({
      type: args.timingType || 'offsetFromStart',
      offsetMs: args.offsetMs === undefined ? 0 : args.offsetMs,
      durationMs: args.durationMs,
    }),
    position: { type: 'corner', cornerPosition: 'topRight' },
  };
  const multipart = buildMultipartRelated_(metadata, image.bytes, image.mimeType);
  return uploadMedia_({
    path: '/watermarks/set',
    query: { channelId: channel.id, uploadType: 'multipart' },
    contentType: multipart.contentType,
    payload: multipart.payload,
    account: args.account,
  });
}

function sectionRequest_(method, args) {
  const details = compact_({ playlists: args.playlists, channels: args.channels });
  const hasDetails = !isEmptyObject_(details);
  const body = compact_({
    id: args.sectionId,
    snippet: compact_({ type: args.type, title: args.title, position: args.position }),
    contentDetails: hasDetails ? details : undefined,
  });
  return { method: method, path: '/channelSections', query: { part: hasDetails ? SECTION_PARTS : 'snippet' }, body: body };
}

function sectionProps_() {
  return {
    type: strProp_('Section type, e.g. singlePlaylist, multiplePlaylists, multipleChannels, recentUploads, popularUploads.'),
    title: strProp_('Section title (needed for multiplePlaylists / multipleChannels).'),
    position: intProp_('Zero-based position on the channel page.', 0),
    playlists: listProp_('Playlist IDs shown in the section.'),
    channels: listProp_('Channel IDs shown in the section.'),
  };
}

function channelTools_() {
  const channelIdProp = strProp_("Channel ID. Omit for the account's own channel.");
  return [
    apiTool_({
      name: 'youtube_channels_get',
      title: 'Get channel details',
      description:
        "Get channel info, statistics (subscribers, views, video count) and branding. With no filter it returns the account's own channel.",
      kind: 'read',
      props: {
        id: strProp_('Channel ID(s), comma-separated.'),
        forHandle: strProp_('Channel handle, e.g. "@GoogleDevelopers".'),
        forUsername: strProp_('Legacy YouTube username.'),
        ...listProps_(CHANNEL_PARTS, 50),
      },
      request: function (a) {
        return { path: '/channels', query: listQuery_(a, CHANNEL_PARTS, channelFilter_(a)) };
      },
    }),
    defineTool_({
      name: 'youtube_channels_update',
      title: 'Update channel settings',
      description:
        'Change channel description, keywords, country, default language, trailer or made-for-kids status. Other ' +
        'branding settings are preserved. The channel name and handle cannot be changed through the API.',
      kind: 'write',
      props: {
        channelId: channelIdProp,
        description: strProp_('Channel description.'),
        keywords: strProp_('Space-separated channel keywords; quote multi-word keywords.'),
        country: strProp_('ISO 3166-1 alpha-2 country code.'),
        defaultLanguage: strProp_('BCP-47 language code.'),
        unsubscribedTrailer: strProp_('Video ID of the trailer shown to non-subscribers.'),
        selfDeclaredMadeForKids: boolProp_('Whether the whole channel is made for kids.'),
      },
      handler: updateChannel_,
    }),
    defineTool_({
      name: 'youtube_channel_banner_set',
      title: 'Set channel banner',
      description: 'Upload an image (16:9, at least 2048x1152, max 6 MB) and set it as the channel banner.',
      kind: 'write',
      props: { ...SOURCE_PROPS, channelId: channelIdProp },
      handler: setChannelBanner_,
    }),
    defineTool_({
      name: 'youtube_watermark_set',
      title: 'Set video watermark',
      description: 'Upload a square PNG/JPG (max 1 MB) shown as the branding watermark on all of the channel\'s videos.',
      kind: 'write',
      props: {
        ...SOURCE_PROPS,
        channelId: channelIdProp,
        timingType: strProp_('When the watermark appears. Default offsetFromStart.', ['offsetFromStart', 'offsetFromEnd']),
        offsetMs: intProp_('Offset in milliseconds. Default 0.', 0),
        durationMs: intProp_('How long it stays visible, in milliseconds. Omit for the rest of the video.', 0),
      },
      handler: setWatermark_,
    }),
    defineTool_({
      name: 'youtube_watermark_unset',
      title: 'Remove video watermark',
      description: "Remove the channel's branding watermark.",
      kind: 'delete',
      props: { channelId: channelIdProp },
      handler: function (a) {
        const channel = getChannel_(a.channelId, 'id', a.account);
        return ytRequest_({ method: 'POST', path: '/watermarks/unset', query: { channelId: channel.id }, account: a.account });
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_list',
      title: 'List channel sections',
      description: "List the shelves on a channel's home page. Defaults to the account's own channel.",
      kind: 'read',
      props: { channelId: strProp_('Channel ID.'), id: strProp_('Section ID(s), comma-separated.'), part: strProp_('Default: ' + SECTION_PARTS + '.') },
      request: function (a) {
        const filter = a.id ? { id: a.id } : a.channelId ? { channelId: a.channelId } : { mine: true };
        return { path: '/channelSections', query: { part: a.part || SECTION_PARTS, ...filter } };
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_create',
      title: 'Create channel section',
      description: 'Add a shelf to the channel home page.',
      kind: 'write',
      props: sectionProps_(),
      required: ['type'],
      request: function (a) {
        return sectionRequest_('POST', a);
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_update',
      title: 'Update channel section',
      description: 'Replace a shelf\'s type, title, position and contents. Send every value the section should keep.',
      kind: 'write',
      props: { sectionId: strProp_('Section ID.'), ...sectionProps_() },
      required: ['sectionId', 'type'],
      request: function (a) {
        return sectionRequest_('PUT', a);
      },
    }),
    apiTool_({
      name: 'youtube_channel_sections_delete',
      title: 'Delete channel section',
      description: 'Remove a shelf from the channel home page.',
      kind: 'delete',
      props: { sectionId: strProp_('Section ID.') },
      required: ['sectionId'],
      request: function (a) {
        return { method: 'DELETE', path: '/channelSections', query: { id: a.sectionId } };
      },
    }),
  ];
}
