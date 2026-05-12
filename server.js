const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const ALLOWED_AGENCIES = new Set(['DMW', 'OWWA']);
const DB_FILE = './queue_simple.db';
const SESSION_COOKIE_NAME = 'queue_auth';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const authSessions = new Map();
const accountActiveSessionTokens = new Map();

// Track every connected socket with its metadata
const connectedSockets = new Map();

const OFFICER_ACCOUNTS = {
  DMW: [
    { username: 'DMW1', password: 'dmw123' },
    { username: 'DMW2', password: 'dmw123' },
    { username: 'DMW3', password: 'dmw123' },
  ],
  OWWA: [
    { username: 'owwa1', password: 'owwa123' },
    { username: 'owwa2', password: 'owwa123' },
    { username: 'owwa3', password: 'owwa123' },
  ],
};
const KIOSK_ACCOUNTS = [
  { username: 'kiosk1', password: 'kiosk123' },
  { username: 'kiosk2', password: 'kiosk123' },
];
const ADMIN_ACCOUNTS = [
  { username: 'admin1', password: 'admin123' },
  { username: 'admin2', password: 'admin123' },
];

function parseCookieHeader(cookieHeader) {
  const entries = String(cookieHeader || '')
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const separatorIndex = segment.indexOf('=');
      if (separatorIndex < 0) {
        return null;
      }

      const key = segment.slice(0, separatorIndex).trim();
      const value = segment.slice(separatorIndex + 1).trim();
      return [key, decodeURIComponent(value)];
    })
    .filter(Boolean);

  return Object.fromEntries(entries);
}

function setAuthCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}

function createAccountSessionKey(role, agency, username) {
  const agencyPart = agency ? String(agency).toUpperCase() : '-';
  return `${String(role || '').toLowerCase()}|${agencyPart}|${String(username || '').toLowerCase()}`;
}

function removeAuthSession(token) {
  const session = authSessions.get(token);
  if (!session) {
    return;
  }

  authSessions.delete(token);

  const accountKey = createAccountSessionKey(session.role, session.agency, session.username);
  if (accountActiveSessionTokens.get(accountKey) === token) {
    accountActiveSessionTokens.delete(accountKey);
  }
}

function getActiveSessionTokenForAccount(role, agency, username) {
  const accountKey = createAccountSessionKey(role, agency, username);
  const token = accountActiveSessionTokens.get(accountKey);

  if (!token) {
    return null;
  }

  const session = authSessions.get(token);
  if (!session) {
    accountActiveSessionTokens.delete(accountKey);
    return null;
  }

  if (Date.now() >= session.expiresAt) {
    removeAuthSession(token);
    return null;
  }

  return token;
}

function createAuthSession(role, agency, username) {
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    role,
    agency,
    username,
    loggedInAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  authSessions.set(token, session);
  const accountKey = createAccountSessionKey(role, agency, username);
  accountActiveSessionTokens.set(accountKey, token);
  return token;
}

function getSessionByToken(token) {
  if (!token) {
    return null;
  }

  const session = authSessions.get(token);
  if (!session) {
    return null;
  }

  if (Date.now() >= session.expiresAt) {
    removeAuthSession(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function getRequestSession(req) {
  const cookies = parseCookieHeader(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE_NAME] || '';
  return {
    token,
    session: getSessionByToken(token),
  };
}

function requireAuthenticatedSession(req, res, next) {
  const { session } = getRequestSession(req);
  if (!session) {
    return res.status(401).json({ authenticated: false, error: 'Authentication required.' });
  }

  req.auth = session;
  return next();
}

function requireOfficerSession(req, res, next) {
  const { session } = getRequestSession(req);
  if (!session || session.role !== 'officer' || !session.agency) {
    return res.status(401).json({ authenticated: false, error: 'Officer authentication required.' });
  }

  req.auth = session;
  return next();
}

function requireAdminSession(req, res, next) {
  const { session } = getRequestSession(req);
  if (!session || session.role !== 'admin') {
    return res.status(401).json({ authenticated: false, error: 'Admin authentication required.' });
  }

  req.auth = session;
  return next();
}

function getSocketSession(socket) {
  const cookies = parseCookieHeader(socket.handshake?.headers?.cookie || '');
  const token = cookies[SESSION_COOKIE_NAME] || '';
  return getSessionByToken(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of authSessions.entries()) {
    if (session.expiresAt <= now) {
      removeAuthSession(token);
    }
  }
}, 1000 * 60 * 10);

app.use(express.json());

// 1. Initialize SQLite Database (Creates a new local file named queue_simple.db)
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error(err.message);
    return;
  }
  console.log('Connected to the SQLite database.');
});

