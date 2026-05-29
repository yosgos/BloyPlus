import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { 
    member_type, first_name, last_name, full_name, gender, 
    hebrew_date, son_of, mothers_name, maiden_name 
  } = req.body;

  const client = await pool.connect();

  try {
    // הגדרת שם תצוגה נקי: שם פרטי + שם משפחה (למשל: יוסי גושן)
    const displayNameNewMember = `${first_name} ${last_name}`;
    const connectWord = gender === 'נ' ? 'בת' : 'בן';

    // התחלת טרנזקציה
    await client.query('BEGIN');

    // ==========================================
    // לוגיקה א': הוספת חתן או כלה (Spouse)
    // ==========================================
    if (member_type === 'spouse') {
      // 1. שליפת הנתונים של בן המשפחה הביולוגי
      const biologicalQuery = `
        SELECT id, first_name, last_name, generation, branch, address 
        FROM family_members 
        WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
      `;
      const biologicalData = await client.query(biologicalQuery, [son_of]);
      if (biologicalData.rows.length === 0) throw new Error("בן/בת הזוג הביולוגי לא נמצאו במערכת");

      const bioPerson = biologicalData.rows[0];
      // שם תצוגה של הביולוגי (שם פרטי + משפחה)
      const displayNameBio = `${bioPerson.first_name} ${bioPerson.last_name}`; 
      
      // יצירת ה-ID החדש למצטרף (ספרת ביקורת 1)
      const bioIdStr = bioPerson.id.toString();
      const newSpouseId = bioIdStr.slice(0, -1) + '1';

      // בניית שם לתפילה מבוסס על ה-full_name (שם הקודש) אם קיים, ואם לא על השם הפרטי
      const nameForPrayer = full_name || first_name;
      const prayerName = mothers_name 
        ? `${nameForPrayer} ${connectWord} ${mothers_name}`
        : `${nameForPrayer} ${connectWord} [חסר שם האם]`;

      // המרת תאריך עברי ללועזי
      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(
          `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
          [hebrew_date]
        );
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      // פעולה 1: הכנסת המצטרף החדש (married_to מקבל את השם הפרטי+משפחה של הביולוגי)
      const insertSpouseQuery = `
        INSERT INTO family_members 
        (id, first_name, last_name, full_name, gender, hebrew_date, married_to, generation, full_name_for_prayers, date_birthday, branch, address, maiden_name_for_brides, mothers_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `;
      await client.query(insertSpouseQuery, [
        newSpouseId, first_name, last_name, full_name, gender, hebrew_date, displayNameBio,
        bioPerson.generation, prayerName, gregorianDate, bioPerson.branch, bioPerson.address,
        gender === 'נ' ? maiden_name : null, mothers_name
      ]);

      // פעולה 2: עדכון בן המשפחה הביולוגי (married_to מקבל שם פרטי+משפחה של המצטרף)
      const updateBiologicalQuery = `
        UPDATE family_members 
        SET married_to = $1 
        WHERE id = $2
      `;
      await client.query(updateBiologicalQuery, [displayNameNewMember, bioPerson.id]);

      // פעולה 3: פתיחת ענף חדש בטבלת בראנצעז עם כתובת ריקה (NULL)
      const newFamilyId = bioIdStr.substring(0, 5); 
      const newBranchName = `הענף של ${displayNameBio}`;

      // בדיקה אם ה-Family_id כבר קיים (מונע קריסה למקרה שהאינדקס הייחודי עדיין לא הוגדר)
      const branchCheck = await client.query('SELECT 1 FROM branches WHERE "Family_id" = $1 LIMIT 1', [newFamilyId]);
      if (branchCheck.rows.length === 0) {
        const insertBranchQuery = `
          INSERT INTO branches ("Family_id", name_branch, address)
          VALUES ($1, $2, NULL)
        `;
        await client.query(insertBranchQuery, [newFamilyId, newBranchName]);
      }

    // ==========================================
    // לוגיקה ב': הוספת ילד/תינוק
    // ==========================================
    } else {
      const parentQuery = `
        SELECT id, gender, mothers_name, full_name, first_name, last_name 
        FROM family_members 
        WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
      `;
      const parentData = await client.query(parentQuery, [son_of]);
      if (parentData.rows.length === 0) throw new Error("הורה לא נמצא במסד הנתונים");
      
      const parent = parentData.rows[0];
      const parentIdStr = parent.id.toString();
      const parentParts = parentIdStr.split('.');
      
      let replaceIndex = parentParts[1] === '00' ? 1 : (parentParts[2] === '00' ? 2 : 3);

      const prefix = parentParts.slice(0, replaceIndex).join('.') + '.';
      const countRes = await client.query(
        `SELECT COUNT(*) FROM family_members WHERE id LIKE $1 AND id NOT LIKE '%1' AND split_part(id, '.', $2) != '00'`,
        [prefix + '%', replaceIndex + 1]
      );
      
      const childCount = parseInt(countRes.rows[0].count);
      const nextSegment = String(childCount + 1).padStart(2, '0');

      let newId;
      if (replaceIndex === 1) {
        newId = `${parentParts[0]}.${nextSegment}.00.0`;
      } else if (replaceIndex === 2) {
        newId = `${parentParts[0]}.${parentParts[1]}.${nextSegment}.0`;
      } else {
        newId = `${parentParts[0]}.${parentParts[1]}.${parentParts[2]}.${nextSegment}.0`;
      }

      const childParts = newId.split('.');
      let generation = 4;
      if (childParts[1] === '00') generation = 2;
      else if (childParts[2] === '00') generation = 3;

      let motherName = null;
      if (parent.gender === 'נ') {
        motherName = parent.full_name || parent.first_name;
      } else {
        const wifeId = parentIdStr.slice(0, -1) + '1';
        const wifeData = await client.query(`SELECT full_name, first_name FROM family_members WHERE id = $1`, [wifeId]);
        if (wifeData.rows.length > 0) {
          motherName = wifeData.rows[0].full_name || wifeData.rows[0].first_name;
        } else {
          motherName = parent.mothers_name || null;
        }
      }

      const nameForPrayer = full_name || first_name;
      const prayerName = motherName 
        ? `${nameForPrayer} ${connectWord} ${motherName}`
        : `${nameForPrayer} ${connectWord} [חסר שם האם]`;

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
        newId, first_name, last_name, full_name, gender, hebrew_date, son_of, 
        generation, prayerName, gregorianDate, branchName, branchAddress
      ]);
    }

    await client.query('COMMIT');
    client.release();
    res.status(200).json({ message: "מזל טוב! הטופס נשלח בהצלחה, הענף החדש נפתח והנשואים עודכנו." });

  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    res.status(500).json({ error: error.message });
  }
}
