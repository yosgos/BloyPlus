import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // כאן אנחנו חייבים POST בשביל להוסיף נתונים!
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'מותר לשלוח רק נתוני טופס (POST)' });
  }

  const { first_name, last_name, full_name, gender, hebrew_date, son_of } = req.body;

  try {
    const client = await pool.connect();
    
    const query = `
      INSERT INTO family_members (first_name, last_name, full_name, gender, hebrew_date, son_of)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    
    await client.query(query, [first_name, last_name, full_name, gender, hebrew_date, son_of]);
    
    client.release();
    return res.status(200).json({ message: 'הבן/בת משפחה נשמרו בהצלחה ב-Neon!' });

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בבסיס הנתונים: ' + error.message });
  }
}
