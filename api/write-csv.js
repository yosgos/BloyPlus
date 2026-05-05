import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    const TOKEN = process.env.GITHUB_TOKEN;
    const REPO_NAME = 'bloy-plus-cs4o'; // שם ה-Repository שלך
    const REPO_OWNER = 'yossigoshen';   // שם המשתמש שלך ב-GitHub
    const FILE_PATH = 'Master.csv';

    if (!TOKEN) return res.status(500).json({ error: "Missing GITHUB_TOKEN" });

    const octokit = new Octokit({ auth: TOKEN });

    try {
        // קריאת הנתונים מהבקשה
        const { firstName, lastName } = req.body;
        if (!firstName || !lastName) throw new Error("נתונים חסרים");

        // בניית השורה (שם פרטי, שם משפחה + 18 פסיקים לעמודות הריקות)
        const newRow = `\n${firstName},${lastName},,,,,,,,,,,,,,,,,,`;

        // 1. משיכת הקובץ הקיים
        const { data: fileData } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: FILE_PATH,
        });

        const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');

        // 2. עדכון הקובץ
        await octokit.repos.createOrUpdateFileContents({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: FILE_PATH,
            message: `Add ${firstName} ${lastName}`,
            content: Buffer.from(currentContent + newRow, 'utf-8').toString('base64'),
            sha: fileData.sha,
        });

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
