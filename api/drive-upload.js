// 文字起こし結果(テキスト)をGoogle Driveの指定フォルダに.txtとして保存する
// OAuth2(読み書き両方のスコープ)を使用

const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/googleAuth');
const { Readable } = require('stream');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    return res.status(400).json({ error: 'INVALID_JSON_BODY' });
  }

  const { filename, content, folderId } = body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'MISSING_FILENAME_OR_CONTENT' });
  }
  if (!folderId) {
    return res.status(400).json({ error: 'MISSING_FOLDER_ID' });
  }

  try {
    const auth = getOAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const safeFilename = filename.endsWith('.txt') ? filename : `${filename}.txt`;

    const result = await drive.files.create({
      requestBody: {
        name: safeFilename,
        parents: [folderId],
        mimeType: 'text/plain',
      },
      media: {
        mimeType: 'text/plain',
        body: Readable.from(Buffer.from(content, 'utf-8')),
      },
      supportsAllDrives: true,
      fields: 'id, name, webViewLink',
    });

    return res.status(200).json({
      id: result.data.id,
      name: result.data.name,
      webViewLink: result.data.webViewLink,
    });
  } catch (e) {
    return res.status(500).json({ error: 'DRIVE_UPLOAD_FAILED', detail: e.message });
  }
};
