import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // קבלת הלוגים או מחיקת לוג ספציפי
  const client = await pool.connect();

  try {
    // 1. אם זו בקשת GET - נחזיר את רשימת הלוגים האחרונים לתצוגה במסך
    if (req.method === 'GET') {
      const { rows } = await pool.query(`SELECT id, action_type, description, affected_ids, created_at FROM action_logs ORDER BY id DESC LIMIT 10`);
      return res.status(200).json(rows);
    }

    // 2. אם זו בקשת POST - מבצעים מחיקה וביטול (Undo)
    if (req.method === 'POST') {
      const { log_id } = req.body;
      if (!log_id) return res.status(400).json({ error: 'חסר מזהה פעולה' });

      await client.query('BEGIN');

      // שליפת נתוני הלוג כדי לדעת מה למחוק
      const logRes = await client.query(`SELECT affected_ids FROM action_logs WHERE id = $1`, [log_id]);
      if (logRes.rows.length === 0) throw new Error("הפעולה כבר בוטלה או לא קיימת");

      const { inserted_member_id, updated_bio_id, inserted_branch_id } = logRes.rows[0].affected_ids;

      // א. מחיקת החבר שהתווסף (חתן/כלה/תינוק)
      if (inserted_member_id) {
        await client.query(`DELETE FROM family_members WHERE id = $1`, [inserted_member_id]);
      }

      // ב. החזרת בן הזוג הביולוגי לסטטוס רווק (מחיקת השם שלו מהשורה)
      if (updated_bio_id) {
        await client.query(`UPDATE family_members SET married_to = NULL WHERE id = $1`, [updated_bio_id]);
      }

      // ג. מחיקת הענף שנפתח
      if (inserted_branch_id) {
        await client.query(`DELETE FROM branches WHERE "Family_id" = $1`, [inserted_branch_id]);
      }

      // ד. מחיקת שורת הלוג עצמה מההיסטוריה
      await client.query(`DELETE FROM action_logs WHERE id = $1`, [log_id]);

      await client.query('COMMIT');
      return res.status(200).json({ message: 'הפעולה בוטלה בהצלחה וכל השינויים נמחקו מה-DB!' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
}
