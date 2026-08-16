// Google Drive の音声ファイルをサーバー側でサービスアカウント認証してダウンロードし、
// そのままブラウザにストリーム転送する（ブラウザ側にはGoogle認証情報を渡さない）

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const fileId = req.query.fileId;
  if (!fileId) return res.status(400).json({ error: 'MISSING_FILE_ID' });

  try {
    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });

    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size', supportsAllDrives: true });
    const { name, mimeType } = meta.data;

    const fileRes = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name || 'audio')}"`);

    fileRes.data
      .on('error', (err) => {
        if (!res.headersSent) {
          res.status(502).json({ error: 'DRIVE_STREAM_ERROR', detail: err.message });
        } else {
          res.end();
        }
      })
      .pipe(res);
  } catch (e) {
    return res.status(500).json({ error: 'DRIVE_DOWNLOAD_FAILED', detail: e.message });
  }
};

module.exports.config = {
  api: {
    responseLimit: false,
  },
};
