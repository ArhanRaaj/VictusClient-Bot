#!/usr/bin/env node
/**
 * VictusClient Discord relay
 * -------------------------------------------------------------------------
 * Makes the website chat and a real Discord channel the same conversation:
 *
 *   Discord  ->  website   a bot listens on the gateway and streams new
 *                          messages into an in-memory buffer the site polls.
 *   website  ->  Discord   POST /api/messages forwards the text into the
 *                          channel (bot token) or through the webhook.
 *
 * Zero npm dependencies: node:http + the global fetch/WebSocket in Node 22+.
 *
 *   node relay.mjs
 *
 * Configuration lives in .env (see .env.example):
 *   DISCORD_BOT_TOKEN   bot token with the MESSAGE CONTENT intent enabled
 *   DISCORD_CHANNEL_ID  channel to mirror
 *   DISCORD_WEBHOOK_URL optional fallback for outbound messages
 *   RELAY_WRITE_KEY     optional shared secret required to post from the site
 *   PORT                default 8787
 *   HOST                default 127.0.0.1
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = here;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const parseEnvFile = (path) => {
  const out = {};
  if (!existsSync(path)) return out;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

const fileEnv = {
  ...parseEnvFile(join(here, '.env')),
};

const env = (key, fallback = '') => process.env[key] || fileEnv[key] || fallback;

const CONFIG = {
  botToken: env('DISCORD_BOT_TOKEN'),
  channelId: env('DISCORD_CHANNEL_ID'),
  // Accepts the relay's own variable or the one the site already uses
  webhookUrl: env('DISCORD_WEBHOOK_URL') || env('VITE_DISCORD_WEBHOOK_URL'),
  writeKey: env('RELAY_WRITE_KEY'),
  port: Number(env('PORT', '8787')) || 8787,
  host: env('HOST', '127.0.0.1') || '127.0.0.1',
  allowedOrigins: env('ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

const API = 'https://discord.com/api/v10';
const MAX_MESSAGES = 120;
const INTENTS = (1 << 9) | (1 << 15); // GUILD_MESSAGES | MESSAGE_CONTENT

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** @type {Array<{id:string,author:string,authorId:string,avatarUrl:string|null,content:string,timestamp:string,source:'discord'|'web',bot:boolean}>} */
const messages = [];
const seenIds = new Set();
const recentPosts = new Map(); // ip -> last post timestamp

// "Name (via website): message" — the same shape on Discord and in the panel
const ATTRIBUTION = /^(.{1,40}?) \(via website\): ([\s\S]*)$/;
const attribute = (content, author) => (author ? `${author} (via website): ${content}` : content);

const gateway = {
  botUserId: null,
  socket: null,
  sequence: null,
  heartbeat: null,
  sessionId: null,
  resumeUrl: null,
  connected: false,
  lastError: null,
  reconnects: 0,
};

const log = (...args) => console.log(`[relay ${new Date().toISOString().slice(11, 19)}]`, ...args);
const warn = (...args) => console.warn(`[relay ${new Date().toISOString().slice(11, 19)}]`, ...args);

