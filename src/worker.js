/**
 * src/worker.js — EM-TempMail Backend (Cloudflare Worker, ES Module)
 *
 * Entry Points:
 *   fetch     -> REST API under /api/* and Static Asset serving
 *   email     -> Inbound mail from Cloudflare Email Routing
 *   scheduled -> Cron garbage collection for expired inboxes and old messages
 */

import PostalMime from 'postal-mime';

/* ----------------------------- Constants ------------------------------ */

const DURATIONS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Default validity upgraded to 30 days
const DEFAULT_VALIDITY = '30d';

const MAX_RAW_EMAIL_BYTES = 5 * 1024 * 1024; // 5 MB max raw email size
const MAX_BODY_CHARS = 700_000;              // Cap stored body length
const MAX_MESSAGES_PER_INBOX = 100;          // Oldest trimmed beyond this limit

const SETTING_KEYS = [
  'site_name',
  'ads_enabled',
  'ad_banner_top',
  'ad_banner_bottom',
  'ad_native',
  'ad_social_bar',
  'ad_popunder',
  'ad_direct_link',
  'popunder_cooldown',
  'powered_name',
  'powered_link',
  'social_platforms',
  'sponsor_top',
  'sponsor_bottom',
];

const WORDS = [
  'swift', 'lunar', 'amber', 'cedar', 'delta', 'ember', 'frost', 'gamma', 'hazel', 'ivory',
  'jolly', 'karma', 'lilac', 'maple', 'noble', 'olive', 'pearl', 'quartz', 'raven', 'solar',
  'tiger', 'ultra', 'vivid', 'willow', 'xenon', 'yodel', 'zephyr', 'cobalt', 'dusk', 'echo',
  'nexus', 'apex', 'prism', 'vortex', 'orbit', 'flux', 'stellar', 'mystic', 'beacon', 'zenith'
];

/* ----------------------------- Helpers -------------------------------- */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Secret,X-Inbox-Token',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...CORS_HEADERS,
    },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function randomLocalPart() {
  const word = WORDS[randInt(WORDS.length)];
  const digits = String(randInt(10000)).padStart(4, '0');
  return `${word}${digits}`;
}

function getDomains(env) {
  const raw = env.DOMAIN || 'temone.skin,emtapmail.online,geomail.cfd';
  const list = raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : ['temone.skin'];
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/** Converts HTML to clean, formatted plain text */
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function buildAccessUrl(origin, address, token) {
  return `${origin}/?mail=${encodeURIComponent(address)}&token=${encodeURIComponent(token)}`;
}

function normalizeAddress(addr) {
  return String(addr || '').trim().toLowerCase();
}

function resolveValidity(v) {
  const key = DURATIONS[v] ? v : DEFAULT_VALIDITY;
  return DURATIONS[key];
}

/* ------------------------- Core / Service Layer ------------------------ */

async function authInbox(env, address, token) {
  address = normalizeAddress(address);
  if (!address || !token) return null;
  const row = await env.DB.prepare(
    'SELECT id, address, access_token, expires_at, created_at FROM inboxes WHERE address = ?'
  )
    .bind(address)
    .first();

  if (!row) return null;
  if (!(await safeEqual(row.access_token, token))) return null;
  if (row.expires_at <= Date.now()) return null;
  return row;
}

async function requireInbox(env, address, token) {
  const inbox = await authInbox(env, address, token);
  if (!inbox) throw new HttpError(404, 'Inbox not found, expired, or invalid token');
  return inbox;
}

async function createInbox(env, validity, requestedDomain, customPrefix, customSubdomain) {
  const now = Date.now();
  const expiresAt = now + resolveValidity(validity);
  const token = crypto.randomUUID();

  const availableDomains = getDomains(env);
  let baseDomain = availableDomains[0];

  // Resolve base domain
  if (requestedDomain) {
    const reqClean = requestedDomain.toLowerCase().trim();
    // Check if directly matches one of available domains
    if (availableDomains.includes(reqClean)) {
      baseDomain = reqClean;
    } else {
      // Check if requested domain ends with an allowed base domain (e.g. news.temone.skin)
      const matched = availableDomains.find((d) => reqClean === d || reqClean.endsWith('.' + d));
      if (matched) {
        baseDomain = reqClean;
      }
    }
  }

  // Handle subdomain if provided
  let targetDomain = baseDomain;
  if (customSubdomain) {
    const sub = String(customSubdomain).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (sub && !targetDomain.startsWith(sub + '.')) {
      targetDomain = `${sub}.${targetDomain}`;
    }
  }

  // Handle custom prefix
  let prefix = '';
  if (customPrefix) {
    prefix = String(customPrefix).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  }

  if (prefix) {
    const address = `${prefix}@${targetDomain}`.toLowerCase();
    try {
      const existing = await env.DB.prepare('SELECT id, expires_at FROM inboxes WHERE address = ?')
        .bind(address)
        .first();

      if (existing && existing.expires_at > now) {
        throw new HttpError(400, 'This custom email address is already active. Please choose another prefix or subdomain.');
      }

      await env.DB.prepare('DELETE FROM inboxes WHERE address = ?').bind(address).run();
      await env.DB.prepare(
        'INSERT INTO inboxes (address, access_token, expires_at, created_at) VALUES (?, ?, ?, ?)'
      )
        .bind(address, token, expiresAt, now)
        .run();

      return { address, token, expires_at: expiresAt };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'Could not create custom address: ' + e.message);
    }
  }

  // Random generation loop
  for (let attempt = 0; attempt < 10; attempt++) {
    const address = `${randomLocalPart()}@${targetDomain}`.toLowerCase();
    try {
      await env.DB.prepare(
        'INSERT INTO inboxes (address, access_token, expires_at, created_at) VALUES (?, ?, ?, ?)'
      )
        .bind(address, token, expiresAt, now)
        .run();

      return { address, token, expires_at: expiresAt };
    } catch (e) {
      if (!String(e && e.message).includes('UNIQUE')) throw e;
    }
  }

  throw new HttpError(500, 'Could not allocate a temporary address, please retry.');
}

