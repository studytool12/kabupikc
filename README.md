# 株ウォッチリスト（Render移行版）

Muse のスペース「株ウォッチリスト」を Render で随時更新できる単一Webアプリとして再構築したもの。
Node.js（Express）+ SQLite（Node組み込み `node:sqlite`）構成で、外部CDNには依存しない。

## データの保存方式
- **環境変数 `DATABASE_URL` が設定されている場合、その Postgres（Neon 想定）が正の保存先**になる。Postgres 側にも SQLite と同じ3テーブル（`stocks` / `price_history` / `removed_stocks`）が作られ、アプリ内の SQLite はワーキングストア／キャッシュとして働く。
  - 起動時: Postgres にデータがあれば SQLite へ読み込む。Postgres が空なら、SQLite の内容（初回は `seed/` の初期データ）を Postgres へ書き込む。
  - 変更時: 銘柄の追加・編集・削除・復元・価格更新などの成功した API 変更を検知し、2秒デバウンスで Postgres へ保存し直す。保存に失敗してもアプリは落ちず、次回変更時に再試行する。
  - Render 無料プランには Persistent Disk が無いため、この方式で再デプロイ・再起動後も編集内容が保持される。
- `DATABASE_URL` 未設定の場合は従来通り SQLite のみで動く（ローカル開発用）。

## 機能
- 6ビュー: ウォッチリスト（検索・並び替え・判断フィルタ）／値動き（前日比・5日・1か月・3か月・52週高値比）／保有銘柄（評価額・損益）／チャート（ローソク足・出来高・ボリンジャー・75日線・RSI・MACD を Canvas で描画）／要対応（第一エントリー到達・接近、保有の損切り割れ、未分析）／未分析キュー
- 銘柄の追加・編集・削除（削除はアーカイブへ退避し、復元可能）／見送りアーカイブ表示
- 「価格更新」ボタン: サーバー側から Yahoo chart API（キーなし）で全銘柄の最新価格を取得し、価格履歴に追記
- 起動時に DB が空なら `seed/` のJSON（元スペースのエクスポート）から自動シード
- 環境変数 `APP_PASSWORD` を設定すると Basic 認証が有効になる（ユーザー名は `APP_USER`、既定 `admin`）

## ローカル起動
```bash
cd app
npm install
node server.js          # http://localhost:3000
# ポート変更: PORT=8080 node server.js
# DB場所変更: DATABASE_PATH=/path/to/watchlist.db node server.js
# Postgres を正にする: DATABASE_URL=postgresql://... node server.js
```

## Render へのデプロイ（無料プラン + Neon）
前提: このフォルダを Git リポジトリ（GitHub 等）に push し、Render と接続する（Render API だけではコードをアップロードできない）。

### 1. Neon で無料 Postgres を用意する
1. [Neon](https://neon.tech) にサインアップし、プロジェクトを作成する（リージョンは任意。Render のリージョンと近い場所が無難）
2. プロジェクトの Dashboard に表示される **Connection string**（`postgresql://ユーザー:パスワード@ホスト/DB名?sslmode=require` の形式）をコピーする
   - この文字列はパスワードを含むため、チャットやコードには貼らず、Render の環境変数画面にだけ直接入力する

### 2. Render にデプロイする
1. GitHub に空リポジトリを作成し、このフォルダを push
2. Render ダッシュボード → New → Blueprint（または Web Service）でリポジトリを選択
   - Blueprint の場合は同梱の `render.yaml`（無料プラン前提）がそのまま使われる
3. 環境変数を設定する（いずれも `sync: false` のためダッシュボードで手動入力）
   - `DATABASE_URL`: 手順1の Neon 接続文字列
   - `APP_PASSWORD`: 任意のパスワード（Basic 認証用。未設定なら認証なし）
4. デプロイ完了後、公開URLでアクセス。初回起動時に Postgres へテーブルが作られ、`seed/` の初期データ（115銘柄・価格履歴27,277件）が自動で投入される

注意:
- 無料プランの Web Service は無アクセスでスリープし、次回アクセス時に起動する（起動時に Postgres からデータを読み込むため、編集内容は保持される）。
- Docker を使わず Node ランタイムで動かす場合は、Build Command: `npm install`、Start Command: `node server.js`、環境変数 `NODE_VERSION=24` を指定する。