const avatarUrl = (id, hash) =>
  hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=64` : null;

const normalizeDiscordMessage = (message) => ({
  id: String(message.id),
  author: String(message.author?.global_name || message.author?.username || 'Discord user'),
  authorId: String(message.author?.id ?? ''),
  avatarUrl: avatarUrl(message.author?.id, message.author?.avatar),
  content: String(message.content ?? '').slice(0, 1200),
  timestamp: message.timestamp ?? new Date().toISOString(),
  source: 'discord',
  bot: Boolean(message.author?.bot),
});

const store = (message) => {
  if (!message || !message.content || seenIds.has(message.id)) return false;
  seenIds.add(message.id);
  messages.push(message);
  if (messages.length > MAX_MESSAGES) {
    const dropped = messages.splice(0, messages.length - MAX_MESSAGES);
    dropped.forEach((entry) => seenIds.delete(entry.id));
  }
  return true;
};

/* ------------------------------------------------------------------ */
/* Discord REST                                                        */
/* ------------------------------------------------------------------ */

const rest = async (path, init = {}) => {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${CONFIG.botToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${body.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json();
};

const backfillHistory = async () => {
  if (!CONFIG.botToken || !CONFIG.channelId) return;
  try {
    const history = await rest(`/channels/${CONFIG.channelId}/messages?limit=30`);
    const normalized = history.map(normalizeDiscordMessage).reverse();
    normalized.forEach(store);
    log(`backfilled ${normalized.length} message(s) from channel history`);
  } catch (error) {
    warn('history backfill failed:', error.message);
  }
};

const postToDiscord = async (content, author) => {
  if (CONFIG.botToken && CONFIG.channelId) {
    // Discord attributes bot posts to the bot, so name the visitor in the body
    return rest(`/channels/${CONFIG.channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: attribute(content, author) }),
    });
  }

  if (CONFIG.webhookUrl) {
    const response = await fetch(`${CONFIG.webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: author ? `${author} (via website)` : 'VictusClient Web',
        content,
      }),
    });
    if (!response.ok) throw new Error(`webhook -> ${response.status}`);
    return response.json();
  }

  throw new Error('no DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL configured');
};

/* ------------------------------------------------------------------ */
/* Gateway client                                                      */
/* ------------------------------------------------------------------ */

const sendGateway = (payload) => {
  if (gateway.socket && gateway.socket.readyState === 1) {
    gateway.socket.send(JSON.stringify(payload));
  }
};

const stopHeartbeat = () => {
  if (gateway.heartbeat) {
    clearInterval(gateway.heartbeat);
    gateway.heartbeat = null;
  }
};

const startHeartbeat = (intervalMs) => {
  stopHeartbeat();
  gateway.heartbeat = setInterval(() => {
    sendGateway({ op: 1, d: gateway.sequence });
  }, intervalMs);
};

const handleDispatch = (name, data) => {
  if (name === 'READY') {
    gateway.botUserId = String(data.user?.id ?? '') || null;
    gateway.sessionId = data.session_id;
    gateway.resumeUrl = data.resume_gateway_url ? `${data.resume_gateway_url}/?v=10&encoding=json` : null;
    gateway.connected = true;
    gateway.lastError = null;
    log(`gateway connected as ${data.user?.username ?? 'bot'}`);
    return;
  }

  if (name === 'RESUMED') {
    gateway.connected = true;
    log('gateway session resumed');
    return;
  }

  if (name === 'MESSAGE_CREATE') {
    if (String(data.channel_id) !== String(CONFIG.channelId)) return;

    let message = normalizeDiscordMessage(data);

    // Our own bot echoing a website message back: restore the visitor's name
    // and the clean text instead of showing "Bot: Name (via website): …".
    if (message.authorId === gateway.botUserId) {
      const match = message.content.match(ATTRIBUTION);
      if (match) {
        message = { ...message, author: match[1], content: match[2], source: 'web', bot: false };
      }
    }

    if (store(message)) {
      log(`incoming from Discord: ${message.author} — ${message.content.slice(0, 60)}`);
    }
  }
};

const connectGateway = (url = 'wss://gateway.discord.gg/?v=10&encoding=json') => {
  if (!CONFIG.botToken) {
    gateway.lastError = 'DISCORD_BOT_TOKEN is missing';
    return;
  }

  stopHeartbeat();
  gateway.connected = false;

  const socket = new WebSocket(url);
  gateway.socket = socket;

  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch {
      return;
    }

    const { op, d, t, s } = payload;
    if (typeof s === 'number') gateway.sequence = s;

    if (op === 10) {
      startHeartbeat(d.heartbeat_interval);
      sendGateway({
        op: 2,
        d: {
          token: CONFIG.botToken,
          intents: INTENTS,
          properties: { os: process.platform, browser: 'victus-relay', device: 'victus-relay' },
        },
      });
      return;
    }

    if (op === 11) return; // heartbeat ack

    if (op === 1) {
      sendGateway({ op: 1, d: gateway.sequence });
      return;
    }

    if (op === 7) {
      socket.close(4000, 'reconnect requested');
      return;
    }

    if (op === 9) {
      gateway.sessionId = null;
      gateway.sequence = null;
      setTimeout(() => connectGateway(), 2000);
      return;
    }

    if (op === 0) handleDispatch(t, d);
  });

  socket.addEventListener('error', () => {
    gateway.lastError = 'gateway socket error';
  });

  socket.addEventListener('close', (event) => {
    stopHeartbeat();
    gateway.connected = false;
    gateway.lastError = gateway.lastError || `gateway closed (${event.code})`;
    const delay = Math.min(30000, 1500 * 2 ** Math.min(gateway.reconnects, 4));
    gateway.reconnects += 1;
    warn(`gateway closed (${event.code}); reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => connectGateway(), delay);
  });
};

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

