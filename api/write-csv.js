import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // כאן אתה מגדיר לאיזה קובץ לכתוב - שנה את filename.csv לשם הקובץ שלך
  const FILE_PATH = 'Master.csv'; 
  const REPO_NAME = process.env.VERCEL_GIT_REPO_SLUG;
  const REPO_OWNER = process.env.VERCEL_GIT_REPO_OWNER;
  const TOKEN = process.env.GITHUB_TOKEN;

  const octokit = new Octokit({ auth: TOKEN });

  try {
    const { name, value } = JSON.parse(req.body);
    const newRow = `\n${name},${value}`;

    // 1. קבלת תוכן הקובץ הקיים
    const { data: fileData } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
    });

    const content = Buffer.from(fileData.content, 'base64').toString();
    const updatedContent = content + newRow;

    // 2. עדכון הקובץ בגיטהאב
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      message: 'עדכון נתונים מהאתר',
      content: Buffer.from(updatedContent).toString('base64'),
      sha: fileData.sha,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
