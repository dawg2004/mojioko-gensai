// OAuth2認証ヘルパー(サービスアカウントキー方式の代替)
//
// 組織ポリシー iam.disableServiceAccountKeyCreation により
// サービスアカウントのJSON鍵が発行できないため、
// 個人のGoogleアカウントでのOAuth2認可 + refresh tokenを使う方式に変更。
//
// 必要な環境変数:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN   ← scripts/get-refresh-token.mjs をローカルで1回実行して取得

const { google } = require('googleapis');

function getOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('GOOGLE_OAUTH_ENV_NOT_CONFIGURED (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)');
  }

  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

module.exports = { getOAuthClient };
