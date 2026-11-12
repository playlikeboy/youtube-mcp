/** MCP over JSON-RPC 2.0: initialize, ping, tools/list and tools/call. Stateless. */

function rpcResult_(id, result) {
  return { jsonrpc: '2.0', id: id, result: result };
}

function rpcError_(id, code, message) {
  return { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
}

function toolSuccess_(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

/** Tool failures go back as results so the model can read them and correct itself. */
function toolError_(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function initialize_(params) {
  const requested = params.protocolVersion;
  const supported = SUPPORTED_PROTOCOL_VERSIONS.indexOf(requested) !== -1;
  return {
    protocolVersion: supported ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  };
}

function listTools_() {
  return { tools: allTools_().map(describeTool_) };
}

function callTool_(params) {
  const tool = findTool_(params.name);
  if (!tool) {
    throw rpcException_(RPC_ERRORS.INVALID_PARAMS, 'Unknown tool: ' + String(params.name));
  }
  const args = compact_(isPlainObject_(params.arguments) ? params.arguments : {});
  const problems = validateArgs_(tool.inputSchema, args);
  if (problems.length > 0) {
    return toolError_('Invalid arguments for ' + tool.name + ': ' + problems.join(' '));
  }
  try {
    return toolSuccess_(tool.handler(args));
  } catch (error) {
    const message = redactSecrets_(error && error.message ? error.message : String(error));
    console.error('Tool ' + tool.name + ' failed: ' + message);
    return toolError_(message);
  }
}

const RPC_METHODS = Object.freeze({
  initialize: initialize_,
  ping: function () {
    return {};
  },
  'tools/list': listTools_,
  'tools/call': callTool_,
});

function dispatchMethod_(method, params) {
  if (!Object.prototype.hasOwnProperty.call(RPC_METHODS, method)) {
    throw rpcException_(RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found: ' + method);
  }
  return RPC_METHODS[method](isPlainObject_(params) ? params : {});
}

/** Returns a JSON-RPC response, or null when the message needs none (notifications, client responses). */
function handleRpcMessage_(message) {
  const isObject = isPlainObject_(message);
  const hasId = isObject && message.id !== undefined && message.id !== null;
  if (isObject && typeof message.method !== 'string' && ('result' in message || 'error' in message)) {
    return null;
  }
  if (!isObject || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError_(hasId ? message.id : null, RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request.');
  }
  if (!hasId) {
    return null;
  }
  try {
    return rpcResult_(message.id, dispatchMethod_(message.method, message.params));
  } catch (error) {
    if (error.rpcCode) {
      return rpcError_(message.id, error.rpcCode, error.message);
    }
    console.error('RPC ' + message.method + ' failed: ' + redactSecrets_(error.message));
    return rpcError_(message.id, RPC_ERRORS.INTERNAL, 'Internal error.');
  }
}

/** Handles a single message or a batch. Returns null when nothing should be sent back. */
function handleRpcPayload_(payload) {
  if (!Array.isArray(payload)) {
    return handleRpcMessage_(payload);
  }
  if (payload.length === 0) {
    return rpcError_(null, RPC_ERRORS.INVALID_REQUEST, 'Empty batch.');
  }
  const responses = payload.map(handleRpcMessage_).filter(function (response) {
    return response !== null;
  });
  return responses.length > 0 ? responses : null;
}
