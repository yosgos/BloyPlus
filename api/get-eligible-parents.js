import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // קבלת סוג הבקשה מה-URL (למשל: /api/get-eligible-parents?type=spouse)
  const { type } = req.query;
  const client = await pool.connect();

  try {
    let query = '';

    // ==========================================================
    // מצב 1: בקשה עבור טופס חתן/כלה (רק רווקים, מעל גיל 18, לפי גיל)
    // ==========================================================
    if (type === 'spouse') {
      query = `
        SELECT 
            id, 
            (first_name || ' ' || last_name) AS name 
        FROM family_members 
        WHERE married_to IS NULL 
          AND date_birthday IS NOT NULL
          AND date_birthday <= CURRENT_DATE - INTERVAL '18 years'
        ORDER BY date_birthday ASC
      `;
    } 
    // ==========================================================
    // מצב 2: בקשה עבור טופס תינוק (הקוד המקורי והמתוחכם שלך!)
    // ==========================================================
    else {
      query = `
        SELECT 
            id, 
            (first_name || ' ' || last_name) AS name 
        FROM family_members 
        WHERE married_to IS NOT NULL 
      `;
    }
    
    const response = await client.query(query);
    client.release();
    
    return res.status(200).json(response.rows);

  } catch (error) {
    if (client) client.release();
    return res.status(500).json({ error: 'שגיאה בשליפת הרשימה: ' + error.message });
  }
}
