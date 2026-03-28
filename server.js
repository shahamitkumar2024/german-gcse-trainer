const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize table
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

// Get progress
app.get('/api/progress/:code', async (req, res) => {
  try {
    const code = req.params.code.toLowerCase().trim();
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
    const code = req.params.code.toLowerCase().trim();
    const data = req.body;
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

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
