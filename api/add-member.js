import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const client = await pool.connect();

  try {
    const { member_type, first_name, last_name, full_name, gender, hebrew_date, son_of, mothers_name, maiden_name } = req.body;
    if (!last_name || !gender || !son_of) return res.status(400).json({ error: 'שדות חובה חסרים' });

    await client.query('BEGIN');
    const connectWord = gender === 'נ' ? 'בת' : 'בן';
    const displayNameNewMember = `${first_name} ${last_name}`.trim();

    let affected_ids = {};
    let logDescription = '';

    // ==========================================
    // לוגיקה א': הוספת חתן או כלה (Spouse)
    // ==========================================
    if (member_type === 'spouse') {
      const biologicalData = await client.query(`SELECT id, first_name, last_name, generation, branch, address FROM family_members WHERE id = $1 LIMIT 1`, [son_of]);
      if (biologicalData.rows.length === 0) throw new Error("בן/בת הזוג הביולוגי לא נמצאו");

      const bioPerson = biologicalData.rows[0];
      const displayNameBio = `${bioPerson.first_name} ${bioPerson.last_name}`; 
      const bioIdStr = bioPerson.id.toString();
      const newSpouseId = bioIdStr.slice(0, -1) + '1';

      const nameForPrayer = full_name || first_name;
      const prayerName = mothers_name ? `${nameForPrayer} ${connectWord} ${mothers_name}` : `${nameForPrayer} ${connectWord} [חסר שם האם]`;

      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(`SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`, [hebrew_date]);
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      // 1. הכנסת מצטרף
      await client.query(`INSERT INTO family_members (id, first_name, last_name, full_name, gender, hebrew_date, married_to, generation, full_name_for_prayers, date_birthday, branch, address, maiden_name_for_brides, mothers_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, 
        [newSpouseId, first_name, last_name, full_name, gender, hebrew_date, displayNameBio, bioPerson.generation, prayerName, gregorianDate, bioPerson.branch, bioPerson.address, gender === 'נ' ? maiden_name : null, mothers_name]);

      // 2. עדכון בן זוג ביולוגי
      await client.query(`UPDATE family_members SET married_to = $1 WHERE id = $2`, [displayNameNewMember, bioPerson.id]);

      // 3. פתיחת ענף
      const newFamilyId = bioIdStr.substring(0, 5); 
      const newBranchName = `הענף של ${displayNameBio}`;
      let branchCreated = false;

      const branchCheck = await client.query('SELECT 1 FROM branches WHERE "Family_id" = $1 LIMIT 1', [newFamilyId]);
      if (branchCheck.rows.length === 0) {
        await client.query(`INSERT INTO branches ("Family_id", name_branch, address) VALUES ($1, $2, NULL)`, [newFamilyId, newBranchName]);
        branchCreated = true;
      }

      // איסוף מזהים לתיעוד בלוג
      affected_ids = {
        inserted_member_id: newSpouseId,
        updated_bio_id: bioPerson.id,
        inserted_branch_id: branchCreated ? newFamilyId : null
      };
      logDescription = `הוספת חתן/כלה: ${displayNameNewMember} נישא ל-${displayNameBio}`;

    // ==========================================
    // לוגיקה ב': הוספת ילד/תינוק
    // ==========================================
    } else {
      const parentData = await client.query(`SELECT id, gender, mothers_name, full_name, first_name, last_name, generation, branch, address FROM family_members WHERE id = $1 LIMIT 1`, [son_of]);
      if (parentData.rows.length === 0) throw new Error("הורה לא נמצא");
      
      const parent = parentData.rows[0];
      const parentIdStr = parent.id.toString();
      
      const motherData = await client.query(`SELECT first_name FROM family_members WHERE married_to = $1 AND gender = 'נ' LIMIT 1`, [`${parent.first_name} ${parent.last_name}`]);
      const motherNameFromDb = motherData.rows.length > 0 ? motherData.rows[0].first_name : "[חסר שם האם]";

      const prefix = parentIdStr.substring(0, 5);
      const childrenData = await client.query(`SELECT id FROM family_members WHERE id LIKE $1 AND id LIKE '%.0'`, [`${prefix}.%`]);
      
      let maxChildNum = 0;
      childrenData.rows.forEach(row => {
        const parts = row.id.split('.');
        const childNum = parseInt(parts[2], 10);
        if (childNum > maxChildNum) maxChildNum = childNum;
      });

      const nextChildNum = (maxChildNum + 1).toString().padStart(2, '0');
      const newChildId = `${prefix}.${nextChildNum}.0`;

      const finalFirstName = first_name || (gender === 'ז' ? 'תינוק' : 'תינוקת');
      const finalFullName = full_name || (gender === 'ז' ? `הבן של ${parent.first_name}` : `הבת של ${parent.first_name}`);
      const prayerName = `${finalFirstName} ${connectWord} ${motherNameFromDb}`;

      let gregorianDate = null;
      if (hebrew_date) {
        const dateRes = await client.query(`SELECT gregorian_date FROM heb_date WHERE hebrew_date = $1 LIMIT 1`, [hebrew_date]);
        if (dateRes.rows.length > 0) gregorianDate = dateRes.rows[0].gregorian_date;
      }

      await client.query(`INSERT INTO family_members (id, first_name, last_name, full_name, gender, hebrew_date, generation, full_name_for_prayers, date_birthday, branch, address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, 
        [newChildId, finalFirstName, last_name, finalFullName, gender, hebrew_date, parent.generation + 1, prayerName, gregorianDate, parent.branch, parent.address]);

      affected_ids = { inserted_member_id: newChildId };
      logDescription = `הוספת צאצא: ${finalFirstName} ${last_name} (${finalFullName})`;
    }

    // 🌟 כתיבת פירורי הלחם לטבלת הלוגים
    await client.query(
      `INSERT INTO action_logs (action_type, description, affected_ids) VALUES ($1, $2, $3)`,
      [member_type, logDescription, JSON.stringify(affected_ids)]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'הנתונים נשמרו והפעולה תועדה בהצלחה!' });

  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
}
