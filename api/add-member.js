import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { first_name, last_name, full_name, gender, hebrew_date, son_of } = req.body;
  const client = await pool.connect();

  try {
    // 1. שליפת נתוני ההורה הביולוגי (תמיד מסתיים ב-0)
    const parentQuery = `
      SELECT id, gender, mothers_name, full_name 
      FROM family_members 
      WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
    `;
    const parentData = await client.query(parentQuery, [son_of]);

    if (parentData.rows.length === 0) throw new Error("הורה לא נמצא");
    
    const parent = parentData.rows[0];
    const parts = parent.id.split('.');
    
    // --- א. חישוב דור ומיקום ה-ID החדש ---
    let replaceIndex = -1;
    let generation = 0;

    if (parts[1] === '00') {
      replaceIndex = 1;
      generation = 2;
    } else if (parts[2] === '00') {
      replaceIndex = 2;
      generation = 3;
    } else {
      replaceIndex = 3; 
      generation = 4;
    }

    // --- ב. יצירת ה-ID החדש (ספירת ילדים) ---
    const prefix = parts.slice(0, replaceIndex).join('.') + '.';
    const countRes = await client.query(
      `SELECT COUNT(*) FROM family_members WHERE id LIKE $1 AND id NOT LIKE '%1' AND split_part(id, '.', $2) != '00'`,
      [prefix + '%', replaceIndex + 1]
    );
    
    const childCount = parseInt(countRes.rows[0].count);
    let newId;
    if (generation < 4) {
      newId = prefix + String(childCount + 1).padStart(2, '0') + '.0';
    } else {
      newId = prefix + String(childCount + 1);
    }

    // --- ג. חישוב שם לתפילה (מי האמא?) ---
    let motherName = null;
    const connectWord = gender === 'נ' ? 'בת' : 'בן';

    if (parent.gender === 'נ') {
      // ההורה הביולוגי הוא אישה -> היא האמא
      motherName = parent.full_name || (parent.first_name + ' ' + parent.last_name);
    } else {
      // ההורה הביולוגי הוא גבר -> האמא היא בת הזוג שלו (אותו ID עם 1 בסוף)
      const wifeId = parent.id.toString().slice(0, -1) + '1';
      const wifeData = await client.query(`SELECT full_name FROM family_members WHERE id = $1`, [wifeId]);
      
      if (wifeData.rows.length > 0) {
        motherName = wifeData.rows[0].full_name;
      } else {
        // גיבוי: עמודת mothers_name של האבא
        motherName = parent.mothers_name || null;
      }
    }

    const prayerName = motherName 
      ? `${full_name || (first_name + ' ' + last_name)} ${connectWord} ${motherName}`
      : `${full_name || (first_name + ' ' + last_name)} ${connectWord} [חסר שם האם]`;

    // --- ד. המרת תאריך עברי ללועזי ---
    let gregorianDate = null;
    if (hebrew_date) {
      const dateRes = await client.query(
        `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
        [hebrew_date]
      );
      if (dateRes.rows.length > 0) {
        gregorianDate = dateRes.rows[0].gregorian_date;
      }
    }

    // --- ה. שמירה סופית ל-Neon ---
    const insertQuery = `
      INSERT INTO family_members 
      (id, first_name, last_name, full_name, gender, hebrew_date, son_of, generation, full_name_for_prayers, date_birthday)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await client.query(insertQuery, [
      newId, first_name, last_name, full_name, gender, hebrew_date, son_of, 
      generation, prayerName, gregorianDate
    ]);

    client.release();
    res.status(200).json({ 
      message: `נשמר בהצלחה! מזהה: ${newId}, דור: ${generation}, שם לתפילה: ${prayerName}` 
    });

  } catch (error) {
    if (client) client.release();
    res.status(500).json({ error: error.message });
  }
}
