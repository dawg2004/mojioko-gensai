// Google Drive フォルダ内の音声ファイル一覧を取得
// サービスアカウント認証（GOOGLE_SERVICE_ACCOUNT_KEY: JSON鍵をbase64エンコードしたもの）

const { google } = require('googleapis');

function getAuth() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_NOT_CONFIGURED');
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  return new google.auth.GoogleAuth({
    credentials: json,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

const AUDIO_EXT_QUERY = [
  "name contains '.ogg'",
  "name contains '.mp3'",
  "name contains '.m4a'",
  "name contains '.wav'",
  "name contains '.flac'",
  "name contains '.mp4'",
  "mimeType contains 'audio/'",
].join(' or ');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const folderId = req.query.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return res.status(400).json({ error: 'MISSING_FOLDER_ID' });

  try {
    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });

    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (${AUDIO_EXT_QUERY})`,
      orderBy: 'createdTime desc',
      pageSize: 100,
      fields: 'files(id,name,mimeType,createdTime,size)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });

    return res.status(200).json({ files: result.data.files || [] });
  } catch (e) {
    return res.status(500).json({ error: 'DRIVE_LIST_FAILED', detail: e.message });
  }
};
