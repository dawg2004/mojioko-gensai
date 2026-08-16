// Google Drive の音声ファイルをサーバー側でOAuth2認証してダウンロードし、
// そのままブラウザにストリーム転送する（ブラウザ側にはGoogle認証情報を渡さない）
// ※サービスアカウントキーは組織ポリシーでブロックされているため使用不可

const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/googleAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const fileId = req.query.fileId;
  if (!fileId) return res.status(400).json({ error: 'MISSING_FILE_ID' });

  try {
    const auth = getOAuthClient();
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
