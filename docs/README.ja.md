# OmniCodex 日本語ガイド

OmniCodex は、インストール済み Codex ランタイムの実際のツールを、所有者
認証付き MCP として提供し、Web とデスクトップの通常の Chat から利用できます。
インストールやバックグラウンド保守で Codex デスクトップを自動操作することはありません。
明示的に依頼された作業では、ランタイムのネイティブ Computer Use とデスクトップ
ツールを利用でき、アプリの起動・再起動には専用のライフサイクルツールを使用します。
Codex の認証・設定は変更せず、ローカル Codex に OmniCodex MCP を登録しません。
このソースと scoped npm パッケージは公開配布用です。Windows、Node.js
24.14.0 以降、サインイン済みの Codex Desktop を用意し、npm で `0.1.0`
の公開を確認して `npm install --global @heelee912/omnicodex --ignore-scripts`
を実行してください。未公開の場合はソースを clone して
`npm ci --ignore-scripts` と `npm run build` を実行します。各利用者は自分の
Auth0 アプリ・API、HTTPS トンネル、Codex/ChatGPT アカウントを設定します。
個人の認証情報はパッケージに含まれません。
OmniCodex2 の任意の hosted コネクタは
[セットアップガイド](../scripts/connectors/hosted-mcp/README.md)を参照してください。
詳細な手順と安全境界は[英語 README](../README.md)と
[reference ledger](reference-ledger.md)に記載しています。
