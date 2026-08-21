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

// Groqが受け付ける拡張子: flac mp3 mp4 mpeg mpga m4a ogg opus wav webm
// 元ファイルの拡張子がこの中にあればそのまま使う(同じコンテナ族なので
// ストリームコピーで安全)。無ければogg(このNPOの主な音源形式)にフォールバック。
const GROQ_ACCEPTED_EXT = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm']);
function pickSegmentExt(fileName) {
  const m = (fileName || '').match(/\.([a-zA-Z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : '';
  return GROQ_ACCEPTED_EXT.has(ext) ? ext : 'ogg';
}

function segmentAudio(inputPath, outDir, segExt) {
  return new Promise((resolve, reject) => {
    // Groqが受け付けるフォーマットに含まれる拡張子にする必要がある
    // (.tsのような非対応拡張子だと"invalid_request_error"で弾かれる)
    const pattern = path.join(outDir, `seg_%04d.${segExt}`);
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

function toHMS(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ファイル名から日付らしき部分を抽出する(Plaudの "YYYY-MM-DD HH_MM_SS.ogg" 形式を想定)
function extractDateFromFileName(fileName) {
  const m = (fileName || '').match(/(\d{4}-\d{2}-\d{2})[ _](\d{2})[_:](\d{2})[_:](\d{2})/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
  const dateOnly = (fileName || '').match(/\d{4}-\d{2}-\d{2}/);
  return dateOnly ? dateOnly[0] : null;
}

async function transcribeSegmentWithRetry(apiKey, filePath, lang, withTimestamp, timeOffsetSec) {
  for (let attempt = 1; attempt <= GROQ_MAX_RETRIES; attempt++) {
    try {
      const form = new FormData();
      const buf = fs.readFileSync(filePath);
      form.append('file', new Blob([buf]), path.basename(filePath));
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', withTimestamp ? 'verbose_json' : 'text');
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

      if (!withTimestamp) return await res.text();

      const json = await res.json();
      const segs = json.segments || [];
      if (!segs.length) return json.text || '';
      return segs.map((s) => `[${toHMS(s.start + timeOffsetSec)}]  ${s.text.trim()}`).join('\n');
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 進行状況の確認のみ(ジョブは開始しない、Drive上の進行中ファイルを覗くだけ)
  if (req.method === 'GET') {
    const { fileName, saveFolderId } = req.query;
    if (!fileName || !saveFolderId) {
      return res.status(400).json({ error: 'MISSING_FILENAME_OR_SAVEFOLDERID' });
    }
    try {
      const auth = getOAuthClient();
      const drive = google.drive({ version: 'v3', auth });
      const baseName = fileName.replace(/\.[^/.]+$/, '');
      const existing = await findExistingProgress(drive, saveFolderId, baseName);
      if (!existing) return res.status(200).json({ status: 'not_started' });
      if (existing.isDone) {
        return res.status(200).json({ status: 'done', charCount: existing.combinedText.length });
      }
      const m = existing.currentName.match(/_進行中_(\d+)of(\d+)\.txt$/);
      return res.status(200).json({
        status: 'in_progress',
        processedSegments: m ? parseInt(m[1], 10) : null,
        totalSegments: m ? parseInt(m[2], 10) : null,
        charCount: existing.combinedText.length,
      });
    } catch (e) {
      return res.status(500).json({ error: 'STATUS_CHECK_FAILED', detail: e.message });
    }
  }

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

  const { fileId, fileName, saveFolderId, lang, format } = body;
  const withTimestamp = format === 'timestamp';
  const forceRedo = !!body.forceRedo; // 既に完了済みでも、フォーマット変更などでゼロから作り直したい場合に指定
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
    //    forceRedo指定時は出力フォーマット変更などのため完全にゼロから作り直す
    const existing = forceRedo ? null : await findExistingProgress(drive, saveFolderId, baseName);
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
    } else if (forceRedo) {
      // forceRedo時、既存の進行中/完了ファイル(旧フォーマット)があれば
      // 上書き対象として掴んでおく(無ければ新規作成になる)
      const oldFile = await findExistingProgress(drive, saveFolderId, baseName);
      if (oldFile) {
        driveState.driveFileId = oldFile.driveFileId;
        driveState.currentName = oldFile.currentName;
      }
    }

    // 1. Driveからダウンロード
    await downloadToFile(drive, fileId, inputPath);

    // 2. ffmpegでセグメント分割(ストリームコピーなので高速・音質劣化なし)
    await segmentAudio(inputPath, workDir, pickSegmentExt(fileName));
    const segments = fs.readdirSync(workDir)
      .filter((f) => f.startsWith('seg_'))
      .sort();

    if (!segments.length) {
      throw new Error('NO_SEGMENTS_PRODUCED');
    }

    // 3. 各セグメントを順番に文字起こし → 1件終わるたびにDriveへ都度保存
    //    (前回の続きがあれば resumeIndex から再開し、再処理を避ける)
    let combinedText;
    if (existing) {
      combinedText = existing.combinedText;
    } else {
      const dateStr = extractDateFromFileName(fileName);
      combinedText = `【ファイル】${fileName}${dateStr ? `\n【日時】${dateStr}` : ''}\n${'─'.repeat(40)}\n`;
    }
    let processedCount = existing ? existing.resumeIndex : 0;
    let ranOutOfTime = false;

    for (let i = processedCount; i < segments.length; i++) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }
      const segPath = path.join(workDir, segments[i]);
      const timeOffsetSec = i * SEGMENT_SECONDS;
      const text = await transcribeSegmentWithRetry(groqKey, segPath, lang, withTimestamp, timeOffsetSec);
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
