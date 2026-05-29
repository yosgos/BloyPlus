import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // חילוץ פרמטר ה-type מהכתובת בצורה בטוחה וחסינת תקלות
  const urlParts = req.url.split('?');
  const params = new URLSearchParams(urlParts[1] || '');
  const type = params.get('type');

  const client = await pool.connect();

  try {
    let query = '';

    // ==========================================================
    // מצב 1: בקשה עבור טופס חתן/כלה (רווקים מעל גיל 18 לפי ה-DB החדש)
    // ==========================================================
    if (type === 'spouse') {
      query = `
        SELECT 
            id, 
            (first_name || ' ' || last_name) AS name 
        FROM family_members 
        WHERE married_to IS NULL 
          AND date_birthday IS NOT NULL
          AND date_birthday <= (CURRENT_DATE - INTERVAL '18 years')::date
        ORDER BY date_birthday ASC
      `;
      
      let response = await client.query(query);
      
      // הגנה: אם הרשימה חזרה ריקה, נשלוף את כל הרווקים ללא סינון גיל
      if (response.rows.length === 0) {
        query = `
          SELECT 
              id, 
              (first_name || ' ' || last_name) AS name 
          FROM family_members 
          WHERE married_to IS NULL
          ORDER BY id ASC
        `;
        response = await client.query(query);
      }
      
      client.release();
      return res.status(200).json(response.rows);
    } 
    
    // ==========================================================
    // מצב 2: בקשה עבור טופס תינוק (הקוד המקורי והמדויק שלך!)
    // ==========================================================
    else {
      query = `
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
    }

  } catch (error) {
    if (client) client.release();
    return res.status(500).json({ error: 'שגיאה בשליפת הרשימה: ' + error.message });
  }
}
