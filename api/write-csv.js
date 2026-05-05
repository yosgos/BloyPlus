import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  // בדיקה שהמתודה היא POST
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const FILE_PATH = 'Master.csv'; 
  
  // הגדרה ידנית במקרה שוורסל לא מושך את המשתנים האלו אוטומטית
  const REPO_NAME = process.env.VERCEL_GIT_REPO_SLUG || 'bloy-plus-cs4o'; // שם הפרויקט שלך
  const REPO_OWNER = process.env.VERCEL_GIT_REPO_OWNER || 'yossigoshen'; // שם המשתמש שלך בגיטהאב
  const TOKEN = process.env.GITHUB_TOKEN;

  if (!TOKEN) {
    return res.status(500).json({ error: "GITHUB_TOKEN is missing in Environment Variables" });
  }

  const octokit = new Octokit({ auth: TOKEN });

  try {
    const { firstName, lastName } = req.body;
    
    if (!firstName || !lastName) {
       return res.status(400).json({ error: "נא למלא שם ומשפחה" });
    }

    const newRow = `\n${firstName},${lastName},,,,,,,,,,,,,,,,,,`;

    // 1. קבלת תוכן הקובץ הקיים
    const { data: fileData } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
    });

    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
    const updatedContent = content + newRow;

    // 2. עדכון הקובץ בגיטהאב
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      message: `הוספת ${firstName} ${lastName} למאגר`,
      content: Buffer.from(updatedContent, 'utf-8').toString('base64'),
      sha: fileData.sha,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "שגיאת שרת: " + error.message });
  }
}
