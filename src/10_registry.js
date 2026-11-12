/** Tool definition helpers, argument validation and the tool registry. */

function strProp_(description, enumValues) {
  return compact_({ type: 'string', description: description, enum: enumValues });
}

function intProp_(description, minimum, maximum) {
  return compact_({ type: 'integer', description: description, minimum: minimum, maximum: maximum });
}

function boolProp_(description) {
  return { type: 'boolean', description: description };
}

function listProp_(description) {
  return { type: 'array', items: { type: 'string' }, description: description };
}

const ACCOUNT_PROP = strProp_('Alias of the connected account to act as. Omit for the default account.');

const SOURCE_PROPS = Object.freeze({
  driveFileId: strProp_("ID of a file in the script owner's Google Drive. Use this or \"url\"."),
  url: strProp_('Public https:// URL of the file. Use this or "driveFileId".'),
});

const PRIVACY_VALUES = Object.freeze(['private', 'unlisted', 'public']);

/** part / fields / maxResults / pageToken, shared by every list tool. */
function listProps_(defaultPart, maxPageSize) {
  return {
    part: strProp_('Resource parts to return, comma-separated. Default: ' + defaultPart + '.'),
    fields: strProp_('Partial-response selector to shrink the result, e.g. "items(id,snippet/title),nextPageToken".'),
    maxResults: intProp_('Page size, 1-' + maxPageSize + '.', 1, maxPageSize),
    pageToken: strProp_('nextPageToken (or prevPageToken) from an earlier call.'),
  };
}

function listQuery_(args, defaultPart, extra) {
  return {
    part: args.part || defaultPart,
    fields: args.fields,
    maxResults: args.maxResults,
    pageToken: args.pageToken,
    ...extra,
  };
}

const ANNOTATIONS_BY_KIND = Object.freeze({
  read: { readOnlyHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
});

/**
 * spec: { name, title, description, kind: 'read'|'write'|'delete', props, required?, noAccount?, handler }
 * Every tool gets the optional "account" argument unless noAccount is set.
 */
function defineTool_(spec) {
  const properties = spec.noAccount ? { ...spec.props } : { ...spec.props, account: ACCOUNT_PROP };
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: properties,
      required: spec.required || [],
      additionalProperties: false,
    },
    annotations: ANNOTATIONS_BY_KIND[spec.kind],
    handler: spec.handler,
  };
}

/** A tool that maps straight onto one REST call. spec.request(args) returns the ytRequest_ input. */
function apiTool_(spec) {
  return defineTool_({
    ...spec,
    handler: function (args) {
      return ytRequest_({ ...spec.request(args), account: args.account });
    },
  });
}

function allTools_() {
  return accountTools_().concat(videoTools_());
}

function findTool_(name) {
  const matches = allTools_().filter(function (tool) {
    return tool.name === name;
  });
  return matches[0] || null;
}

/** The tool as advertised by tools/list (no handler). */
function describeTool_(tool) {
  return pick_(tool, ['name', 'title', 'description', 'inputSchema', 'annotations']);
}

function matchesType_(type, value) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') {
    return Array.isArray(value) && value.every(function (item) { return typeof item === 'string'; });
  }
  return false;
}

function checkArgument_(name, prop, value) {
  if (!matchesType_(prop.type, value)) {
    return 'Argument "' + name + '" must be ' + (prop.type === 'array' ? 'an array of strings' : 'of type ' + prop.type) + '.';
  }
  if (prop.enum && prop.enum.indexOf(value) === -1) {
    return 'Argument "' + name + '" must be one of: ' + prop.enum.join(', ') + '.';
  }
  const belowMin = prop.minimum !== undefined && value < prop.minimum;
  const aboveMax = prop.maximum !== undefined && value > prop.maximum;
  if (belowMin || aboveMax) {
    return 'Argument "' + name + '" must be between ' + prop.minimum + ' and ' + prop.maximum + '.';
  }
  return null;
}

/** Returns a list of problems; an empty list means the arguments are valid. */
function validateArgs_(schema, args) {
  const props = schema.properties;
  const names = Object.keys(args);
  const missing = schema.required
    .filter(function (name) { return args[name] === undefined || args[name] === ''; })
    .map(function (name) { return 'Missing required argument "' + name + '".'; });
  const unknown = names
    .filter(function (name) { return !Object.prototype.hasOwnProperty.call(props, name); })
    .map(function (name) { return 'Unknown argument "' + name + '".'; });
  const invalid = names
    .filter(function (name) { return Object.prototype.hasOwnProperty.call(props, name); })
    .map(function (name) { return checkArgument_(name, props[name], args[name]); })
    .filter(Boolean);
  return missing.concat(unknown, invalid);
}
