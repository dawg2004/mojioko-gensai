// バックグラウンド文字起こしジョブ
//
// ブラウザ側のJS実行に依存せず、サーバー側(この関数)だけで
// 「Driveからダウンロード → 音声を大きめのセグメントに分割(ffmpeg, ストリームコピーで高速)
//   → Groq Whisperで順次文字起こし → 結果をDriveに.txtとして自動保存」
// まで完結させる。
//
// スマホでこのエンドポイントを叩いた後、画面をロックしてもこの処理自体は
// Vercelのサーバー上で継続する(クライアントの接続状態に依存しない)。
// 結果はDriveに自動保存されるので、後からDriveを確認すればよい。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const ffmpegPath = require('ffmpeg-static');
const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/googleAuth');

// このVercel関数のタイムアウト内(余裕を見て)で収める時間予算
const TIME_BUDGET_MS = 50000;
// 1セグメントの長さ(秒)。ストリームコピーなので長くしても速度は落ちない。
// 大きめにすることでセグメント数(=Groq呼び出し回数)を大幅に減らし、
// 全体の処理時間と失敗リスクを下げる。
const SEGMENT_SECONDS = 480; // 8分
const GROQ_MAX_RETRIES = 4;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function downloadToFile(drive, fileId, destPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
}

function segmentAudio(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    const pattern = path.join(outDir, 'seg_%04d.ts');
    const ff = spawn(ffmpegPath, [
      '-y',
      '-i', inputPath,
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-reset_timestamps', '1',
      '-c', 'copy',
      pattern,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg segment failed (code ${code}): ${stderr.slice(-500)}`));
    });
  });
}

async function transcribeSegmentWithRetry(apiKey, filePath, lang) {
  for (let attempt = 1; attempt <= GROQ_MAX_RETRIES; attempt++) {
    try {
      const form = new FormData();
      const buf = fs.readFileSync(filePath);
      form.append('file', new Blob([buf]), path.basename(filePath));
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'text');
      if (lang && lang !== 'auto') form.append('language', lang);

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!res.ok) {
        const raw = await res.text();
        throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
      }
      return await res.text();
    } catch (e) {
      if (attempt === GROQ_MAX_RETRIES) throw e;
      await sleep(4000 * attempt);
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const startedAt = Date.now();
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY_NOT_CONFIGURED' });

  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    return res.status(400).json({ error: 'INVALID_JSON_BODY' });
  }

  const { fileId, fileName, saveFolderId, lang } = body;
  if (!fileId || !saveFolderId) {
    return res.status(400).json({ error: 'MISSING_FILEID_OR_SAVEFOLDERID' });
  }

  const workDir = path.join(os.tmpdir(), `mojioko-${crypto.randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath = path.join(workDir, 'input');

  try {
    const auth = getOAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // 1. Driveからダウンロード
    await downloadToFile(drive, fileId, inputPath);

    // 2. ffmpegでセグメント分割(ストリームコピーなので高速・音質劣化なし)
    await segmentAudio(inputPath, workDir);
    const segments = fs.readdirSync(workDir)
      .filter((f) => f.startsWith('seg_'))
      .sort();

    if (!segments.length) {
      throw new Error('NO_SEGMENTS_PRODUCED');
    }

    // 3. 各セグメントを順番に文字起こし(時間予算内で)
    let combinedText = '';
    let processedCount = 0;
    let ranOutOfTime = false;

    for (const segFile of segments) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }
      const segPath = path.join(workDir, segFile);
      const text = await transcribeSegmentWithRetry(groqKey, segPath, lang);
      combinedText += (combinedText ? '\n' : '') + text.trim();
      processedCount++;
      fs.unlinkSync(segPath); // 使い終わったら即削除してディスク節約
    }

    // 4. 結果をDriveに保存
    const baseName = (fileName || `transcription_${Date.now()}`).replace(/\.[^/.]+$/, '');
    const suffix = ranOutOfTime ? `_partial_${processedCount}of${segments.length}` : '';
    const outName = `${baseName}${suffix}.txt`;

    const uploadResult = await drive.files.create({
      requestBody: { name: outName, parents: [saveFolderId], mimeType: 'text/plain' },
      media: { mimeType: 'text/plain', body: Readable.from(Buffer.from(combinedText, 'utf-8')) },
      supportsAllDrives: true,
      fields: 'id, name, webViewLink',
    });

    return res.status(200).json({
      status: ranOutOfTime ? 'partial' : 'done',
      processedSegments: processedCount,
      totalSegments: segments.length,
      savedFile: uploadResult.data,
      charCount: combinedText.length,
    });
  } catch (e) {
    return res.status(500).json({ error: 'JOB_FAILED', detail: e.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
