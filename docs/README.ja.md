# OmniCodex 日本語ガイド

OmniCodex は、インストール済み Codex ランタイムの実際のツールを、所有者
認証付き MCP として提供し、Web とデスクトップの通常の Chat から利用できます。
インストールやバックグラウンド保守で Codex デスクトップを自動操作することはありません。
明示的に依頼された作業では、ランタイムのネイティブ Computer Use とデスクトップ
ツールを利用でき、アプリの起動・再起動には専用のライフサイクルツールを使用します。
Codex の認証・設定は変更せず、ローカル Codex に OmniCodex MCP を登録しません。
ソースと所有者固有のデプロイ情報は非公開です。アクセス権のある非公開リポジトリを
clone して `npm ci --ignore-scripts`、`npm run build`、`node dist/cli.js` の順に
使用してください。Auth0 の正確な
resource と ChatGPT アプリ URL はどちらも公開された `/mcp/full` です。Oracle 補助機能は既定で dry-run
であり、明示された loopback CDP にのみ接続し、Connect と Always allow 以外
をクリックしません。詳細は英語 README、PRD、reference ledger を参照してください。
