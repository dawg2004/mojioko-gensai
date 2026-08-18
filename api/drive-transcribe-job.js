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
//
// 重要: Vercelの実行時間上限(60秒)は「猶予なく強制終了」される。
// そのため、最後にまとめて1回だけDriveに書き込む方式だと、上限到達の
// タイミング次第で「何も保存されない」ことが起こり得る。
// これを防ぐため、1セグメント処理が終わるたびに都度Driveへ書き込み
// (追記更新)していく。途中で強制終了されても、それまでの分は必ず残る。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const ffmpegPath = require('ffmpeg-static');
const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/googleAuth');

// このVercel関数のタイムアウト(60秒・強制終了)に対して、
// Drive書き込み等の後処理の時間も見込んでかなり手前で打ち切る
const TIME_BUDGET_MS = 35000;
// 1セグメントの長さ(秒)。ストリームコピーなので長くしても速度は落ちない。
// ただし1セグメントの処理自体が長すぎると、その処理中に60秒の強制終了に
// 引っかかるリスクが上がるため、程よい長さに留める。
const SEGMENT_SECONDS = 300; // 5分
const GROQ_MAX_RETRIES = 2;

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

// Drive上の結果ファイルをupsert(無ければ作成、あれば上書き更新)する。
// fileIdをキャッシュして、同一ジョブ内での2回目以降はupdateを使う。
async function upsertResultFile(drive, state, folderId, name, text) {
  const media = { mimeType: 'text/plain', body: Readable.from(Buffer.from(text, 'utf-8')) };
  if (state.driveFileId) {
    await drive.files.update({ fileId: state.driveFileId, media, supportsAllDrives: true });
    if (state.currentName !== name) {
      await drive.files.update({ fileId: state.driveFileId, requestBody: { name }, supportsAllDrives: true });
      state.currentName = name;
    }
  } else {
    const created = await drive.files.create({
      requestBody: { name, parents: [folderId], mimeType: 'text/plain' },
      media,
      supportsAllDrives: true,
      fields: 'id, name, webViewLink',
    });
    state.driveFileId = created.data.id;
    state.webViewLink = created.data.webViewLink;
    state.currentName = name;
  }
}

// 進行中(または完了済み)の結果ファイルをDrive上で探し、あれば
// これまでのテキストと再開位置(resumeIndex)を返す。
// ファイル名パターン: {baseName}_進行中_{N}of{M}.txt / {baseName}.txt(完了)
async function findExistingProgress(drive, folderId, baseName) {
  const escaped = baseName.replace(/'/g, "\\'");
  const result = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and (name = '${escaped}.txt' or name contains '${escaped}_進行中_')`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = result.data.files || [];
  if (!files.length) return null;

  // 完了ファイルがあればそれで確定(再処理不要)
  const done = files.find((f) => f.name === `${baseName}.txt`);
  const target = done || files[0];

  const content = await drive.files.get(
    { fileId: target.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  const text = typeof content.data === 'string' ? content.data : '';

  if (done) {
    return { driveFileId: target.id, currentName: target.name, combinedText: text, resumeIndex: null, isDone: true };
  }
  const m = target.name.match(/_進行中_(\d+)of(\d+)\.txt$/);
  const resumeIndex = m ? parseInt(m[1], 10) : 0;
  return { driveFileId: target.id, currentName: target.name, combinedText: text, resumeIndex, isDone: false };
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
  const baseName = (fileName || `transcription_${Date.now()}`).replace(/\.[^/.]+$/, '');
  const driveState = {}; // upsertResultFileが使う状態(fileId等)を保持

  try {
    const auth = getOAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // 0. 既に進行中/完了済みの結果ファイルがないか確認(あれば続きから再開)
    const existing = await findExistingProgress(drive, saveFolderId, baseName);
    if (existing && existing.isDone) {
      return res.status(200).json({
        status: 'done',
        alreadyCompleted: true,
        savedFile: { id: existing.driveFileId, name: existing.currentName },
        charCount: existing.combinedText.length,
      });
    }
    if (existing) {
      driveState.driveFileId = existing.driveFileId;
      driveState.currentName = existing.currentName;
    }

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

    // 3. 各セグメントを順番に文字起こし → 1件終わるたびにDriveへ都度保存
    //    (前回の続きがあれば resumeIndex から再開し、再処理を避ける)
    let combinedText = existing ? existing.combinedText : '';
    let processedCount = existing ? existing.resumeIndex : 0;
    let ranOutOfTime = false;

    for (let i = processedCount; i < segments.length; i++) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }
      const segPath = path.join(workDir, segments[i]);
      const text = await transcribeSegmentWithRetry(groqKey, segPath, lang);
      combinedText += (combinedText ? '\n' : '') + text.trim();
      processedCount++;
      fs.unlinkSync(segPath); // 使い終わったら即削除してディスク節約

      // ここで都度Driveに書き込む(強制終了されてもここまでの分は残る)
      const inProgress = processedCount < segments.length;
      const nameNow = inProgress
        ? `${baseName}_進行中_${processedCount}of${segments.length}.txt`
        : `${baseName}.txt`;
      await upsertResultFile(drive, driveState, saveFolderId, nameNow, combinedText);
    }

    if (Date.now() - startedAt > TIME_BUDGET_MS && processedCount < segments.length) {
      ranOutOfTime = true;
    }

    // 全部終わっていて「進行中」の名前のままなら最終名にリネーム済みのはず(ループ内で対応済み)
    return res.status(200).json({
      status: ranOutOfTime ? 'partial' : 'done',
      processedSegments: processedCount,
      totalSegments: segments.length,
      savedFile: { id: driveState.driveFileId, name: driveState.currentName, webViewLink: driveState.webViewLink },
      charCount: combinedText.length,
    });
  } catch (e) {
    // 失敗時も、それまでに何か処理できていればDriveには残っているはず
    return res.status(500).json({
      error: 'JOB_FAILED',
      detail: e.message,
      partialSavedFile: driveState.driveFileId
        ? { id: driveState.driveFileId, name: driveState.currentName }
        : null,
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
