import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = await pool.connect();

  try {
    const {
      member_type,
      first_name,
      last_name,
      full_name,
      gender,
      hebrew_date,
      son_of, // מכיל את ה-ID של בן הזוג או של ההורה
      mothers_name,
      maiden_name
    } = req.body;

    // ולידציה בסיסית
    if (!last_name || !gender || !son_of) {
      return res.status(400).json({ error: 'שדות חובה חסרים (שם משפחה, מין, או בחירת קשר)' });
    }

    await client.query('BEGIN');

    // מילת קישור לתפילה
    const connectWord = gender === 'נ' ? 'בת' : 'בן';
    const displayNameNewMember = `${first_name} ${last_name}`.trim();

    // ==========================================
    // לוגיקה א': הוספת חתן או כלה (Spouse)
    // ==========================================
    if (member_type === 'spouse') {
      // שליפת הנתונים של בן המשפחה הביולוגי לפי ה-ID שלו
      const biologicalQuery = `
        SELECT id, first_name, last_name, generation, branch, address 
        FROM family_members 
        WHERE id = $1 LIMIT 1
      `;
      const biologicalData = await client.query(biologicalQuery, [son_of]);
      if (biologicalData.rows.length === 0) throw new Error("בן/בת הזוג הביולוגי לא נמצאו במערכת");

      const bioPerson = biologicalData.rows[0];
      const displayNameBio = `${bioPerson.first_name} ${bioPerson.last_name}`; 
      
      const bioIdStr = bioPerson.id.toString();
      const newSpouseId = bioIdStr.slice(0, -1) + '1'; // הפיכת הספרה האחרונה ל-1 עבור בן זוג

      const nameForPrayer = full_name || first_name;
      const prayerName = mothers_name 
        ? `${nameForPrayer} ${connectWord} ${mothers_name}`
        : `${nameForPrayer} ${connectWord} [חסר שם האם]`;

      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(
          `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
          [hebrew_date]
        );
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      // 1. הכנסת המצטרף החדש
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

      // 2. עדכון בן המשפחה הביולוגי (רישום נשואים)
      const updateBiologicalQuery = `
        UPDATE family_members 
        SET married_to = $1 
        WHERE id = $2
      `;
      await client.query(updateBiologicalQuery, [displayNameNewMember, bioPerson.id]);

      // 3. פתיחת ענף חדש אם לא קיים
      const newFamilyId = bioIdStr.substring(0, 5); 
      const newBranchName = `הענף של ${displayNameBio}`;

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
      // 1. שליפת הנתונים של האבא לפי ה-ID שלו
      const parentQuery = `
        SELECT id, gender, mothers_name, full_name, first_name, last_name, generation, branch, address
        FROM family_members 
        WHERE id = $1 LIMIT 1
      `;
      const parentData = await client.query(parentQuery, [son_of]);
      if (parentData.rows.length === 0) throw new Error("הורה לא נמצא במסד הנתונים");
      
      const parent = parentData.rows[0];
      const parentIdStr = parent.id.toString();
      
      // שליפת האמא (בת הזוג של האבא) כדי לקבל את שם האם לתפילה
      const motherQuery = `
        SELECT first_name FROM family_members WHERE married_to = $1 AND gender = 'נ' LIMIT 1
      `;
      const motherData = await client.query(motherQuery, [`${parent.first_name} ${parent.last_name}`]);
      const motherNameFromDb = motherData.rows.length > 0 ? motherData.rows[0].first_name : "[חסר שם האם]";

      // יצירת מזהה (ID) רץ עבור הילד החדש בתוך המשפחה הזו
      const prefix = parentIdStr.substring(0, 5); // חמש הספרות של הענף
      const childrenQuery = `
        SELECT id FROM family_members 
        WHERE id LIKE $1 AND id LIKE '%.0'
      `;
      const childrenData = await client.query(childrenQuery, [`${prefix}.%`]);
      
      let maxChildNum = 0;
      childrenData.rows.forEach(row => {
        const parts = row.id.split('.');
        const childNum = parseInt(parts[2], 10); // החלק השלישי במזהה XX.XX.YY.0
        if (childNum > maxChildNum) maxChildNum = childNum;
      });

      const nextChildNum = (maxChildNum + 1).toString().padStart(2, '0');
      const newChildId = `${prefix}.${nextChildNum}.0`; // מזהה סופי לילד ביולוגי רווק

      // בניית שמות ברירת מחדל אם התינוק נולד ועוד לא קיבל שם
      const finalFirstName = first_name || (gender === 'ז' ? 'תינוק' : 'תינוקת');
      const finalFullName = full_name || (gender === 'ז' ? `הבן של ${parent.first_name}` : `הבת של ${parent.first_name}`);

      const prayerName = `${finalFirstName} ${connectWord} ${motherNameFromDb}`;

      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(
          `SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`,
          [hebrew_date]
        );
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      const insertChildQuery = `
        INSERT INTO family_members 
        (id, first_name, last_name, full_name, gender, hebrew_date, generation, full_name_for_prayers, date_birthday, branch, address)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `;
      await client.query(insertChildQuery, [
        newChildId, finalFirstName, last_name, finalFullName, gender, hebrew_date,
        parent.generation + 1, prayerName, gregorianDate, parent.branch, parent.address
      ]);
    }

    await client.query('COMMIT');
    return res.status(200).json({ message: 'החבר החדש התווסף למסד הנתונים בהצלחה!' });

  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
}
