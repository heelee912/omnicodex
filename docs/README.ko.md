# OmniCodex 한국어 안내

OmniCodex는 설치된 Codex 런타임의 실제 도구를 owner 인증 MCP로 노출합니다.
Codex 데스크톱 앱을 종료·제어하거나 인증/설정 파일을 변경하지 않으며, 로컬
Codex 앱에 OmniCodex MCP를 등록하지 않습니다.

설치는 `npm install -g @heelee912/omnicodex`, 초기화는 `omnicodex init`, 운영 확인은
`omnicodex doctor`를 사용합니다. 원격 연결에는 exact OAuth resource와 안정된
HTTPS ingress가 필요합니다. Oracle 보조 기능은 README의 `oracle setup/status/
test/disable` 명령을 사용하며 기본 dry-run입니다. explicit loopback CDP에만
attach하고 Connect/항상 허용 외에는 클릭하지 않습니다. 보안 구조와 채택
근거는 [PRD](../PRD.md)와 [reference ledger](reference-ledger.md)를 참조하십시오.