// Keep a compact queue table focused on routing and completion tracking.
db.run(`
  CREATE TABLE IF NOT EXISTS queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    first_name TEXT,
    middle_name TEXT,
    last_name TEXT,
    barangay TEXT,
    municipality TEXT,
    province TEXT,
    gender TEXT,
    agency TEXT NOT NULL,
    services TEXT NOT NULL,
    note TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    assigned_to TEXT,
    assigned_at DATETIME
  )
`);

function ensureQueueColumn(columnName, columnDefinition) {
  db.all('PRAGMA table_info(queue_items)', [], (err, rows) => {
    if (err) {
      console.error(`Failed to inspect queue_items schema: ${err.message}`);
      return;
    }

    const hasColumn = rows.some((column) => column.name === columnName);
    if (hasColumn) {
      return;
    }

    db.run(`ALTER TABLE queue_items ADD COLUMN ${columnName} ${columnDefinition}`, (alterErr) => {
      if (alterErr) {
        console.error(`Failed to add column ${columnName}: ${alterErr.message}`);
      }
    });
  });
}

ensureQueueColumn('assigned_to', 'TEXT');
ensureQueueColumn('assigned_at', 'DATETIME');
ensureQueueColumn('ticket_number', 'INTEGER');
ensureQueueColumn('priority', 'INTEGER DEFAULT 0');

// 2. Serve Frontend Files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/login', (req, res) => {
  const role = String(req.body?.role || '').toLowerCase();
  const agency = String(req.body?.agency || '').toUpperCase();
  const usernameInput = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!usernameInput || !password) {
    return res.status(400).json({ ok: false, message: 'Username and password are required.' });
  }

  if (role === 'kiosk') {
    const matchedKioskAccount = KIOSK_ACCOUNTS.find(
      (account) =>
        account.username.toLowerCase() === usernameInput.toLowerCase() &&
        account.password === password
    );

    if (!matchedKioskAccount) {
      return res.status(401).json({ ok: false, message: 'Invalid kiosk username or password.' });
    }

    if (getActiveSessionTokenForAccount('kiosk', null, matchedKioskAccount.username)) {
      return res.status(409).json({
        ok: false,
        message: 'This account is already logged in on another device.',
      });
    }

    const token = createAuthSession('kiosk', null, matchedKioskAccount.username);
    setAuthCookie(res, token);

    return res.json({
      ok: true,
      auth: {
        role: 'kiosk',
        username: matchedKioskAccount.username,
        loggedInAt: new Date().toISOString(),
      },
    });
  }

  // Admin login
  if (role === 'admin' || !role) {
    const matchedAdmin = ADMIN_ACCOUNTS.find(
      (account) =>
        account.username.toLowerCase() === usernameInput.toLowerCase() &&
        account.password === password
    );

    if (matchedAdmin) {
      // Admins can have multiple concurrent sessions (no single-session restriction)
      const token = createAuthSession('admin', null, matchedAdmin.username);
      setAuthCookie(res, token);

      return res.json({
        ok: true,
        auth: {
          role: 'admin',
          username: matchedAdmin.username,
          loggedInAt: new Date().toISOString(),
        },
      });
    }

    if (role === 'admin') {
      return res.status(401).json({ ok: false, message: 'Invalid admin username or password.' });
    }
  }

  if (!role) {
    const matchedKioskAccount = KIOSK_ACCOUNTS.find(
      (account) =>
        account.username.toLowerCase() === usernameInput.toLowerCase() &&
        account.password === password
    );

    if (matchedKioskAccount) {
      if (getActiveSessionTokenForAccount('kiosk', null, matchedKioskAccount.username)) {
        return res.status(409).json({
          ok: false,
          message: 'This account is already logged in on another device.',
        });
      }

      const token = createAuthSession('kiosk', null, matchedKioskAccount.username);
      setAuthCookie(res, token);

      return res.json({
        ok: true,
        auth: {
          role: 'kiosk',
          username: matchedKioskAccount.username,
          loggedInAt: new Date().toISOString(),
        },
      });
    }

    for (const [agencyName, accounts] of Object.entries(OFFICER_ACCOUNTS)) {
      const matchedAccount = accounts.find(
        (account) =>
          account.username.toLowerCase() === usernameInput.toLowerCase() &&
          account.password === password
      );

      if (!matchedAccount) {
        continue;
      }

      if (getActiveSessionTokenForAccount('officer', agencyName, matchedAccount.username)) {
        return res.status(409).json({
          ok: false,
          message: 'This account is already logged in on another device.',
        });
      }

      const token = createAuthSession('officer', agencyName, matchedAccount.username);
      setAuthCookie(res, token);

      return res.json({
        ok: true,
        auth: {
          role: 'officer',
          agency: agencyName,
          username: matchedAccount.username,
          loggedInAt: new Date().toISOString(),
        },
      });
    }

    return res.status(401).json({ ok: false, message: 'Invalid username or password.' });
  }

  if (role !== 'officer' || !ALLOWED_AGENCIES.has(agency)) {
    return res.status(400).json({ ok: false, message: 'Agency, username, and password are required.' });
  }

  const accounts = OFFICER_ACCOUNTS[agency] || [];
  const matchedAccount = accounts.find((account) => account.username.toLowerCase() === usernameInput.toLowerCase());

  if (!matchedAccount || matchedAccount.password !== password) {
    return res.status(401).json({ ok: false, message: 'Invalid username or password.' });
  }

  if (getActiveSessionTokenForAccount('officer', agency, matchedAccount.username)) {
    return res.status(409).json({
      ok: false,
      message: 'This account is already logged in on another device.',
    });
  }

  const token = createAuthSession('officer', agency, matchedAccount.username);
  setAuthCookie(res, token);

  return res.json({
    ok: true,
    auth: {
      role: 'officer',
      agency,
      username: matchedAccount.username,
      loggedInAt: new Date().toISOString(),
    },
  });
});

