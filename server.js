const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TOTAL_WORDS = 975;
const TARGET_MASTERY = 0.98; // 98%
const TARGET_WORDS = Math.ceil(TOTAL_WORDS * TARGET_MASTERY); // 956 words
const EXAM_DATE = new Date('2026-05-07');
const TOTAL_DAYS = 35;

// ============================================================
// Input sanitization
// ============================================================
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>\"\'&;\\\/\`]/g, '') // strip dangerous chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200); // max length
}

function sanitizeSyncCode(str) {
  if (typeof str !== 'string') return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
}

// ============================================================
// Database
// ============================================================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress (
      sync_code TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database initialized');
}
initDB().catch(console.error);

// ============================================================
// API Routes
// ============================================================

// Get progress
app.get('/api/progress/:code', async (req, res) => {
  try {
    const code = sanitizeSyncCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid code' });
    const { rows } = await pool.query(
      'SELECT data, updated_at FROM progress WHERE sync_code = $1',
      [code]
    );
    if (rows.length > 0) {
      res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
    } else {
      res.json({ data: null });
    }
  } catch (err) {
    console.error('GET error:', err);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// Save progress
app.put('/api/progress/:code', async (req, res) => {
  try {
    const code = sanitizeSyncCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid code' });
    const data = req.body;
    // Validate data structure
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid data' });
    await pool.query(
      `INSERT INTO progress (sync_code, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (sync_code)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [code, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT error:', err);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ============================================================
// Admin API
// ============================================================
const crypto = require('crypto');

// Simple token store (in-memory, resets on restart - fine for this use case)
const adminTokens = new Set();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Admin login - validates against EMAIL_USER/EMAIL_PASS env vars
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (email === process.env.EMAIL_USER && password === (process.env.ADMIN_PASSWORD || process.env.EMAIL_PASS)) {
    const token = generateToken();
    adminTokens.add(token);
    // Auto-expire token after 24 hours
    setTimeout(() => adminTokens.delete(token), 24 * 60 * 60 * 1000);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Middleware to verify admin token
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get all users' progress (admin only)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT sync_code, data, updated_at FROM progress ORDER BY updated_at DESC');
    const users = rows.map(row => {
      const data = row.data;
      const wordStats = data.wordStats || {};
      let mastered = 0, struggles = 0, weak = 0;
      const totalTracked = Object.keys(wordStats).length;
      for (const key of Object.keys(wordStats)) {
        const s = wordStats[key];
        // Match frontend isWordMastered logic: directional if available, else overall
        const deEnC = s.deEn?.correct || 0;
        const enDeC = s.enDe?.correct || 0;
        const hasDirectional = deEnC > 0 || enDeC > 0;
        const isMastered = hasDirectional
          ? (deEnC >= 3 && enDeC >= 3)
          : (s.correct >= 3);
        if (isMastered) mastered++;
        else if (s.wrong >= 2) struggles++;
        else if ((s.correct + s.wrong) > 0) weak++;
      }
      const unseen = TOTAL_WORDS - totalTracked;
      const totalCorrect = data.totalCorrect || 0;
      const totalWrong = data.totalWrong || 0;
      const totalAttempted = totalCorrect + totalWrong;
      const accuracy = totalAttempted > 0 ? Math.round(totalCorrect / totalAttempted * 100) : 0;
      const today = new Date().toISOString().slice(0, 10);
      const todayScore = (data.dailyScores || {})[today] || { correct: 0, wrong: 0 };
      const daysLeft = Math.min(TOTAL_DAYS, Math.max(0, Math.ceil((EXAM_DATE - new Date()) / (1000 * 60 * 60 * 24))));
      const wordsNeeded = Math.max(0, TARGET_WORDS - mastered);
      const wordsPerDay = daysLeft > 0 ? Math.ceil(wordsNeeded / daysLeft) : wordsNeeded;

      // Get top struggle words
      const topStruggles = Object.entries(wordStats)
        .filter(([, s]) => s.wrong >= 2)
        .sort((a, b) => b[1].wrong - a[1].wrong)
        .slice(0, 10)
        .map(([key, s]) => ({ word: key.split('|')[0], meaning: key.split('|')[1], wrong: s.wrong, correct: s.correct }));

      // Daily history (last 35 days)
      const dailyHistory = [];
      let activeDays = 0;
      let totalNewMastered = 0;
      for (let i = TOTAL_DAYS - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dk = d.toISOString().slice(0, 10);
        const ds = (data.dailyScores || {})[dk] || { correct: 0, wrong: 0 };
        const newMastered = Math.round(ds.correct / 3); // estimate
        if (ds.correct > 0) activeDays++;
        totalNewMastered += newMastered;
        dailyHistory.push({ date: dk, correct: ds.correct, wrong: ds.wrong, newMastered });
      }

      const avgPerDay = activeDays > 0 ? Math.round(totalNewMastered / activeDays) : 0;
      const onTrack = avgPerDay >= wordsPerDay;

      return {
        name: row.sync_code,
        lastActive: row.updated_at,
        mastered, struggles, weak, unseen,
        totalAttempted, accuracy,
        bestStreak: data.bestStreak || 0,
        todayCorrect: todayScore.correct,
        todayWrong: todayScore.wrong,
        wordsPerDay, daysLeft,
        masteryPct: Math.round(mastered / TOTAL_WORDS * 100),
        avgPerDay, onTrack,
        topStruggles,
        dailyHistory
      };
    });
    res.json({ users, totalWords: TOTAL_WORDS, targetWords: TARGET_WORDS, daysLeft: Math.min(TOTAL_DAYS, Math.max(0, Math.ceil((EXAM_DATE - new Date()) / (1000 * 60 * 60 * 24)))) });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ============================================================
// Get detailed word stats for a specific user (admin only)
app.get('/api/admin/users/:code/words', requireAdmin, async (req, res) => {
  try {
    const code = sanitizeSyncCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid code' });
    const { rows } = await pool.query('SELECT data FROM progress WHERE sync_code = $1', [code]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const data = rows[0].data;
    const wordStats = data.wordStats || {};
    const words = {};

    // Build full word list from stats keys
    for (const [key, stat] of Object.entries(wordStats)) {
      const [de, en] = key.split('|');
      words[key] = {
        de, en,
        correct: stat.correct || 0,
        wrong: stat.wrong || 0,
        lastSeen: stat.lastSeen,
        deEn: stat.deEn || { correct: 0, wrong: 0 },
        enDe: stat.enDe || { correct: 0, wrong: 0 },
      };
    }

    res.json({ words, totalWords: TOTAL_WORDS });
  } catch (err) {
    console.error('Admin user words error:', err);
    res.status(500).json({ error: 'Failed to fetch user words' });
  }
});

// ============================================================
// Email Report
// ============================================================
const transporter = process.env.EMAIL_USER ? nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
}) : null;

async function sendDailyReport() {
  if (!transporter || !process.env.EMAIL_TO) {
    console.log('Email not configured, skipping report');
    return;
  }

  try {
    const { rows } = await pool.query('SELECT sync_code, data, updated_at FROM progress ORDER BY updated_at DESC');

    if (rows.length === 0) {
      console.log('No users to report on');
      return;
    }

    const now = new Date();
    const daysLeft = Math.max(0, Math.ceil((EXAM_DATE - now) / (1000 * 60 * 60 * 24)));
    const today = now.toISOString().slice(0, 10);

    let html = `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1a73e8,#6c5ce7);color:white;padding:24px;border-radius:12px 12px 0 0">
          <h1 style="margin:0;font-size:24px">German GCSE Daily Report</h1>
          <p style="margin:8px 0 0;opacity:0.9">${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} | ${daysLeft} days until exam</p>
        </div>
        <div style="background:#f8f9fa;padding:20px;border-radius:0 0 12px 12px">
    `;

    for (const row of rows) {
      const data = row.data;
      const userName = row.sync_code;
      const lastActive = new Date(row.updated_at).toLocaleDateString('en-GB');

      // Calculate stats
      const totalCorrect = data.totalCorrect || 0;
      const totalWrong = data.totalWrong || 0;
      const totalAttempted = totalCorrect + totalWrong;
      const accuracy = totalAttempted > 0 ? Math.round(totalCorrect / totalAttempted * 100) : 0;
      const bestStreak = data.bestStreak || 0;

      // Count mastered, struggles, unseen
      let mastered = 0, struggles = 0, unseen = 0, weak = 0;
      const wordStats = data.wordStats || {};
      const totalTracked = Object.keys(wordStats).length;

      for (const key of Object.keys(wordStats)) {
        const s = wordStats[key];
        if (s.correct >= 3) mastered++;
        else if (s.wrong >= 2) struggles++;
        else weak++;
      }
      unseen = TOTAL_WORDS - totalTracked;

      // Today's score
      const todayScore = (data.dailyScores || {})[today] || { correct: 0, wrong: 0 };
      const todayTotal = todayScore.correct + todayScore.wrong;

      // Daily target calculation
      const wordsNeeded = TARGET_WORDS - mastered;
      const daysRemaining = Math.max(1, daysLeft);
      const wordsPerDay = Math.ceil(wordsNeeded / daysRemaining);
      const masteryPct = Math.round(mastered / TOTAL_WORDS * 100);

      // Progress color
      const progressColor = masteryPct >= 80 ? '#34a853' : masteryPct >= 50 ? '#fbbc04' : '#ea4335';

      html += `
        <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h2 style="margin:0;color:#1a73e8;font-size:20px">${userName.charAt(0).toUpperCase() + userName.slice(1)}</h2>
            <span style="color:#666;font-size:13px">Last active: ${lastActive}</span>
          </div>

          <div style="background:#f1f3f4;border-radius:8px;height:12px;margin-bottom:12px;overflow:hidden">
            <div style="background:${progressColor};height:100%;width:${masteryPct}%;border-radius:8px;transition:width 0.5s"></div>
          </div>
          <p style="margin:0 0 16px;font-size:13px;color:#666">${masteryPct}% mastery (${mastered}/${TOTAL_WORDS} words) — needs ${wordsPerDay} words/day to hit 98%</p>

          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>Today</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${todayScore.correct} correct, ${todayScore.wrong} wrong (${todayTotal} total)</td>
            </tr>
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>All Time</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${totalAttempted} attempted, ${accuracy}% accuracy</td>
            </tr>
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>Words Mastered</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:#34a853"><strong>${mastered}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>Struggle Words</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:#ea4335"><strong>${struggles}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>Weak Words</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:#fbbc04"><strong>${weak}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>Unseen Words</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:#1a73e8"><strong>${unseen}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px"><strong>Best Streak</strong></td>
              <td style="padding:8px;text-align:right">${bestStreak}</td>
            </tr>
          </table>
        </div>
      `;
    }

    html += `
        <p style="text-align:center;color:#999;font-size:12px;margin-top:16px">
          German GCSE Trainer — Auto-generated daily report
        </p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `"German GCSE Trainer" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: `German GCSE Progress Report — ${daysLeft} days left`,
      html: html
    });

    console.log('Daily report email sent successfully');
  } catch (err) {
    console.error('Email send error:', err);
  }
}

// Schedule daily email at 8pm UK time (20:00)
cron.schedule('0 20 * * *', () => {
  console.log('Running daily email report...');
  sendDailyReport();
}, { timezone: 'Europe/London' });

// Manual trigger endpoint (for testing)
app.post('/api/send-report', async (req, res) => {
  try {
    await sendDailyReport();
    res.json({ ok: true, message: 'Report sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send report' });
  }
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
