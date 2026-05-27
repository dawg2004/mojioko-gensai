// PLAUD API汎用プロキシ - ブラウザのCORSを回避して中継

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Plaud-Base');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.query.path;
  const auth = req.headers['authorization'];
  const base = req.headers['x-plaud-base'] || 'https://api-apne1.plaud.ai';

  // /share/ パスは公開APIなので認証不要（認証ありだと链接错误になる場合がある）
  const isSharePath = path.startsWith('/share/');
  if (!path || (!auth && !isSharePath)) {
    return res.status(400).json({ error: 'MISSING_PATH_OR_AUTH' });
  }

  if (!base.match(/^https:\/\/[a-z0-9-]+\.plaud\.ai/)) {
    return res.status(403).json({ error: 'INVALID_BASE_URL' });
  }

  try {
    const plaudRes = await fetch(base + path, {
      method: req.method,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://web.plaud.ai',
        'Referer': 'https://web.plaud.ai/',
        'Accept-Language': 'ja,en;q=0.9',
      },
      redirect: 'follow',
    });

    // レスポンスがJSONかチェック
    const contentType = plaudRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await plaudRes.text();
      return res.status(502).json({
        error: 'NON_JSON_RESPONSE',
        status: plaudRes.status,
        contentType,
        preview: text.slice(0, 200),
      });
    }

    const data = await plaudRes.json();

    // PLAUDのリージョンミスマッチ対応 (status: -302)
    if (data.status === -302 && data.redirect_url) {
      const retryRes = await fetch(data.redirect_url + path, {
        method: req.method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });
      const retryData = await retryRes.json();
      return res.status(retryRes.status).json(retryData);
    }

    return res.status(plaudRes.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'PROXY_ERROR', detail: e.message });
  }
};
