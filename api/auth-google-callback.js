// Googleの認可完了後にリダイレクトされてくるコールバック。
// refresh tokenを画面に表示するだけ(サーバー側には保存しない)。
// 表示されたトークンをVercelの環境変数 GOOGLE_REFRESH_TOKEN に手動で貼り付ける。

const { google } = require('googleapis');

function getRedirectUri(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/auth-google-callback`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = async function handler(req, res) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  const code = req.query.code;
  const err = req.query.error;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (err) {
    return res.status(400).send(`<p>認可がキャンセルされました: ${escapeHtml(err)}</p>`);
  }
  if (!code) {
    return res.status(400).send('<p>認可コードがありません。</p>');
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('<p>GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です。</p>');
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      getRedirectUri(req)
    );

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(200).send(`
        <p>refresh_tokenが返ってきませんでした。</p>
        <p>すでに一度認可済みの可能性があります。Googleアカウントの
        <a href="https://myaccount.google.com/permissions" target="_blank">アプリのアクセス権</a>
        からこのアプリのアクセスを一旦削除してから、もう一度
        <a href="/api/auth-google">こちら</a>から認可し直してください。</p>
      `);
    }

    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="ja"><head><meta charset="utf-8"><title>認可完了</title></head>
      <body style="font-family:sans-serif; max-width:640px; margin:40px auto; padding:0 16px;">
        <h2>✅ 認可完了</h2>
        <p>以下のrefresh tokenをコピーして、Vercelの環境変数
        <code>GOOGLE_REFRESH_TOKEN</code> に貼り付けてください。</p>
        <textarea readonly style="width:100%; height:80px; font-family:monospace; padding:8px;"
          onclick="this.select()">${escapeHtml(tokens.refresh_token)}</textarea>
        <p style="color:#666; font-size:14px;">
          このページを閉じてもトークンはサーバーに保存されません。
          コピーし忘れた場合は <a href="/api/auth-google">こちら</a> からやり直してください。
        </p>
      </body></html>
    `);
  } catch (e) {
    return res.status(500).send(`<p>トークン取得に失敗しました: ${escapeHtml(e.message)}</p>`);
  }
};
