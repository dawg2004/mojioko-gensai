// アプリの状態(文字起こし履歴・処理済みファイル記録)をlocalStorageではなく
// Google Drive上のJSONファイルに保存する。
// iOSのホーム画面PWAはlocalStorageが端末側の事情で消去されることがあるため、
// Driveをソース・オブ・トゥルースにすることで消失を防ぐ(副次的にMacとスマホ間でも共有される)。

const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/googleAuth');
const { Readable } = require('stream');

const STATE_FILENAME = '_mojioko_app_state.json';

async function findStateFile(drive, folderId) {
  const result = await drive.files.list({
    q: `'${folderId}' in parents and name = '${STATE_FILENAME}' and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return result.data.files?.[0] || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const folderId = req.method === 'GET' ? req.query.folderId : null;

  try {
    const auth = getOAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    if (req.method === 'GET') {
      if (!folderId) return res.status(400).json({ error: 'MISSING_FOLDER_ID' });
      const existing = await findStateFile(drive, folderId);
      if (!existing) {
        return res.status(200).json({ history: [], processedFiles: {} });
      }
      const content = await drive.files.get(
        { fileId: existing.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'text' }
      );
      let parsed;
      try {
        parsed = typeof content.data === 'string' ? JSON.parse(content.data) : content.data;
      } catch (e) {
        parsed = { history: [], processedFiles: {} };
      }
      return res.status(200).json(parsed);
    }

    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch (e) {
        return res.status(400).json({ error: 'INVALID_JSON_BODY' });
      }
      const { folderId: bodyFolderId, state } = body;
      if (!bodyFolderId || !state) return res.status(400).json({ error: 'MISSING_FOLDERID_OR_STATE' });

      const existing = await findStateFile(drive, bodyFolderId);
      const media = { mimeType: 'application/json', body: Readable.from(Buffer.from(JSON.stringify(state), 'utf-8')) };

      if (existing) {
        await drive.files.update({ fileId: existing.id, media, supportsAllDrives: true });
      } else {
        await drive.files.create({
          requestBody: { name: STATE_FILENAME, parents: [bodyFolderId], mimeType: 'application/json' },
          media,
          supportsAllDrives: true,
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  } catch (e) {
    return res.status(500).json({ error: 'APP_STATE_FAILED', detail: e.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
