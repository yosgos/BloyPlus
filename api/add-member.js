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
    // 1. שליפת נתוני ההורה הביולוגי
    const parentQuery = `
      SELECT id, gender, mothers_name, full_name 
      FROM family_members 
      WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
    `;
    const parentData = await client.query(parentQuery, [son_of]);

    if (parentData.rows.length === 0) throw new Error("הורה לא נמצא");
    
    const parent = parentData.rows[0];
    const parentParts = parent.id.split('.');
    
    // --- א. גזירת קוד הענף מתוך תז ההורה (5 תווים ראשונים) ---
    const branchCode = parent.id.substring(0, 5); // תופס למשל "05.00" או "03.05"

    // שליפת שם הענף והכתובת מטבלת branches
    const branchQuery = `
      SELECT name_branch, address 
      FROM "branches" 
      WHERE branch_code = $1 LIMIT 1
    `;
    const branchData = await client.query(branchQuery, [branchCode]);
    
    // אם הענף לא נמצא בטבלה, נשים ערכי null כדי שהקוד לא יקרוס
    const branchName = branchData.rows.length > 0 ? branchData.rows[0].name_branch : null;
    const branchAddress = branchData.rows.length > 0 ? branchData.rows[0].address : null;

    // --- ב. חישוב ה-ID החדש של הילד ---
    let replaceIndex = -1;
    if (parentParts[1] === '00') {
      replaceIndex = 1;
    } else if (parentParts[2] === '00') {
      replaceIndex = 2;
    } else {
      replaceIndex = 3; 
    }

    const prefix = parentParts.slice(0, replaceIndex).join('.') + '.';
    const countRes = await client.query(
      `SELECT COUNT(*) FROM family_members WHERE id LIKE $1 AND id NOT LIKE '%1' AND split_part(id, '.', $2) != '00'`,
      [prefix + '%', replaceIndex + 1]
    );
    
    const childCount = parseInt(countRes.rows[0].count);
    let newId;
    if (replaceIndex < 3) {
      newId = prefix + String(childCount + 1).padStart(2, '0') + '.0';
    } else {
      newId = prefix + String(childCount + 1);
    }

    // --- ג. חישוב דור לפי ה-ID של הילד ---
    const childParts = newId.split('.');
    let generation = 0;
    if (childParts[0] === '00') {
      generation = 1;
    } else if (childParts[1] === '00') {
      generation = 2;
    } else if (childParts[2] === '00') {
      generation = 3;
    } else {
      generation = 4;
    }

    // --- ד. חישוב שם לתפילה ---
    let motherName = null;
    const connectWord = gender === 'נ' ? 'בת' : 'בן';

    if (parent.gender === 'נ') {
      motherName = parent.full_name || (parent.first_name + ' ' + parent.last_name);
    } else {
      const wifeId = parent.id.toString().slice(0, -1) + '1';
      const wifeData = await client.query(`SELECT full_name FROM family_members WHERE id = $1`, [wifeId]);
      if (wifeData.rows.length > 0) {
        motherName = wifeData.rows[0].full_name;
      } else {
        motherName = parent.mothers_name || null;
      }
    }

    const nameForHeader = full_name || (first_name + ' ' + last_name);
    const prayerName = motherName 
      ? `${nameForHeader} ${connectWord} ${motherName}`
      : `${nameForHeader} ${connectWord} [חסר שם האם]`;

    // --- ה. המרת תאריך עברי ללועזי ---
    let gregorianDate = null;
    if (hebrew_date) {
      const dateRes = await client.query(
        `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
        [hebrew_date]
      );
      if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
    }

    // --- ו. שמירה סופית ל-Neon (כולל הענף והכתובת שנשאבו) ---
    // הנחתי ששמות העמודות בטבלת חברי המשפחה הן גם name_branch ו-address, שנה אותן ב-INSERT אם הן נקראות אחרת
    const insertQuery = `
      INSERT INTO family_members 
      (id, first_name, last_name, full_name, gender, hebrew_date, son_of, generation, full_name_for_prayers, date_birthday, name_branch, address)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;

    await client.query(insertQuery, [
      newId, first_name, last_name, full_name, gender, hebrew_date, son_of, 
      generation, prayerName, gregorianDate, branchName, branchAddress
    ]);

    client.release();
    res.status(200).json({ message: "מזל טוב! הטופס נשלח בהצלחה" });

  } catch (error) {
    if (client) client.release();
    res.status(500).json({ error: error.message });
  }
}
