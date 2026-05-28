import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const client = await pool.connect();
    
    // שאילתה עם מיון מתוחכם לפי דורות ומקטעי ה-ID
    const query = `
      SELECT 
          id, 
          (first_name || ' ' || last_name) AS name 
      FROM family_members 
      WHERE married_to IS NOT NULL 
        AND id LIKE '%0'
        AND id NOT LIKE '00%'
      ORDER BY 
          -- 1. מיון לפי דור: קודם כל מי שהמקטע השני שלו הוא '00' (למעלה), ואז השאר
          CASE WHEN split_part(id, '.', 2) = '00' THEN 1 ELSE 2 END ASC,
          -- 2. מיון פנימי לפי חלקי ה-ID (כדי ש-01 יבוא לפני 02)
          split_part(id, '.', 1) ASC,
          split_part(id, '.', 2) ASC,
          split_part(id, '.', 3) ASC
    `;
    
    const response = await client.query(query);
    client.release();
    
    return res.status(200).json(response.rows);

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בשליפת ההורים: ' + error.message });
  }
}