async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of results) {
    if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value;
  }
  return out;
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_SECRET) throw new HttpError(503, 'ADMIN_SECRET is not configured on the Worker');
  const given = request.headers.get('X-Admin-Secret') || '';
  if (!given || !(await safeEqual(given, env.ADMIN_SECRET))) {
    throw new HttpError(401, 'Invalid admin secret');
  }
}

/* ------------------------------ REST Routes ---------------------------- */

const routes = {
  'POST /api/create': async (request, env, url) => {
    const body = await readBody(request);
    const inbox = await createInbox(
      env,
      body.validity || DEFAULT_VALIDITY,
      body.domain,
      body.prefix,
      body.subdomain
    );
    return json({
      ...inbox,
      access_url: buildAccessUrl(url.origin, inbox.address, inbox.token),
    }, 201);
  },

  'GET /api/inbox': async (request, env, url) => {
    const address = url.searchParams.get('address');
    const token = url.searchParams.get('token') || request.headers.get('X-Inbox-Token');
    const inbox = await requireInbox(env, address, token);

    const { results } = await env.DB.prepare(
      'SELECT id, sender, subject, received_at FROM messages WHERE inbox_address = ? ORDER BY received_at DESC, id DESC LIMIT ?'
    )
      .bind(inbox.address, MAX_MESSAGES_PER_INBOX)
      .all();

    return json({
      address: inbox.address,
      expires_at: inbox.expires_at,
      messages: results || [],
    });
  },

  'GET /api/message': async (request, env, url) => {
    const token = url.searchParams.get('token') || request.headers.get('X-Inbox-Token');
    const inbox = await requireInbox(env, url.searchParams.get('address'), token);
    const id = Number(url.searchParams.get('id'));

    if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid message id');

    const msg = await env.DB.prepare(
      'SELECT id, sender, subject, body_html, received_at FROM messages WHERE id = ? AND inbox_address = ?'
    )
      .bind(id, inbox.address)
      .first();

    if (!msg) throw new HttpError(404, 'Message not found');

    const bodyHtml = msg.body_html || '';
    const bodyText = htmlToPlainText(bodyHtml);

    return json({
      id: msg.id,
      sender: msg.sender,
      recipient: inbox.address,
      subject: msg.subject,
      body_html: bodyHtml,
      body_text: bodyText,
      received_at: msg.received_at,
    });
  },

  'DELETE /api/message': async (request, env, url) => {
    const token = url.searchParams.get('token') || request.headers.get('X-Inbox-Token');
    const inbox = await requireInbox(env, url.searchParams.get('address'), token);
    const id = Number(url.searchParams.get('id'));

    if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid message id');

    await env.DB.prepare('DELETE FROM messages WHERE id = ? AND inbox_address = ?')
      .bind(id, inbox.address)
      .run();

    return json({ ok: true });
  },

  'POST /api/recover': async (request, env, url) => {
    const body = await readBody(request);
    let address = body.address;
    let token = body.token;

    if (body.url) {
      try {
        const u = new URL(String(body.url).trim());
        address = u.searchParams.get('mail');
        token = u.searchParams.get('token');
      } catch {
        throw new HttpError(400, 'Invalid access link format');
      }
    }

    const inbox = await requireInbox(env, address, token);
    return json({
      address: inbox.address,
      token: inbox.access_token,
      expires_at: inbox.expires_at,
      access_url: buildAccessUrl(url.origin, inbox.address, inbox.access_token),
    });
  },

  'POST /api/extend': async (request, env) => {
    const body = await readBody(request);
    const inbox = await requireInbox(env, body.address, body.token);

    if (!DURATIONS[body.validity]) throw new HttpError(400, 'Validity must be 24h, 7d, or 30d');

    const expiresAt = Date.now() + DURATIONS[body.validity];
    await env.DB.prepare('UPDATE inboxes SET expires_at = ? WHERE id = ?')
      .bind(expiresAt, inbox.id)
      .run();

    return json({ address: inbox.address, expires_at: expiresAt });
  },

  'DELETE /api/inbox': async (request, env, url) => {
    const token = url.searchParams.get('token') || request.headers.get('X-Inbox-Token');
    const inbox = await requireInbox(env, url.searchParams.get('address'), token);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE inbox_address = ?').bind(inbox.address),
      env.DB.prepare('DELETE FROM inboxes WHERE id = ?').bind(inbox.id),
    ]);

    return json({ ok: true });
  },

  'GET /api/settings': async (request, env) => {
    const domains = getDomains(env);
    const currentSettings = await loadSettings(env);
    const res = json({
      settings: currentSettings,
      domain: domains[0],
      domains,
      default_validity: DEFAULT_VALIDITY,
    });
    res.headers.set('Cache-Control', 'public, max-age=60');
    return res;
  },

  'GET /api/admin/settings': async (request, env) => {
    await requireAdmin(request, env);
    return json({ settings: await loadSettings(env), keys: SETTING_KEYS });
  },

  'PUT /api/admin/settings': async (request, env) => {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const incoming = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const entries = Object.entries(incoming).filter(([k]) => SETTING_KEYS.includes(k));

    if (!entries.length) throw new HttpError(400, 'No valid settings supplied');

    const stmts = entries.map(([k, v]) =>
      env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(k, String(v ?? '').slice(0, 25000))
    );

    await env.DB.batch(stmts);
    return json({ ok: true, updated: entries.map(([k]) => k), settings: await loadSettings(env) });
  },

  'GET /api/admin/stats': async (request, env) => {
    await requireAdmin(request, env);
    const now = Date.now();
    const [a, b] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS c FROM inboxes WHERE expires_at > ?').bind(now).first(),
      env.DB.prepare('SELECT COUNT(*) AS c FROM messages').first(),
    ]);

    return json({ active_inboxes: a ? a.c : 0, stored_messages: b ? b.c : 0 });
  },
};

