'use strict';

/**
 * Loads the Apps Script sources into Node. The files share one global scope in
 * Apps Script, so they are concatenated into a single CommonJS module that
 * exports every top-level function. Apps Script services are replaced by
 * in-memory fakes installed on globalThis.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const BUNDLE_PATH = path.join(ROOT, '.build', 'bundle.cjs');

function readSources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => fs.readFileSync(path.join(SRC_DIR, file), 'utf8'))
    .join('\n');
}

function loadBundle() {
  const source = readSources();
  const functions = [...source.matchAll(/^function\s+([A-Za-z0-9_]+)/gm)].map((match) => match[1]);
  const constants = [...source.matchAll(/^const\s+([A-Z0-9_]+)\s*=/gm)].map((match) => match[1]);
  const footer = '\nmodule.exports = { ' + [...functions, ...constants].join(', ') + ' };\n';
  writeIfChanged(BUNDLE_PATH, source + footer);
  return require(BUNDLE_PATH);
}

/** Test files run in parallel processes, so the bundle is replaced atomically and only when stale. */
function writeIfChanged(target, content) {
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, content);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      throw error;
    }
  }
}

/** Fake HTTPResponse. `body` may be an object (JSON), a string, or a Buffer (bytes). */
function response(code, body, headers) {
  const buffer = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  return {
    getResponseCode: () => code,
    getContentText: () => buffer.toString('utf8'),
    getHeaders: () => headers || {},
    getContent: () => Array.from(buffer),
  };
}

/** Installs fresh fakes and returns the state tests can inspect and steer. */
function installGas() {
  const state = { props: new Map(), cache: new Map(), calls: [], routes: [], logs: [], webAppUrl: '' };

  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (state.props.has(key) ? state.props.get(key) : null),
      setProperty: (key, value) => state.props.set(key, String(value)),
      deleteProperty: (key) => state.props.delete(key),
      getKeys: () => [...state.props.keys()],
    }),
  };
  globalThis.CacheService = {
    getScriptCache: () => ({
      get: (key) => (state.cache.has(key) ? state.cache.get(key) : null),
      put: (key, value) => state.cache.set(key, String(value)),
      remove: (key) => state.cache.delete(key),
    }),
  };
  globalThis.ScriptApp = {
    getOAuthToken: () => 'owner-token',
    getService: () => ({ getUrl: () => state.webAppUrl }),
  };
  globalThis.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: () => crypto.randomUUID(),
    computeDigest: (algorithm, value) => Array.from(crypto.createHash('sha256').update(String(value)).digest()),
    newBlob: (data) => ({ getBytes: () => Array.from(Buffer.from(data)) }),
  };
  globalThis.UrlFetchApp = {
    fetch: (url, options) => {
      const call = { url, options: options || {} };
      state.calls.push(call);
      const route = state.routes.find((candidate) => candidate.test(call));
      if (!route) {
        throw new Error('Unexpected fetch: ' + url);
      }
      return route.reply(call);
    },
  };
  globalThis.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, mimeType: null, setMimeType(type) { this.mimeType = type; return this; } }),
  };
  globalThis.HtmlService = {
    createHtmlOutput: (html) => ({ html, title: null, setTitle(title) { this.title = title; return this; } }),
  };
  globalThis.Logger = { log: (message) => state.logs.push(String(message)) };

  /** Routes are tried in order; `match` is a substring, RegExp or predicate on the call. */
  state.on = (match, reply) => {
    const test =
      typeof match === 'function'
        ? match
        : (call) => (match instanceof RegExp ? match.test(call.url) : call.url.includes(match));
    state.routes.push({ test, reply: typeof reply === 'function' ? reply : () => reply });
    return state;
  };
  return state;
}

module.exports = { loadBundle, installGas, response };