app.get('/api/auth/session', (req, res) => {
  const roleParam = String(req.query.role || '').toLowerCase();
  const agencyParam = String(req.query.agency || '').toUpperCase();
  const { session } = getRequestSession(req);

  if (!session) {
    return res.status(401).json({ authenticated: false });
  }

  if (roleParam && session.role !== roleParam) {
    return res.status(403).json({ authenticated: false, message: 'Signed in with a different account role.' });
  }

  if (agencyParam && session.agency !== agencyParam) {
    return res.status(403).json({ authenticated: false, message: 'Signed in to a different agency.' });
  }

  return res.json({
    authenticated: true,
    role: session.role,
    agency: session.agency,
    username: session.username,
    loggedInAt: session.loggedInAt,
  });
});

app.post('/api/auth/logout', (req, res) => {
  const { token } = getRequestSession(req);
  if (token) {
    removeAuthSession(token);
  }

  clearAuthCookie(res);
  return res.json({ ok: true });
});

function mapRowToClient(row) {
  let parsedServices = [];

  try {
    parsedServices = JSON.parse(row.services);
  } catch (_error) {
    parsedServices = String(row.services)
      .split(',')
      .map((service) => service.trim())
      .filter(Boolean);
  }

  const agencyPrefix = row.agency === 'DMW' ? 'D' : 'O';
  const displayNum = row.ticket_number ? String(row.ticket_number).padStart(3, '0') : String(row.id);

  return {
    ticket_id: row.id,
    ticket_number: row.ticket_number || null,
    display_ticket: `${agencyPrefix}-${displayNum}`,
    client_identifier:
      [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ').trim() || row.client_name,
    first_name: row.first_name || '',
    middle_name: row.middle_name || '',
    last_name: row.last_name || '',
    barangay: row.barangay || '',
    municipality: row.municipality || '',
    province: row.province || '',
    gender: row.gender || '',
    agency: row.agency,
    services: parsedServices,
    note: row.note || '',
    status: row.status,
    priority: row.priority ? 1 : 0,
    assigned_to: row.assigned_to || '',
    assigned_at: row.assigned_at,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function escapeCsv(value) {
  const safe = String(value ?? '');
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

// Simple endpoint to get all clients quickly in JSON.
app.get('/api/clients', requireOfficerSession, (req, res) => {
  const requestedAgency = String(req.query.agency || '').toUpperCase();
  const agency = req.auth.agency;
  const status = String(req.query.status || '').toLowerCase();
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 500;

  if (requestedAgency && requestedAgency !== agency) {
    return res.status(403).json({ error: 'Access to this agency is not allowed for the active account.' });
  }

  let sql = `
    SELECT id, ticket_number, client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
           agency, services, note, status, priority, assigned_to, assigned_at, created_at, completed_at
    FROM queue_items
    WHERE agency = ?
  `;
  const params = [agency];

  if (status) {
    if (status !== 'waiting' && status !== 'done') {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY priority DESC, created_at DESC LIMIT ?';
  params.push(limit);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to load clients.' });
    }

    return res.json(rows.map(mapRowToClient));
  });
});

// Quick CSV export for spreadsheet/report use.
app.get('/api/clients.csv', requireOfficerSession, (req, res) => {
  const sql = `
    SELECT id, client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
           agency, services, note, status, priority, assigned_to, assigned_at, created_at, completed_at
    FROM queue_items
    WHERE agency = ?
    ORDER BY created_at DESC
  `;
  db.all(sql, [req.auth.agency], (err, rows) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send('Failed to export CSV.');
    }

    const headers = [
      'ticket_id',
      'client_name',
      'first_name',
      'middle_name',
      'last_name',
      'barangay',
      'municipality',
      'province',
      'gender',
      'agency',
      'services',
      'note',
      'status',
      'created_at',
      'completed_at',
    ];

    const lines = [headers.join(',')];

    rows.forEach((row) => {
      lines.push(
        [
          row.id,
          row.client_name,
          row.first_name,
          row.middle_name,
          row.last_name,
          row.barangay,
          row.municipality,
          row.province,
          row.gender,
          row.agency,
          row.services,
          row.note,
          row.status,
          row.created_at,
          row.completed_at,
        ]
          .map(escapeCsv)
          .join(',')
      );
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
    return res.send(lines.join('\n'));
  });
});

// Secure Audio Proxy to bypass Browser CORS/Autoplay blocks
app.get('/api/tts', (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).send('No text provided');

  const https = require('https');
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;

  https.get(url, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      return res.status(proxyRes.statusCode || 500).send('TTS Upstream Error');
    }
    // Forward the MP3 directly to the frontend window
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.error('Google TTS Proxy failed:', err);
    res.status(500).send('TTS Server Error');
  });
});

