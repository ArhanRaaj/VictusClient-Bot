# VictusClient Bot (Discord relay)

Standalone Node service that bridges the website chat and a real Discord
channel so both sides see the same conversation. **Zero npm dependencies** —
it uses only Node 22+ built-ins (`node:http`, global `fetch`, global
`WebSocket`).

```
Discord channel  ──bot gateway──▶  relay  ──GET /api/messages──▶  website
     ▲                                                              │
     └──────────────── POST /api/messages (bot or webhook) ◀────────┘
```

## Run locally

```bash
npm start        # or: node main.js
```

It listens on `http://127.0.0.1:8787` by default; the site polls it via
`VITE_RELAY_URL` (defaults to the same address).

## Deploy

This folder is self-contained — push just this folder to any Node host:

1. Copy `.env.example` to `.env` (or set the environment variables in your
   host's dashboard).
2. Set the **start command** to `npm start` (or `node main.js`).
3. Node **22+** is required (a `Procfile` is included for hosts that use one).
4. On most hosts, set `HOST=0.0.0.0` so the service is reachable, and add your
   website's origin to `ALLOWED_ORIGINS`.

A `Dockerfile` is included for container platforms.

## Configure

| Variable | Why |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Lets the relay **read** the channel. Create an application at <https://discord.com/developers/applications>, open **Bot**, enable **Message Content Intent**, then invite it to your server. |
| `DISCORD_CHANNEL_ID` | The channel to mirror. Enable Developer Mode in Discord, right click the channel, **Copy Channel ID**. |
| `DISCORD_WEBHOOK_URL` | Optional. Used for outbound posts when no bot token is present, so the site can still send one-way messages. |
| `RELAY_WRITE_KEY` | Optional shared secret; when set the site must send an `x-relay-key` header to post. |
| `PORT` / `HOST` / `ALLOWED_ORIGINS` | Where it listens and which origins may call it. |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Gateway status, whether reading/posting is possible, buffered count |
| `GET` | `/api/messages?since=<id>` | Recent messages (last 60), oldest first |
| `POST` | `/api/messages` | `{ author, content }` → posts into the Discord channel |

## Notes

* Messages live in memory only; restarting the relay replays the last 30 from
  Discord history.
* Posting is rate-limited to one message every 3 seconds per IP.
* Bind to `127.0.0.1` unless you deliberately expose it — an open relay lets
  anyone post into your channel.
