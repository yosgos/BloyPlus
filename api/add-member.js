// 1. אנחנו מייבאים את הכלי שמתחבר ל-PostgreSQL (מותקן ע"י npm install pg)
import { Pool } from 'pg';

// 2. יוצרים את החיבור באמצעות המשתנה DATABASE_URL שהגדרת קודם בוורסל
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // חובה בנאון בשביל אבטחה
});

export default async function handler(req, res) {
  // אבטחה: אנחנו מאפשרים רק שליחת נתונים (POST). אם מישהו סתם ינסה להיכנס לקישור, הוא ייחסם
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'מותר לשלוח רק נתוני טופס' });
  }

  // 3. לוקחים את הנתונים שהמשתמש הקליד בטופס
  const { first_name, last_name, id, generation, address } = req.body;

  try {
    // פותחים חיבור זמני לנאון
    const client = await pool.connect();
    
    // 4. פקודת ה-SQL שכוללת הגנה מפני הזרקות קוד (SQL Injection) ע"י שימוש ב-$1, $2 וכו'
    const query = `
      INSERT INTO family_members (first_name, last_name, id, generation, address)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    // ממירים את הדור למספר, ואם אין – שמים ערך ריק (NULL)
    const genValue = generation ? parseInt(generation) : null;

    // מריצים את הפקודה עם הערכים האמיתיים
    await client.query(query, [first_name, last_name, id, genValue, address]);
    
    // סוגרים את החיבור ומחזירים תשובת הצלחה לדפדפן
    client.release();
    return res.status(200).json({ message: 'הנתונים נשמרו בהצלחה ב-Neon!' });

  } catch (error) {
    // אם משהו השתבש (למשל ה-ID כבר קיים או שיש שגיאת כתיב), נחזיר את השגיאה
    return res.status(500).json({ error: 'שגיאה בבסיס הנתונים: ' + error.message });
  }
}