// Admin: full overview stats + all queues across both agencies
app.get('/api/admin/overview', requireAdminSession, (_req, res) => {
  // Today's records only (for stats + live queues)
  const todaySql = `
    SELECT id, ticket_number, client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
           agency, services, note, status, priority, assigned_to, assigned_at, created_at, completed_at
    FROM queue_items
    WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')
    ORDER BY id ASC
  `;

  // Last 50 records across all time (for the activity log)
  const recentSql = `
    SELECT id, ticket_number, client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
           agency, services, note, status, priority, assigned_to, assigned_at, created_at, completed_at
    FROM queue_items
    ORDER BY id DESC
    LIMIT 50
  `;

  db.all(todaySql, [], (err, todayRows) => {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to load overview.' });
    }

    db.all(recentSql, [], (recentErr, recentRows) => {
      if (recentErr) {
        console.error(recentErr.message);
        return res.status(500).json({ error: 'Failed to load recent activity.' });
      }

      const today = todayRows.map(mapRowToClient);
      const waiting = today.filter((c) => c.status === 'waiting');
      const done = today.filter((c) => c.status === 'done');

      return res.json({
        stats: {
          total: today.length,
          waiting: waiting.length,
          done: done.length,
          dmw_waiting: waiting.filter((c) => c.agency === 'DMW').length,
          owwa_waiting: waiting.filter((c) => c.agency === 'OWWA').length,
          dmw_done: done.filter((c) => c.agency === 'DMW').length,
          owwa_done: done.filter((c) => c.agency === 'OWWA').length,
        },
        dmw: waiting.filter((c) => c.agency === 'DMW'),
        owwa: waiting.filter((c) => c.agency === 'OWWA'),
        recent: recentRows.map(mapRowToClient),
      });
    });
  });
});

// Admin: full client history across all agencies
app.get('/api/admin/clients', requireAdminSession, (req, res) => {
  const status = String(req.query.status || '').toLowerCase();
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 2000 ? limitRaw : 500;

  let sql = `
    SELECT id, ticket_number, client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
           agency, services, note, status, priority, assigned_to, assigned_at, created_at, completed_at
    FROM queue_items
  `;
  const params = [];

  if (status === 'waiting' || status === 'done' || status === 'expired') {
    sql += ' WHERE status = ?';
    params.push(status);
  }

  sql += ' ORDER BY priority DESC, id ASC LIMIT ?';
  params.push(limit);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to load clients.' });
    }

    return res.json(rows.map(mapRowToClient));
  });
});

// Admin: list all connected devices
app.get('/api/admin/devices', requireAdminSession, (_req, res) => {
  const devices = [];
  for (const [socketId, meta] of connectedSockets.entries()) {
    devices.push({ socketId, ...meta });
  }
  // Sort: admins first, then officers, then others
  const roleOrder = { admin: 0, officer: 1, kiosk: 2, other: 3 };
  devices.sort((a, b) => (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3));
  return res.json(devices);
});