const corsHeaders = (origin) => {
  const allowed = !origin || CONFIG.allowedOrigins.includes(origin) || CONFIG.allowedOrigins.includes('*');
  return {
    'Access-Control-Allow-Origin': allowed ? origin || '*' : CONFIG.allowedOrigins[0] ?? '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-relay-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
};

const sendJson = (response, status, payload, origin) => {
  response.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
  response.end(JSON.stringify(payload));
};

const readJsonBody = (request) =>
  new Promise((resolvePromise, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 20000) {
        reject(new Error('payload too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(
      response,
      200,
      {
        ok: true,
        gateway: gateway.connected ? 'connected' : 'disconnected',
        error: gateway.lastError,
        channelId: CONFIG.channelId || null,
        canReadDiscord: Boolean(CONFIG.botToken && CONFIG.channelId),
        canPostDiscord: Boolean((CONFIG.botToken && CONFIG.channelId) || CONFIG.webhookUrl),
        messages: messages.length,
      },
      origin
    );
    return;
  }

  if (url.pathname === '/api/messages' && request.method === 'GET') {
    const since = url.searchParams.get('since');
    let list = messages;
    if (since) {
      const index = messages.findIndex((message) => message.id === since);
      list = index === -1 ? messages : messages.slice(index + 1);
    }
    sendJson(response, 200, { messages: list.slice(-60), count: messages.length }, origin);
    return;
  }

  if (url.pathname === '/api/messages' && request.method === 'POST') {
    if (CONFIG.writeKey && request.headers['x-relay-key'] !== CONFIG.writeKey) {
      sendJson(response, 401, { error: 'invalid relay key' }, origin);
      return;
    }

    const ip = request.socket.remoteAddress ?? 'unknown';
    const last = recentPosts.get(ip) ?? 0;
    if (Date.now() - last < 3000) {
      sendJson(response, 429, { error: 'slow down' }, origin);
      return;
    }

    try {
      const body = await readJsonBody(request);
      const content = String(body.content ?? '').trim().slice(0, 900);
      const author = String(body.author ?? '').trim().slice(0, 40) || 'Website visitor';
      if (!content) {
        sendJson(response, 400, { error: 'content is required' }, origin);
        return;
      }

      recentPosts.set(ip, Date.now());
      const created = await postToDiscord(content, author);

      // Keep the echo attributed to the visitor rather than the webhook bot
      const message = {
        id: created?.id ? String(created.id) : `web-${Date.now()}`,
        author,
        authorId: '',
        avatarUrl: null,
        content,
        timestamp: created?.timestamp ?? new Date().toISOString(),
        source: 'web',
        bot: false,
      };

      store(message);
      log(`outgoing to Discord: ${author} — ${content.slice(0, 60)}`);
      sendJson(response, 201, { message }, origin);
    } catch (error) {
      sendJson(response, 502, { error: error.message }, origin);
    }
    return;
  }

  sendJson(response, 404, { error: 'not found' }, origin);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`listening on http://${CONFIG.host}:${CONFIG.port}`);
  log(`allowed origins: ${CONFIG.allowedOrigins.join(', ') || '*'}`);

  if (!CONFIG.channelId) {
    warn('DISCORD_CHANNEL_ID is not set — Discord → website mirroring is off.');
  } else {
    log(`mirroring channel ${CONFIG.channelId}`);
  }

  if (!CONFIG.botToken) {
    warn('DISCORD_BOT_TOKEN is not set — the website can only post through the webhook.');
  } else {
    connectGateway();
    void backfillHistory();
  }
});

const shutdown = () => {
  log('shutting down');
  stopHeartbeat();
  try {
    gateway.socket?.close(1000, 'shutdown');
  } catch {
    // ignore
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
