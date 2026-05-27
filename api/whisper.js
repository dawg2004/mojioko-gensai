// Groq Whisper プロキシ - サーバーサイドのAPIキーを使用してCORSなしで文字起こし
// モード1: multipart/form-data → そのままGroqに転送 (fileアップロード)
// モード2: application/json { url, model, language, response_format }
//           → サーバーサイドでURLから音声フェッチ → Groqにfileとして転送

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY_NOT_CONFIGURED' });

  const contentType = req.headers['content-type'] || '';

  try {
    let groqRes;

    if (contentType.includes('application/json')) {
      // ── URL モード: URLから音声フェッチ → Groqにfileとして送信 ──
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { url, model, language, response_format } = body;

      if (!url) return res.status(400).json({ error: 'MISSING_URL' });

      // 音声URLからバイナリを取得
      const audioRes = await fetch(url);
      if (!audioRes.ok) {
        return res.status(502).json({ error: 'FETCH_AUDIO_FAILED', status: audioRes.status });
      }
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // URLのパスから拡張子を取得 (例: .m4a, .mp3)
      let ext = 'mp4';
      try {
        const pathname = new URL(url).pathname;
        const m = pathname.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
        if (m) ext = m[1].toLowerCase();
      } catch (_) {}
      const filename = `audio.${ext}`;

      // Groq用 multipart/form-data を手動構築
      const boundary = `----mojiokoB${Date.now()}`;
      const CRLF = '\r\n';
      const parts = [];

      // file パート
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
        `Content-Type: application/octet-stream${CRLF}${CRLF}`
      ));
      parts.push(audioBuffer);
      parts.push(Buffer.from(CRLF));

      // model パート
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
        `${model || 'whisper-large-v3-turbo'}${CRLF}`
      ));

      // response_format パート
      if (response_format) {
        parts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
          `${response_format}${CRLF}`
        ));
      }

      // language パート
      if (language && language !== 'auto') {
        parts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
          `${language}${CRLF}`
        ));
      }

      parts.push(Buffer.from(`--${boundary}--${CRLF}`));

      const multipartBody = Buffer.concat(parts);

      groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
      });

    } else if (contentType.includes('multipart/form-data')) {
      // ── ファイルモード: multipartをそのままGroqに転送 ──
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks);

      groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': contentType,
        },
        body: rawBody,
      });

    } else {
      return res.status(400).json({ error: 'EXPECTED_MULTIPART_OR_JSON' });
    }

    const respContentType = groqRes.headers.get('content-type') || '';
    if (respContentType.includes('application/json')) {
      const data = await groqRes.json();
      return res.status(groqRes.status).json(data);
    } else {
      const text = await groqRes.text();
      return res.status(groqRes.status).send(text);
    }

  } catch (e) {
    return res.status(502).json({ error: 'PROXY_ERROR', detail: e.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