// Admin: force-disconnect a device by socket ID
app.post('/api/admin/devices/:socketId/disconnect', requireAdminSession, (req, res) => {
  const targetSocketId = req.params.socketId;
  const meta = connectedSockets.get(targetSocketId);
  const targetSocket = io.sockets.sockets.get(targetSocketId);

  if (!targetSocket) {
    connectedSockets.delete(targetSocketId);
    return res.status(404).json({ ok: false, message: 'Device not found or already disconnected.' });
  }

  // Invalidate the server-side auth session so the user must re-login
  if (meta && meta.token) {
    removeAuthSession(meta.token);
  }

  // Tell the client it has been kicked (client will disconnect itself + redirect)
  targetSocket.emit('force_disconnect', {
    reason: 'You have been disconnected by the administrator.',
  });

  // Hard-disconnect after 800ms to ensure the event is received
  setTimeout(() => {
    targetSocket.disconnect(true);
  }, 800);

  connectedSockets.delete(targetSocketId);

  // Notify all admins that device list changed
  io.emit('admin_devices_changed');

  return res.json({ ok: true, message: 'Device disconnected.' });
});

// Admin: trigger manual backup + reset
app.post('/api/admin/backup-and-reset', requireAdminSession, (_req, res) => {
  runDailyBackupAndReset(true, (err, result) => {
    if (err) return res.status(500).json({ ok: false, message: 'Backup or reset failed. Check server logs.' });
    return res.json({ ok: true, message: `Backup and reset complete for ${result.date}.`, date: result.date });
  });
});

// Admin: list available database backups
app.get('/api/admin/backups', requireAdminSession, (_req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse()
      .map((f) => ({
        filename: f,
        label: f.replace('queue_backup_', '').replace('.db', '').replace('_', ' @ '),
        size: fs.statSync(path.join(BACKUP_DIR, f)).size,
      }));
    return res.json(files);
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to list backups.' });
  }
});

// Direct download of the SQLite file.
app.get('/api/database/file', requireOfficerSession, (_req, res) => {
  const dbPath = path.join(__dirname, 'queue_simple.db');
  return res.download(dbPath, 'queue_simple.db');
});

app.get('/api/queue/:agency', requireOfficerSession, (req, res) => {
  const agency = String(req.params.agency || '').toUpperCase();

  if (!ALLOWED_AGENCIES.has(agency)) {
    return res.status(400).json({ error: 'Invalid agency.' });
  }

  if (req.auth.agency !== agency) {
    return res.status(403).json({ error: 'Access to this agency queue is not allowed for the active account.' });
  }

  const status = String(req.query.status || '').toLowerCase();
  const hasStatusFilter = status === 'waiting' || status === 'done';
  const scope = String(req.query.scope || '').toLowerCase();
  const officer = req.auth.username;

  let sql = `
    SELECT id, ticket_number, client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
           agency, services, note, status, priority, assigned_to, assigned_at, created_at, completed_at
    FROM queue_items
    WHERE agency = ? AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
  `;
  const params = [agency];

  if (hasStatusFilter) {
    sql += ' AND status = ?';
    params.push(status);
  }

  if (scope === 'available') {
    sql += " AND (assigned_to IS NULL OR assigned_to = '')";
  } else if (scope === 'mine') {
    sql += ' AND assigned_to = ?';
    params.push(officer);
  }

  sql += scope === 'mine' ? ' ORDER BY priority DESC, assigned_at DESC, created_at DESC' : ' ORDER BY priority DESC, created_at DESC';

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to load queue.' });
    }

    const payload = rows.map(mapRowToClient);
    return res.json(payload);
  });
});

app.get('/api/display/next', (_req, res) => {
  const sql = `
    SELECT id, ticket_number, client_name, first_name, middle_name, last_name, agency, priority, assigned_to, assigned_at, created_at
    FROM queue_items
    WHERE agency = ? AND status = 'waiting' AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
    ORDER BY priority DESC, CASE WHEN assigned_at IS NULL THEN 1 ELSE 0 END, assigned_at DESC, created_at ASC
  `;

  function mapDisplayRow(row) {
    const pfx = row.agency === 'DMW' ? 'D' : 'O';
    const dNum = row.ticket_number ? String(row.ticket_number).padStart(3, '0') : String(row.id);
    return {
      ticket_id: row.id,
      ticket_number: row.ticket_number || null,
      display_ticket: `${pfx}-${dNum}`,
      client_name: row.client_name,
      first_name: row.first_name,
      middle_name: row.middle_name,
      last_name: row.last_name,
      client_identifier: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ').trim() || row.client_name,
      agency: row.agency,
      priority: row.priority ? 1 : 0,
      assigned_to: row.assigned_to,
      assigned_at: row.assigned_at,
      created_at: row.created_at,
    };
  }

  db.all(sql, ['DMW'], (dmwErr, dmwRows) => {
    if (dmwErr) {
      console.error(dmwErr.message);
      return res.status(500).json({ error: 'Failed to load DMW queue display.' });
    }

    db.all(sql, ['OWWA'], (owwaErr, owwaRows) => {
      if (owwaErr) {
        console.error(owwaErr.message);
        return res.status(500).json({ error: 'Failed to load OWWA queue display.' });
      }

      return res.json({
        now: new Date().toISOString(),
        dmw: (dmwRows || []).map(mapDisplayRow),
        owwa: (owwaRows || []).map(mapDisplayRow),
      });
    });
  });
});

