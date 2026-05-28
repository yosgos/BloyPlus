import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'מותר לשלוח רק נתוני טופס (POST)' });
  }

  const { first_name, last_name, full_name, gender, hebrew_date, son_of } = req.body;

  if (!first_name || !last_name || !son_of) {
    return res.status(400).json({ error: 'שם פרטי, שם משפחה ושם הורה הם שדות חובה לצורך חישוב ה-ID!' });
  }

  try {
    const client = await pool.connect();

    // 1. שליפת ה-ID של ההורה
    const parentQuery = `
      SELECT id FROM family_members 
      WHERE (first_name || ' ' || last_name) = $1
      LIMIT 1
    `;
    const parentResult = await client.query(parentQuery, [son_of]);

    if (parentResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: `ההורה ${son_of} לא נמצא במסד הנתונים` });
    }

    const parentId = parentResult.rows[0].id;

    // 2. פירוק ה-ID של ההורה
    const parts = parentId.split('.');
    let prefix = '';
    let replaceIndex = -1;

    if (parts[1] === '00') {
      prefix = parts[0] + '.';
      replaceIndex = 1;
    } else if (parts[2] === '00') {
      prefix = parts[0] + '.' + parts[1] + '.';
      replaceIndex = 2;
    } else {
      client.release();
      return res.status(400).json({ error: 'לא ניתן לייצר מזהה: להורה הנבחר כבר אין מקטעי 00 פנויים' });
    }

    // 3. ספירת הילדים הקיימים (ללא ההורה וללא נשים/בעלים שמסתיימים ב-1)
    const countQuery = `
      SELECT COUNT(*) AS child_count 
      FROM family_members 
      WHERE id LIKE $1 
        AND id NOT LIKE '%1'
        AND split_part(id, '.', $2) != '00'
    `;
    const countResult = await client.query(countQuery, [prefix + '%', replaceIndex + 1]);
    const childCount = parseInt(countResult.rows[0].child_count);

    // 4. הרכבת ה-ID החדש
    const nextChildNumber = childCount + 1;
    const newSegment = String(nextChildNumber).padStart(2, '0');
    parts[replaceIndex] = newSegment;
    const newId = parts.join('.');

    // 5. הכנסת המשתמש החדש לטבלה (שדות ריקים יכנסו כ-NULL בבטחה)
    const insertQuery = `
      INSERT INTO family_members (id, first_name, last_name, full_name, gender, hebrew_date, son_of)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    await client.query(insertQuery, [
      newId, 
      first_name, 
      last_name, 
      full_name || null, 
      gender || null, 
      hebrew_date || null, 
      son_of
    ]);
    
    client.release();
    return res.status(200).json({ 
      message: `הנתונים נשמרו בהצלחה! הופק מזהה משפחתי חדש: ${newId}` 
    });

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בחישוב המזהה או בשמירה: ' + error.message });
  }
}
