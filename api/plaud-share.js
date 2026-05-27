// PLAUD共有リンク → 音声presigned URL解決プロキシ
// エンドポイント確認済み: GET /share/access/{shareToken}/audio
// → {"status":0, "temp_url":"https://...s3...ogg?..."}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const { shareUrl, plaudApiBase } = req.body || {};

  if (!shareUrl) {
    return res.status(400).json({ error: 'MISSING_SHARE_URL' });
  }

  // 共有URLからshareTokenを抽出
  // https://web.plaud.ai/s/pub_UUID::KEY → pub_UUID::KEY
  const match = shareUrl.match(/\/(?:s|nshare)\/(pub_[^?#]+)/);
  const shareToken = match && match[1];
  if (!shareToken) {
    return res.status(400).json({ error: 'INVALID_SHARE_URL' });
  }

  const base = (plaudApiBase || 'https://api-apne1.plaud.ai').replace(/\/$/, '');
  if (!base.match(/^https:\/\/[a-z0-9-]+\.plaud\.ai/)) {
    return res.status(403).json({ error: 'INVALID_BASE_URL' });
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ja,en;q=0.9',
    'Origin': 'https://web.plaud.ai',
    'Referer': 'https://web.plaud.ai/',
    'Content-Type': 'application/json',
  };

  const enc = encodeURIComponent(shareToken);

  async function callApi(apiBase, path) {
    const r = await fetch(`${apiBase}${path}`, { headers, redirect: 'follow' });
    const text = await r.text();
    try { return JSON.parse(text); }
    catch (_) { return { _raw: text.slice(0, 200), _status: r.status }; }
  }

  try {
    // メタデータ（duration等）とaudio URLを並列取得
    let [meta, audioData] = await Promise.all([
      callApi(base, `/share/access/${enc}`),
      callApi(base, `/share/access/${enc}/audio`),
    ]);

    // -302 リージョンリダイレクト対応
    if (audioData?.status === -302 && audioData?.data?.domains?.api) {
      const redir = audioData.data.domains.api;
      [meta, audioData] = await Promise.all([
        callApi(redir, `/share/access/${enc}`),
        callApi(redir, `/share/access/${enc}/audio`),
      ]);
    }

    const duration_ms = meta?.data_file?.duration || null;
    const audioUrl = audioData?.temp_url || audioData?.data?.temp_url || audioData?.url || audioData?.data?.url;

    if (audioUrl) {
      return res.json({ url: audioUrl, duration_ms });
    }

    // フォールバック: team share エンドポイントも試す
    let data2 = await callApi(base, `/share/team/access/${enc}/audio`);
    if (data2?.status === -302 && data2?.data?.domains?.api) {
      data2 = await callApi(data2.data.domains.api, `/share/team/access/${enc}/audio`);
    }
    const audioUrl2 = data2?.temp_url || data2?.data?.temp_url;
    if (audioUrl2) {
      return res.json({ url: audioUrl2, duration_ms });
    }

    return res.status(404).json({
      error: 'NO_AUDIO_URL',
      detail: { audioStatus: audioData?.status, msg: audioData?.msg },
    });
  } catch (e) {
    return res.status(502).json({ error: 'PROXY_ERROR', detail: e.message });
  }
};