// Admin: Mark ticket as done
app.post('/api/admin/ticket/:id/done', requireAdminSession, (req, res) => {
  const ticketId = Number(req.params.id);
  db.run(`UPDATE queue_items SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?`, [ticketId], function (err) {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to mark ticket as done.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Ticket not found.' });

    io.emit('queue_reset');
    return res.json({ ok: true, message: 'Ticket marked as done.' });
  });
});

// Admin: Cancel a ticket (mark as cancelled)
app.post('/api/admin/ticket/:id/cancel', requireAdminSession, (req, res) => {
  const ticketId = Number(req.params.id);
  db.run(`UPDATE queue_items SET status = 'cancelled' WHERE id = ?`, [ticketId], function (err) {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to cancel ticket.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Ticket not found.' });

    io.emit('queue_reset');
    return res.json({ ok: true, message: 'Ticket cancelled successfully.' });
  });
});

// Admin: Remove a ticket (delete permanently)
app.delete('/api/admin/ticket/:id', requireAdminSession, (req, res) => {
  const ticketId = Number(req.params.id);
  db.run(`DELETE FROM queue_items WHERE id = ?`, [ticketId], function (err) {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ error: 'Failed to delete ticket.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Ticket not found.' });

    io.emit('queue_reset');
    return res.json({ ok: true, message: 'Ticket removed permanently.' });
  });
});

