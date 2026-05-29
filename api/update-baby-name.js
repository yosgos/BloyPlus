import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // טיפול בבקשות מסוג CORS (אם צריך גישה ממקורות שונים)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const client = await pool.connect();

  try {
    // 1. בקשת GET: שליפת כל התינוקות ששמם הוא "תינוק", "תינוקת" או ריק
    if (req.method === 'GET') {
      const queryText = `
        SELECT id, first_name, last_name, full_name, gender 
        FROM family_members 
        WHERE first_name IS NULL 
           OR first_name = '' 
           OR first_name = 'תינוק' 
           OR first_name = 'תינוקת'
        ORDER BY id DESC
      `;
      const { rows } = await client.query(queryText);
      
      // מיפוי הנתונים לתצוגה נוחה ב-Select של ה-HTML שלך
      const formattedBabies = rows.map(baby => ({
        id: baby.id,
        display_label: `${baby.first_name || 'תינוק/ת'} של משפחת ${baby.last_name} (${baby.full_name || 'ללא שם מלא'}) - מזהה: ${baby.id}`
      }));

      return res.status(200).json(formattedBabies);
    }

    // 2. בקשת POST: עדכון השם הרשמי שנקבע
    if (req.method === 'POST') {
      const { baby_id, new_first_name, new_full_name } = req.body;
      if (!baby_id || !new_first_name) {
        return res.status(400).json({ error: 'שדות חובה חסרים לעדכון' });
      }

      await client.query('BEGIN');

      // שליפת נתוני התינוק הקיימים כדי לעדכן גם את השם לתפילה בצורה נכונה
      const babyRes = await client.query(`SELECT gender, mothers_name FROM family_members WHERE id = $1 LIMIT 1`, [baby_id]);
      if (babyRes.rows.length === 0) throw new Error("התינוק לא נמצא במערכת");
      
      const baby = babyRes.rows[0];
      const connectWord = baby.gender === 'נ' ? 'בת' : 'בן';
      
      // בניית שם חדש לתפילה המבוסס על השם הפרטי הרשמי החדש
      const prayerName = baby.mothers_name 
        ? `${new_first_name} ${connectWord} ${baby.mothers_name}`
        : `${new_first_name} ${connectWord} [חסר שם האם]`;

      // עדכון ה-DB בשם הפרטי, השם המלא החדש והשם לתפילה
      await client.query(
        `UPDATE family_members 
         SET first_name = $1, full_name = $2, full_name_for_prayers = $3 
         WHERE id = $4`,
        [new_first_name, new_full_name || null, prayerName, baby_id]
      );

      await client.query('COMMIT');
      return res.status(200).json({ message: 'שם התינוק/ת עודכן במערכת בהצלחה!' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
}
