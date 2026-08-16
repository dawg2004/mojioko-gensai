// ブラウザでこのURLを開くだけでGoogleの認可画面に遷移する。
// 認可完了後は /api/auth-google-callback にリダイレクトされ、
// そこでrefresh tokenが画面に表示される（ローカル作業一切不要）。

const { google } = require('googleapis');

function getRedirectUri(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/auth-google-callback`;
}

module.exports = async function handler(req, res) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です。' +
      'Vercelの環境変数に設定してから再デプロイしてください。'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    getRedirectUri(req)
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // refresh tokenをもらうために必須
    prompt: 'consent',      // 毎回refresh tokenを再発行させるために必須
    scope: ['https://www.googleapis.com/auth/drive'], // 読み書き両方(文字起こし結果のアップロード用に書き込み権限も必要)
  });

  res.writeHead(302, { Location: authUrl });
  res.end();
};
