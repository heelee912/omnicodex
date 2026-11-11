# OmniCodex 日本語ガイド

OmniCodex は、インストール済み Codex ランタイムの実際のツールを、所有者
認証付き MCP として提供し、Web とデスクトップの通常の Chat から利用できます。
インストールやバックグラウンド保守で Codex デスクトップを自動操作することはありません。
明示的に依頼された作業では、ランタイムのネイティブ Computer Use とデスクトップ
ツールを利用でき、アプリの起動・再起動には専用のライフサイクルツールを使用します。
Codex の認証・設定は変更せず、ローカル Codex に OmniCodex MCP を登録しません。
このソースリポジトリは公開されていますが、npm パッケージは未公開で
`package.json` は `private: true` です。Windows、Node.js 24.14.0 以降、
Git、サインイン済みの Codex Desktop を用意し、公開リポジトリを clone して
`npm ci --ignore-scripts`、`npm run build`、`node dist/cli.js init --help` の
順に進めてください。各利用者は自分の Auth0 アプリ・API、HTTPS トンネル、
Codex/ChatGPT アカウントを設定します。個人の認証情報は同梱されません。
OmniCodex2 の任意の hosted コネクタは
[セットアップガイド](../scripts/connectors/hosted-mcp/README.md)を参照してください。
詳細な手順と安全境界は[英語 README](../README.md)と
[reference ledger](reference-ledger.md)に記載しています。
