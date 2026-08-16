// 初回のみローカル(Mac)で実行して、Google Driveのrefresh tokenを取得するスクリプト。
// サービスアカウントキー作成が組織ポリシーでブロックされているため、
// OAuth2(個人アカウント認可)方式に切り替えるために必要。
//
// 取得したrefresh tokenはVercelの環境変数 GOOGLE_REFRESH_TOKEN に貼り付ける。
//
// 事前準備:
// 1. https://console.cloud.google.com/apis/credentials でOAuthクライアントID作成
//    - アプリケーションの種類: デスクトップアプリ
//    - ※これはサービスアカウントキーとは別物なので iam.disableServiceAccountKeyCreation
//      ポリシーの対象外のはず
// 2. このディレクトリで .env.local を作成し、以下を記載
//    GOOGLE_CLIENT_ID=...
//    GOOGLE_CLIENT_SECRET=...
//
// 実行方法:
//   npm install googleapis dotenv
//   node scripts/get-refresh-token.mjs
//
// ブラウザが開くので、gensai.or.jp のGoogleアカウントで許可する。
// ターミナルに refresh_token が表示されるので、それをVercelの環境変数に保存する。

import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { exec } from 'child_process';

const REDIRECT_URI = 'http://localhost:53682/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // refresh tokenをもらうために必須
  prompt: 'consent',      // 毎回refresh tokenを再発行させるために必須
  scope: ['https://www.googleapis.com/auth/drive.readonly'],
});

console.log('\nブラウザで以下のURLを開いて認可してください:\n');
console.log(authUrl, '\n');

exec(`open "${authUrl}"`, () => {}); // Macなら自動でブラウザを開く

const server = http
  .createServer(async (req, res) => {
    if (!req.url.startsWith('/oauth2callback')) return;

    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');

    if (!code) {
      res.end('認可コードが取得できませんでした。');
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);

    res.end('認可完了。ターミナルを確認してください。このタブは閉じてOKです。');

    console.log('\n=== 以下をVercelの環境変数 GOOGLE_REFRESH_TOKEN に設定 ===\n');
    console.log(tokens.refresh_token);
    console.log('\n============================================\n');

    server.close();
    process.exit(0);
  })
  .listen(53682, () => {
    console.log('ローカルサーバー起動: http://localhost:53682 で待機中...');
  });
