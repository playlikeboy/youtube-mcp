/** YouTube Analytics reports and the generic escape hatch for every other endpoint. */

const DEFAULT_ANALYTICS_METRICS =
  'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares';
const GENERIC_PATH_PATTERN = /^\/[A-Za-z0-9_\-\/.]*$/;

/** Turns the column-header + row-array report into a list of plain objects. */
function tabulateReport_(report) {
  const columns = (report.columnHeaders || []).map(function (header) {
    return header.name;
  });
  const rows = (report.rows || []).map(function (row) {
    return columns.reduce(function (record, name, index) {
      return { ...record, [name]: row[index] };
    }, {});
  });
  return { columns: columns, rowCount: rows.length, rows: rows };
}

function queryAnalytics_(args) {
  const query = {
    ids: args.ids || 'channel==MINE',
    startDate: args.startDate || isoDateDaysAgo_(LIMITS.DEFAULT_ANALYTICS_DAYS),
    endDate: args.endDate || isoDateDaysAgo_(0),
    metrics: args.metrics || DEFAULT_ANALYTICS_METRICS,
    ...pick_(args, ['dimensions', 'filters', 'sort', 'maxResults', 'startIndex', 'currency']),
  };
  const report = ytRequest_({ api: 'analytics', path: '/reports', query: query, account: args.account });
  return { startDate: query.startDate, endDate: query.endDate, ...tabulateReport_(report) };
}

function genericApiRequest_(args) {
  const path = args.path;
  if (!GENERIC_PATH_PATTERN.test(path) || path.indexOf('..') !== -1 || path.indexOf('//') !== -1) {
    throw createError_('"path" must be an API path such as "/activities" (letters, digits, "/", "_", "-", ".").');
  }
  return ytRequest_({
    api: args.api || 'data',
    method: args.method || 'GET',
    path: path,
    query: args.query || {},
    body: args.body,
    account: args.account,
  });
}

function analyticsTools_() {
  return [
    defineTool_({
      name: 'youtube_analytics_query',
      title: 'Query channel analytics',
      description:
        'Run a YouTube Analytics report for the account\'s channel (the numbers shown in YouTube Studio). ' +
        'Defaults to channel totals for the last 28 days. Examples: daily trend: dimensions="day", sort="day"; ' +
        'top videos: dimensions="video", metrics="views,estimatedMinutesWatched", sort="-views", maxResults=10; ' +
        'one video: filters="video==VIDEO_ID"; traffic sources: dimensions="insightTrafficSourceType"; ' +
        'audience: dimensions="ageGroup,gender", metrics="viewerPercentage"; countries: dimensions="country"; ' +
        'revenue (monetised channels): metrics="estimatedRevenue,cpm,playbackBasedCpm".',
      kind: 'read',
      props: {
        startDate: strProp_('YYYY-MM-DD. Default 28 days ago.'),
        endDate: strProp_('YYYY-MM-DD. Default today.'),
        metrics: strProp_('Comma-separated metrics. Default: ' + DEFAULT_ANALYTICS_METRICS + '.'),
        dimensions: strProp_('Comma-separated dimensions, e.g. day, video, country, deviceType.'),
        filters: strProp_('Semicolon-separated filters, e.g. "video==abc123;country==IN".'),
        sort: strProp_('Comma-separated sort keys; prefix with "-" for descending.'),
        maxResults: intProp_('Maximum rows.', 1, 1000),
        startIndex: intProp_('1-based index of the first row, for paging.', 1),
        currency: strProp_('ISO 4217 currency for revenue metrics. Default USD.'),
        ids: strProp_('Default "channel==MINE". Content owners can pass "contentOwner==NAME".'),
      },
      handler: queryAnalytics_,
    }),
    defineTool_({
      name: 'youtube_api_request',
      title: 'Call any YouTube API endpoint',
      description:
        'Escape hatch: call any endpoint of the YouTube Data API v3 (api="data"), Analytics API v2 ' +
        '("analytics") or Reporting API v1 ("reporting") that has no dedicated tool, e.g. /activities, ' +
        '/playlistImages, /liveChat/moderators, /liveChat/bans, /videos/reportAbuse, /i18nLanguages, analytics ' +
        '/groups and /groupItems, reporting /jobs. Prefer the dedicated tools when one exists.',
      kind: 'delete',
      props: {
        api: strProp_('Which API. Default data.', Object.keys(API_BASES)),
        method: strProp_('HTTP method. Default GET.', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: strProp_('Path below the API root, e.g. "/activities".'),
        query: objProp_('Query parameters, e.g. {"part":"snippet","mine":true}.'),
        body: objProp_('JSON request body for POST / PUT / PATCH.'),
      },
      required: ['path'],
      handler: genericApiRequest_,
    }),
  ];
}
