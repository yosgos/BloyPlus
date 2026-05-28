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

  // הגנה: ודא שהתקבל שם הורה
  if (!son_of) {
    return res.status(400).json({ error: 'חובה לבחור הורה כדי לייצר ID' });
  }

  try {
    const client = await pool.connect();

    // שלב 1: שליפת ה-ID של ההורה לפי השם המלא שלו
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

    const parentId = parentResult.rows[0].id; // למשל: "05.02.00.0"

    // שלב 2: פירוק ה-ID של ההורה כדי למצוא איפה ה-00 הראשון
    const parts = parentId.split('.'); // הופך מערך, למשל: ['05', '02', '00', '0']
    
    let prefix = '';       // החלק הקבוע שנחפש לפיו ילדים
    let replaceIndex = -1; // באיזה מיקום במערך נשתול את המספר החדש

    if (parts[1] === '00') {
      // מקרה א': ה-00 מופיע במקטע השני (הורה הוא למשל 05.00.00.0)
      prefix = parts[0] + '.'; // נחפש ילדים שמתחילים ב-"05."
      replaceIndex = 1;        // נחליף את המקטע השני
    } else if (parts[2] === '00') {
      // מקרה ב': ה-00 מופיע במקטע השלישי (הורה הוא למשל 05.02.00.0)
      prefix = parts[0] + '.' + parts[1] + '.'; // נחפש ילדים שמתחילים ב-"05.02."
      replaceIndex = 2;                         // נחליף את המקטע השלישי
    } else {
      client.release();
      return res.status(400).json({ error: 'לא ניתן לייצר מזהה: להורה הנבחר כבר אין מקטעי 00 פנויים' });
    }

    // שלב 3: ספירת הילדים הקיימים של ההורה הזה
    // מחפשים מי שמתחיל בקידומת של ההורה, אבל ה-ID שלו לא מסתיים ב-1
    const countQuery = `
      SELECT COUNT(*) AS child_count 
      FROM family_members 
      WHERE id LIKE $1 
        AND id NOT LIKE '%1'
        AND split_part(id, '.', $2) != '00'
    `;
   // אנחנו מעבירים גם את ה-replaceIndex + 1 כדי שה-split_part ידע באיזה מקטע לבדוק את ה-00
    const countResult = await client.query(countQuery, [prefix + '%', replaceIndex + 1]);
    const childCount = parseInt(countResult.rows[0].child_count); // עכשיו זה יחזיר בדיוק 4!
    
    // שלב 4: חישוב המספר החדש והפיכתו ל-2 ספרות (סך הילדים + 1)
    const nextChildNumber = childCount + 1;
    const newSegment = String(nextChildNumber).padStart(2, '0'); // הופך את 5 ל-"05"

    // שלב 5: הרכבת ה-ID החדש
    parts[replaceIndex] = newSegment; // משתילים את ה-"05" במקום ה-"00"
    const newId = parts.join('.');    // מחברים חזרה עם נקודות, למשל: "05.02.05.0"

    // שלב 6: הכנסת המשתמש החדש עם ה-ID המחושב
    const insertQuery = `
      INSERT INTO family_members (id, first_name, last_name, full_name, gender, hebrew_date, son_of)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    await client.query(insertQuery, [newId, first_name, last_name, full_name, gender, hebrew_date, son_of]);
    
    client.release();
    return res.status(200).json({ 
      message: `הנתונים נשמרו בהצלחה! הופק מזהה משפחתי חדש: ${newId}` 
    });

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בחישוב המזהה או בשמירה: ' + error.message });
  }
}