// 3. Real-Time WebSocket Routing
io.on('connection', (socket) => {
  console.log('A system connected to the network.');

  // Resolve session info for this socket
  const connectSession = getSocketSession(socket);
  const connectedAt = new Date().toISOString();
  const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'Unknown';
  const ip = String(rawIp).split(',')[0].trim();
  const userAgent = String(socket.handshake.headers['user-agent'] || 'Unknown').slice(0, 120);

  connectedSockets.set(socket.id, {
    role: connectSession?.role || 'guest',
    agency: connectSession?.agency || null,
    username: connectSession?.username || null,
    connectedAt,
    ip,
    userAgent,
    token: parseCookieHeader(socket.handshake?.headers?.cookie || '')[SESSION_COOKIE_NAME] || null,
  });

  // Notify all admins
  io.emit('admin_devices_changed');

  // Listen for the Kiosk sending a digital note
  socket.on('submit_kiosk_note', (data) => {
    const session = getSocketSession(socket);
    if (!session || session.role !== 'kiosk') {
      return;
    }

    if (!data || !data.agency || !Array.isArray(data.services)) {
      return;
    }

    const agency = String(data.agency).toUpperCase();
    const firstName = String(data.first_name || '').trim();
    const middleName = String(data.middle_name || '').trim();
    const lastName = String(data.last_name || '').trim();
    const barangay = String(data.barangay || '').trim();
    const municipality = String(data.municipality || '').trim();
    const province = String(data.province || '').trim();
    const gender = String(data.gender || '').trim();
    const clientIdentifier = [firstName, middleName, lastName].filter(Boolean).join(' ').trim();

    if (
      !ALLOWED_AGENCIES.has(agency) ||
      data.services.length === 0 ||
      !firstName ||
      !lastName ||
      !municipality ||
      !province ||
      !gender
    ) {
      return;
    }

    const note = typeof data.note === 'string' ? data.note.trim() : '';
    const priority = data.priority ? 1 : 0;

    // Get next per-agency ticket number for TODAY only (resets to 1 each new day)
    db.get(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_num
       FROM queue_items
       WHERE agency = ? AND DATE(created_at, 'localtime') = DATE('now', 'localtime')`,
      [agency],
      (numErr, numRow) => {
        if (numErr) {
          console.error(numErr.message);
          return;
        }

        const ticketNumber = numRow.next_num;
        const ticketPrefix = agency === 'DMW' ? 'D' : 'O';
        const displayTicket = `${ticketPrefix}-${String(ticketNumber).padStart(3, '0')}`;

        const sql = `
          INSERT INTO queue_items (
            client_name, first_name, middle_name, last_name, barangay, municipality, province, gender,
            agency, services, note, status, ticket_number, priority
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(
          sql,
          [
            clientIdentifier,
            firstName,
            middleName,
            lastName,
            barangay,
            municipality,
            province,
            gender,
            agency,
            JSON.stringify(data.services),
            note,
            'waiting',
            ticketNumber,
            priority,
          ],
          function (err) {
            if (err) {
              console.error(err.message);
              return;
            }

            // Attach the database ID and display ticket to the payload
            const payload = {
              ticket_id: this.lastID,
              ticket_number: ticketNumber,
              display_ticket: displayTicket,
              client_identifier: clientIdentifier,
              first_name: firstName,
              middle_name: middleName,
              last_name: lastName,
              barangay,
              municipality,
              province,
              gender,
              agency,
              services: data.services,
              note,
              status: 'waiting',
              priority,
            };

            // Route the data strictly to the correct agency
            if (agency === 'DMW') {
              io.emit('dmw_incoming_client', payload);
            } else if (agency === 'OWWA') {
              io.emit('owwa_incoming_client', payload);
            }
          }
        );
      }
    );
  });

  socket.on('claim_ticket', (data, callback) => {
    const session = getSocketSession(socket);
    if (!session || session.role !== 'officer') {
      if (typeof callback === 'function') {
        callback({ ok: false, message: 'Authentication required.' });
      }
      return;
    }

    const ticketId = Number(data?.ticket_id);
    const agency = String(data?.agency || '').toUpperCase();
    const officer = session.username;

    if (!Number.isInteger(ticketId) || ticketId <= 0 || !ALLOWED_AGENCIES.has(agency) || session.agency !== agency) {
      if (typeof callback === 'function') {
        callback({ ok: false, message: 'Invalid ticket, agency, or account session.' });
      }
      return;
    }

    db.get(
      'SELECT id, status, assigned_to, ticket_number, client_name, first_name, middle_name, last_name FROM queue_items WHERE id = ? AND agency = ?',
      [ticketId, agency],
      (readErr, row) => {
        if (readErr) {
          console.error(readErr.message);
          if (typeof callback === 'function') {
            callback({ ok: false, message: 'Failed to load ticket.' });
          }
          return;
        }

        if (!row || row.status !== 'waiting') {
          if (typeof callback === 'function') {
            callback({ ok: false, message: 'Ticket is not available.' });
          }
          return;
        }

        if (row.assigned_to && row.assigned_to !== officer) {
          if (typeof callback === 'function') {
            callback({ ok: false, message: `Ticket already claimed by ${row.assigned_to}.` });
          }
          return;
        }

        if (row.assigned_to === officer) {
          if (typeof callback === 'function') {
            callback({ ok: true, alreadyClaimed: true });
          }
          return;
        }

        const claimSql = `
          UPDATE queue_items
          SET assigned_to = ?, assigned_at = CURRENT_TIMESTAMP
          WHERE id = ? AND agency = ? AND status = 'waiting' AND (assigned_to IS NULL OR assigned_to = '')
        `;

        db.run(claimSql, [officer, ticketId, agency], function (updateErr) {
          if (updateErr) {
            console.error(updateErr.message);
            if (typeof callback === 'function') {
              callback({ ok: false, message: 'Failed to claim ticket.' });
            }
            return;
          }

          if (this.changes === 0) {
            if (typeof callback === 'function') {
              callback({ ok: false, message: 'Ticket was already claimed.' });
            }
            return;
          }

          const updateEvent = agency === 'DMW' ? 'dmw_client_updated' : 'owwa_client_updated';
          const ticketPrefix = agency === 'DMW' ? 'D' : 'O';
          const dNum = row.ticket_number ? String(row.ticket_number).padStart(3, '0') : String(row.id);
          const displayTicket = `${ticketPrefix}-${dNum}`;

          const clientFullName = row.client_name || [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ').trim() || '';

          io.emit(updateEvent, { ticket_id: ticketId, display_ticket: displayTicket, client_name: clientFullName, status: 'waiting', assigned_to: officer, action: 'claimed' });

          if (typeof callback === 'function') {
            callback({ ok: true });
          }
        });
      }
    );
  });

  socket.on('mark_client_done', (data, callback) => {
    const session = getSocketSession(socket);
    if (!session || session.role !== 'officer') {
      if (typeof callback === 'function') {
        callback({ ok: false, message: 'Authentication required.' });
      }
      return;
    }

    const ticketId = Number(data?.ticket_id);
    const agency = String(data?.agency || '').toUpperCase();
    const officer = session.username;

    if (!Number.isInteger(ticketId) || ticketId <= 0 || !ALLOWED_AGENCIES.has(agency) || session.agency !== agency) {
      if (typeof callback === 'function') {
        callback({ ok: false, message: 'Invalid ticket, agency, or account session.' });
      }
      return;
    }

    const sql = `
      UPDATE queue_items
      SET status = 'done', completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agency = ? AND status != 'done' AND assigned_to = ?
    `;

    db.run(sql, [ticketId, agency, officer], function (err) {
      if (err) {
        console.error(err.message);
        if (typeof callback === 'function') {
          callback({ ok: false, message: 'Failed to update status.' });
        }
        return;
      }

      if (this.changes === 0) {
        if (typeof callback === 'function') {
          callback({ ok: false, message: 'Ticket not found, unavailable, or assigned to another officer.' });
        }
        return;
      }

      const updateEvent = agency === 'DMW' ? 'dmw_client_updated' : 'owwa_client_updated';
      io.emit(updateEvent, { ticket_id: ticketId, status: 'done' });

      if (typeof callback === 'function') {
        callback({ ok: true });
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('A system disconnected from the network.');
    connectedSockets.delete(socket.id);
    // Notify all admins
    io.emit('admin_devices_changed');
  });
});

// --- Daily Backup & Reset System ---
const BACKUP_DIR = path.join(__dirname, 'backups');
const LAST_RESET_FILE = path.join(__dirname, 'last_reset.txt');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function getTodayDateString() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function getLastResetDate() {
  try { return fs.readFileSync(LAST_RESET_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function setLastResetDate(dateStr) {
  try { fs.writeFileSync(LAST_RESET_FILE, dateStr); } catch (_) { }
}

function backupDatabase(dateStr, callback) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const backupPath = path.join(BACKUP_DIR, `queue_backup_${dateStr}_${timeStr}.db`);
  const backupAbsPath = path.resolve(backupPath).replace(/\\/g, '/');

  // Try VACUUM INTO for a clean consistent copy
  db.run(`VACUUM INTO '${backupAbsPath.replace(/'/g, "''")}'`, [], (vacuumErr) => {
    if (!vacuumErr) {
      console.log(`[Backup] Saved: ${backupPath}`);
      if (typeof callback === 'function') callback(null, backupPath);
      return;
    }
    // Fallback: plain file copy
    fs.copyFile(path.resolve(DB_FILE), backupPath, (copyErr) => {
      if (copyErr) {
        console.error(`[Backup] Failed: ${copyErr.message}`);
        if (typeof callback === 'function') callback(copyErr);
        return;
      }
      console.log(`[Backup] Saved (copy): ${backupPath}`);
      if (typeof callback === 'function') callback(null, backupPath);
    });
  });
}

function resetQueue(callback) {
  // Mark leftover waiting tickets as 'expired' — data stays in DB for history
  db.run(
    "UPDATE queue_items SET status = 'expired', completed_at = CURRENT_TIMESTAMP WHERE status = 'waiting'",
    [],
    (err) => {
      if (err) {
        console.error(`[Reset] Failed to expire waiting tickets: ${err.message}`);
        if (typeof callback === 'function') callback(err);
        return;
      }
      console.log('[Reset] Waiting tickets marked as expired. History preserved.');
      if (typeof callback === 'function') callback(null);
    }
  );
}

function runDailyBackupAndReset(isManual, callback) {
  const dateStr = getTodayDateString();
  console.log(`[Daily] ${isManual ? 'Manual' : 'Scheduled'} backup & reset — ${dateStr}`);

  backupDatabase(dateStr, (backupErr, backupPath) => {
    if (backupErr) {
      if (typeof callback === 'function') callback(backupErr);
      return;
    }

    resetQueue((resetErr) => {
      if (resetErr) {
        if (typeof callback === 'function') callback(resetErr);
        return;
      }

      setLastResetDate(dateStr);
      io.emit('system_daily_reset', {
        date: dateStr,
        message: 'Queue has been reset for the new day. Ticket numbers restart from D-001 / O-001.',
      });
      console.log('[Daily] Backup & reset complete. Queue is fresh for today.');
      if (typeof callback === 'function') callback(null, { date: dateStr, backupPath });
    });
  });
}

function scheduleNextMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 30, 0); // 12:00:30 AM next day
  const msUntil = midnight.getTime() - now.getTime();
  console.log(`[Daily] Next auto-reset in ${Math.round(msUntil / 60000)} minute(s).`);
  setTimeout(() => {
    runDailyBackupAndReset(false, () => scheduleNextMidnightReset());
  }, msUntil);
}

function checkStartupReset() {
  const today = getTodayDateString();
  const lastReset = getLastResetDate();
  if (lastReset === today) {
    console.log(`[Daily] Already reset today (${today}). Next reset at midnight.`);
    scheduleNextMidnightReset();
  } else {
    console.log(`[Daily] Last reset: ${lastReset || 'never'}. Running startup reset now...`);
    runDailyBackupAndReset(false, () => scheduleNextMidnightReset());
  }
}

// 4. Start Server on network IP (0.0.0.0 allows LAN access)
const PORT = 3000;
const os = require('os');

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name]) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Other PCs on the same WiFi connect via http://${lanIp}:${PORT}`);
  // Run daily reset check 2 seconds after server is ready
  setTimeout(checkStartupReset, 2000);
});
