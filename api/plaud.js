// PLAUD関連プロキシを1つの関数に統合(Vercel Hobbyプランの
// 「1デプロイあたり12 Serverless Functions」上限を超えないための対策)。
// ?action=auth | proxy | share でどの処理をするか振り分ける。

async function handleAuth(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' });
  }

  const BASES = [
    'https://api-apne1.plaud.ai',
    'https://api.plaud.ai',
    'https://api-euc1.plaud.ai',
  ];

  for (const base of BASES) {
    try {
      const authRes = await fetch(`${base}/auth/access-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Origin': 'https://app.plaud.ai',
          'Referer': 'https://app.plaud.ai/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'ja,en;q=0.9',
        },
        body: new URLSearchParams({ username: email, password }).toString(),
      });

      if (!authRes.ok) continue;

      const data = await authRes.json();
      const token = data.access_token || (data.data && data.data.access_token);
      if (!token) continue;

      let apiBase = base;
      let finalToken = token;

      try {
        const wsRes = await fetch(`${base}/user/workspace/list`, {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (wsRes.ok) {
          const wsData = await wsRes.json();
          const ws = (wsData.data && wsData.data.list && wsData.data.list[0]) || (wsData.data && wsData.data[0]);
          if (ws && ws.domain) apiBase = ws.domain;
          if (ws && ws.workspaceToken) finalToken = ws.workspaceToken;
        }
      } catch (_) {}

      return res.status(200).json({ token: finalToken, apiBase });
    } catch (_) {
      continue;
    }
  }

  return res.status(401).json({ error: 'AUTH_FAILED' });
}

async function handleProxy(req, res) {
  const path = req.query.path;
  const auth = req.headers['authorization'];
  const base = req.headers['x-plaud-base'] || 'https://api-apne1.plaud.ai';

  // /share/ パスは公開APIなので認証不要（認証ありだと链接错误になる場合がある）
  const isSharePath = (path || '').startsWith('/share/');
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
}

async function handleShare(req, res) {
  const { shareUrl, plaudApiBase } = req.body || {};

  if (!shareUrl) {
    return res.status(400).json({ error: 'MISSING_SHARE_URL' });
  }

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
    let [meta, audioData] = await Promise.all([
      callApi(base, `/share/access/${enc}`),
      callApi(base, `/share/access/${enc}/audio`),
    ]);

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
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Plaud-Base');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  if (action === 'auth') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleAuth(req, res);
  }
  if (action === 'share') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return handleShare(req, res);
  }
  if (action === 'proxy') {
    return handleProxy(req, res);
  }
  return res.status(400).json({ error: 'MISSING_OR_INVALID_ACTION' });
};
