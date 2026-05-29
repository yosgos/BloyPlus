// ==========================================
// לוגיקה א': הוספת חתן או כלה (Spouse)
// ==========================================
if (member_type === 'spouse') {
  // 1. שליפת הנתונים של בן המשפחה הביולוגי ישירות לפי ה-ID שלו!
  const biologicalQuery = `
    SELECT id, first_name, last_name, generation, branch, address 
    FROM family_members 
    WHERE id = $1 LIMIT 1
  `;
  // בשדה son_of מגיע עכשיו ה-ID שנבחר מהטופס
  const biologicalData = await client.query(biologicalQuery, [son_of]);
  if (biologicalData.rows.length === 0) throw new Error("בן/בת הזוג הביולוגי לא נמצאו במערכת");

  const bioPerson = biologicalData.rows[0];
  const displayNameBio = `${bioPerson.first_name} ${bioPerson.last_name}`; 
  
  const bioIdStr = bioPerson.id.toString();
  const newSpouseId = bioIdStr.slice(0, -1) + '1';

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

  // פעולה 1: הכנסת המצטרף החדש
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

  // פעולה 2: עדכון בן המשפחה הביולוגי לפי ה-ID שלו
  const updateBiologicalQuery = `
    UPDATE family_members 
    SET married_to = $1 
    WHERE id = $2
  `;
  await client.query(updateBiologicalQuery, [displayNameNewMember, bioPerson.id]);

  // פעולה 3: פתיחת ענף חדש
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
  // 1. שליפת הנתונים של ההורה ישירות לפי ה-ID שלו!
  const parentQuery = `
    SELECT id, gender, mothers_name, full_name, first_name, last_name 
    FROM family_members 
    WHERE id = $1 LIMIT 1
  `;
  const parentData = await client.query(parentQuery, [son_of]);
  if (parentData.rows.length === 0) throw new Error("הורה לא נמצא במסד הנתונים");
  
  const parent = parentData.rows[0];
  const parentIdStr = parent.id.toString();
  
  // [שאר קוד חישוב ה-ID של הילד, יצירת ה-ID, השמות לתפילה וההכנסה נשארים בדיוק אותו דבר...]
