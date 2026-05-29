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
    const nameForHeader = full_name || (first_name + ' ' + last_name);
    const connectWord = gender === 'נ' ? 'בת' : 'בן';

    // התחלת טרנזקציה כדי לוודא שכל הפעולות מצליחות ביחד
    await client.query('BEGIN');

    // ==========================================
    // לוגיקה א': הוספת חתן או כלה (Spouse) + עדכון נשואים ופתיחת ענף
    // ==========================================
    if (member_type === 'spouse') {
      // 1. שליפת הנתונים של בן המשפחה הביולוגי (זה שנמצא בתוך son_of)
      const biologicalQuery = `
        SELECT id, first_name, last_name, full_name, generation, branch, address 
        FROM family_members 
        WHERE (first_name || ' ' || last_name) = $1 LIMIT 1
      `;
      const biologicalData = await client.query(biologicalQuery, [son_of]);
      if (biologicalData.rows.length === 0) throw new Error("בן/בת הזוג הביולוגי לא נמצאו במערכת");

      const bioPerson = biologicalData.rows[0];
      const bioName = bioPerson.full_name || (bioPerson.first_name + ' ' + bioPerson.last_name);
      
      // יצירת ה-ID החדש למצטרף (החלפת הספרה האחרונה מ-0 ל-1)
      const bioIdStr = bioPerson.id.toString();
      const newSpouseId = bioIdStr.slice(0, -1) + '1';

      // שם לתפילה עבור המצטרף החדש
      const prayerName = mothers_name 
        ? `${nameForHeader} ${connectWord} ${mothers_name}`
        : `${nameForHeader} ${connectWord} [חסר שם האם]`;

      // המרת תאריך עברי ללועזי
      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(
          `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
          [hebrew_date]
        );
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      // פעולה 1: הכנסת החתן/כלה החדשים לטבלה (השדה married_to שלהם מקבל את שם הביולוגי)
      const insertSpouseQuery = `
        INSERT INTO family_members 
        (id, first_name, last_name, full_name, gender, hebrew_date, married_to, generation, full_name_for_prayers, date_birthday, branch, address, maiden_name_for_brides, mothers_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `;
      await client.query(insertSpouseQuery, [
        newSpouseId, first_name, last_name, full_name, gender, hebrew_date, bioName,
        bioPerson.generation, prayerName, gregorianDate, bioPerson.branch, bioPerson.address,
        gender === 'נ' ? maiden_name : null, mothers_name
      ]);

      // פעולה 2: עדכון בן המשפחה הביולוגי – מעכשיו הוא נשוי למצטרף החדש!
      const updateBiologicalQuery = `
        UPDATE family_members 
        SET married_to = $1 
        WHERE id = $2
      `;
      await client.query(updateBiologicalQuery, [nameForHeader, bioPerson.id]);

      // פעולה 3: פתיחת ענף חדש בטבלת בראנצעז (branches)
      // גזירת ה-Family_id מתוך ה-ID של הביולוגי (5 תווים ראשונים, למשל "04.01")
      const newFamilyId = bioIdStr.substring(0, 5); 
      const newBranchName = `הענף של ${bioName}`;

      const insertBranchQuery = `
        INSERT INTO branches ("Family_id", name_branch, address)
        VALUES ($1, $2, $3)
        ON CONFLICT ("Family_id") DO NOTHING
      `;
      await client.query(insertBranchQuery, [newFamilyId, newBranchName, bioPerson.address]);

    // ==========================================
    // לוגיקה ב': הוספת ילד/תינוק (נשארה ללא שינוי)
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
        newId, first_name, last_name, full_name, gender, hebrew_date, son_of, 
        generation, prayerName, gregorianDate, branchName, branchAddress
      ]);
    }

    // אישור הטרנזקציה ושמירת כל השינויים יחד
    await client.query('COMMIT');
    client.release();
    res.status(200).json({ message: "מזל טוב! הטופס נשלח בהצלחה, ובן הזוג והענף עודכנו." });

  } catch (error) {
    // אם משהו נכשל, נבצע ביטול (Rollback) כדי שלא יישארו חצאי נתונים ב-DB
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    res.status(500).json({ error: error.message });
  }
}