routes['POST /api/admin/settings'] = routes['PUT /api/admin/settings'];

/* ----------------------- Inbound Cloudflare Email ---------------------- */

async function handleEmail(message, env) {
  let rawTo = message.to || '';
  if (!rawTo && message.headers) {
    rawTo = message.headers.get('to') || '';
  }

  const match = rawTo.match(/<([^>]+)>/);
  if (match) rawTo = match[1];

  const to = normalizeAddress(rawTo);

  const inbox = await env.DB.prepare('SELECT address, expires_at FROM inboxes WHERE address = ?')
    .bind(to)
    .first();

  if (!inbox || inbox.expires_at <= Date.now()) {
    message.setReject('550 5.1.1 Mailbox does not exist or has expired');
    return;
  }

  if (message.rawSize > MAX_RAW_EMAIL_BYTES) {
    message.setReject('552 5.3.4 Message size exceeds 5MB limit');
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw);

  const fromAddr = (parsed.from && parsed.from.address) || message.from || 'unknown';
  const sender = parsed.from && parsed.from.name ? `${parsed.from.name} <${fromAddr}>` : fromAddr;
  const subject = (parsed.subject || '(no subject)').slice(0, 500);

  let body = parsed.html || `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(parsed.text || '')}</pre>`;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS) + '<p><em>[message content truncated]</em></p>';
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO messages (inbox_address, sender, subject, body_html, received_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(inbox.address, sender, subject, body, Date.now()),
    env.DB.prepare(
      `DELETE FROM messages WHERE inbox_address = ?1 AND id NOT IN (
         SELECT id FROM messages WHERE inbox_address = ?1 ORDER BY received_at DESC, id DESC LIMIT ?2
       )`
    ).bind(inbox.address, MAX_MESSAGES_PER_INBOX),
  ]);
}

/* ------------------------------ Cron GC -------------------------------- */

async function garbageCollect(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE inbox_address IN (SELECT address FROM inboxes WHERE expires_at <= ?)').bind(now),
    env.DB.prepare('DELETE FROM inboxes WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM messages WHERE inbox_address NOT IN (SELECT address FROM inboxes)'),
  ]);
}

/* ----------------------------- Exported Worker ------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve static frontend assets for any non-API request
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const handler = routes[`${request.method} ${url.pathname.replace(/\/+$/, '')}`];
    if (!handler) {
      return json({ error: 'Endpoint not found' }, 404);
    }

    try {
      return await handler(request, env, url, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('Unhandled API Error:', e);
      return json({ error: 'Internal server error' }, 500);
    }
  },

  async email(message, env, ctx) {
    try {
      await handleEmail(message, env);
    } catch (e) {
      console.error('Email Routing Handler Error:', e);
      message.setReject('451 4.3.0 Temporary mail processing failure');
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(garbageCollect(env));
  },
};
