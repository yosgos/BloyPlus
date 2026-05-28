import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // כאן אנחנו מאפשרים רק בקשת GET (שליפת נתונים)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const client = await pool.connect();
    
    // השאילתה שמסננת רק הורים רלוונטיים (נשואים, ID נגמר ב-0, ולא מתחיל ב-00)
    const query = `
      SELECT 
          id, 
          (first_name || ' ' || last_name) AS name 
      FROM family_members 
      WHERE married_to IS NOT NULL 
        AND id LIKE '%0'
        AND id NOT LIKE '00%'
    `;
    
    const response = await client.query(query);
    client.release();
    
    // מחזירים את השורות שחזרו כ-JSON לדפדפן
    return res.status(200).json(response.rows);

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בשליפת ההורים: ' + error.message });
  }
}
