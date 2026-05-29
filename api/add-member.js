import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { 
    member_type, first_name, last_name, full_name, gender, 
    hebrew_date, related_person, mothers_name, maiden_name 
  } = req.body;

  const client = await pool.connect();

  try {
    const nameForHeader = full_name || (first_name + ' ' + last_name);
    const connectWord = gender === 'נ' ? 'בת' : 'בן';

    // ==========================================
    // לוגיקה א': הוספת חתן או כלה (Spouse)
    // ==========================================
    if (member_type === 'spouse') {
      const spouseQuery = `
        SELECT id, generation, branch, address 
        FROM family_members 
        WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
      `;
      const spouseData = await client.query(spouseQuery, [related_person]);
      if (spouseData.rows.length === 0) throw new Error("בן/בת הזוג לא נמצאו במערכת");

      const spouse = spouseData.rows[0];
      
      // החלפת ספרת הביקורת האחרונה מ-0 ל-1 (תמיד עובד, בכל הדורות!)
      const spouseIdStr = spouse.id.toString();
      const newId = spouseIdStr.slice(0, -1) + '1';

      const prayerName = mothers_name 
        ? `${nameForHeader} ${connectWord} ${mothers_name}`
        : `${nameForHeader} ${connectWord} [חסר שם האם]`;

      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(
          `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
          [hebrew_date]
        );
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      const insertSpouseQuery = `
        INSERT INTO family_members 
        (id, first_name, last_name, full_name, gender, hebrew_date, married_to, generation, full_name_for_prayers, date_birthday, branch, address, maiden_name_for_brides, mothers_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `;

      await client.query(insertSpouseQuery, [
        newId, first_name, last_name, full_name, gender, hebrew_date, related_person,
        spouse.generation, prayerName, gregorianDate, spouse.branch, spouse.address,
        gender === 'נ' ? maiden_name : null, mothers_name
      ]);

    // ==========================================
    // לוגיקה ב': הוספת ילד/תינוק
    // ==========================================
    } else {
      const parentQuery = `
        SELECT id, gender, mothers_name, full_name 
        FROM family_members 
        WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
      `;
      const parentData = await client.query(parentQuery, [related_person]);
      if (parentData.rows.length === 0) throw new Error("הורה לא נמצא במסד הנתונים");
      
      const parent = parentData.rows[0];
      const parentIdStr = parent.id.toString();
      const parentParts = parentIdStr.split('.');
      
      // זיהוי המקטע שצריך להשתנות לפי ה-00 של ההורה
      let replaceIndex = parentParts[1] === '00' ? 1 : (parentParts[2] === '00' ? 2 : 3);

      const prefix = parentParts.slice(0, replaceIndex).join('.') + '.';
      const countRes = await client.query(
        `SELECT COUNT(*) FROM family_members WHERE id LIKE $1 AND id NOT LIKE '%1' AND split_part(id, '.', $2) != '00'`,
        [prefix + '%', replaceIndex + 1]
      );
      
      const childCount = parseInt(countRes.rows[0].count);
      const nextSegment = String(childCount + 1).padStart(2, '0');

      // בניית ה-ID החדש - ספרת הביקורת האחרונה היא תמיד 0 לילד ביולוגי!
      let newId;
      if (replaceIndex === 1) {
        // דור 2: ההורה 04.00.00.0 -> הילד 04.01.00.0
        newId = `${parentParts[0]}.${nextSegment}.00.0`;
      } else if (replaceIndex === 2) {
        // דור 3: ההורה 04.01.00.0 -> הילד 04.01.01.0
        newId = `${parentParts[0]}.${parentParts[1]}.${nextSegment}.0`;
      } else {
        // דור 4: ההורה 04.01.01.0 -> הילד 04.01.01.05.0 (5 תתי מקטעים הכרחיים למבנה המלא של דור 4)
        newId = `${parentParts[0]}.${parentParts[1]}.${parentParts[2]}.${nextSegment}.0`;
      }

      // חישוב דור לפי ה-ID של הילד החדש
      const childParts = newId.split('.');
      let generation = 4; // ברירת מחדל לדור 4 (אם אין 00)
      if (childParts[1] === '00') generation = 2;
      else if (childParts[2] === '00') generation = 3;

      let motherName = null;
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

      const prayerName = motherName 
        ? `${nameForHeader} ${connectWord} ${motherName}`
        : `${nameForHeader} ${connectWord} [חסר שם האם]`;

      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(
          `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
          [hebrew_date]
        );
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      const familyId = parentIdStr.substring(0, 5);
      let branchName = null;
      let branchAddress = null;

      const branchRes = await client.query(
        `SELECT name_branch, address FROM branches WHERE "Family_id" = $1 LIMIT 1`,
        [familyId]
      );
      if (branchRes.rows.length > 0) {
        branchName = branchRes.rows[0].name_branch;
        branchAddress = branchRes.rows[0].address;
      }

      const insertQuery = `
        INSERT INTO family_members 
        (id, first_name, last_name, full_name, gender, hebrew_date, son_of, generation, full_name_for_prayers, date_birthday, branch, address)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `;

      await client.query(insertQuery, [
        newId, first_name, last_name, full_name, gender, hebrew_date, related_person, 
        generation, prayerName, gregorianDate, branchName, branchAddress
      ]);
    }

    client.release();
    res.status(200).json({ message: "מזל טוב! הטופס נשלח בהצלחה" });

  } catch (error) {
    if (client) client.release();
    res.status(500).json({ error: error.message });
  }
}
