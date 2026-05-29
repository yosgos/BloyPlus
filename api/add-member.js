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

    if (parentData.rows.length === 0) throw new Error("הורה לא נמצא במסד הנתונים");
    
    const parent = parentData.rows[0];
    const parentIdStr = parent.id.toString();
    const parentParts = parentIdStr.split('.');
    
    // --- א. חישוב ה-ID החדש ---
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

    // --- ב. חישוב דור לפי ה-ID של הילד החדש ---
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

    // --- ג. חישוב שם לתפילה ---
    let motherName = null;
    const connectWord = gender === 'נ' ? 'בת' : 'בן';

    if (parent.gender === 'נ') {
      motherName = parent.full_name || (parent.first_name + ' ' + parent.last_name);
    } else {
      const wifeId = parentIdStr.slice(0, -1) + '1';
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

    // --- ד. המרת תאריך עברי ללועזי ---
    let gregorianDate = null;
    if (hebrew_date) {
      const dateRes = await client.query(
        `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
        [hebrew_date]
      );
      if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
    }

    // --- ה. שליפת שם הענף והכתובת מטבלת branches ---
    const familyId = parentIdStr.substring(0, 5); // 5 תווים ראשונים של ההורה (למשל "05.00" או "03.05")
    let branchName = null;
    let branchAddress = null;

    const branchRes = await client.query(
      `SELECT name_branch, address FROM "branches" WHERE "Family_id" = $1 LIMIT 1`,
      [familyId]
    );

    if (branchRes.rows.length > 0) {
      branchName = branchRes.rows[0].name_branch;
      branchAddress = branchRes.rows[0].address;
    }

    // --- ו. שמירה סופית לטבלה הראשית ---
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
