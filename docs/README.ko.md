# OmniCodex 한국어 안내

OmniCodex는 설치된 Codex 런타임의 실제 도구를 owner 인증 MCP로 노출하며,
웹과 데스크톱의 일반 Chat에서 사용할 수 있습니다.
설치 과정에서는 Codex 데스크톱 앱을 자동으로 종료·제어하지 않습니다.
명시적으로 요청한 작업에서는 현재 런타임이 제공하는 네이티브 Computer Use와
데스크톱 도구를 실행할 수 있으며, Codex 데스크톱 앱의 실행·재시작에는
전용 데스크톱 수명주기 도구를 사용합니다.
Codex 인증·설정 파일은 변경하지 않으며 로컬 Codex 앱에 OmniCodex MCP를 등록하지 않습니다.

현재 저장소는 비공개이며 `package.json`은 `private: true`입니다. 설치는 접근 권한이
있는 비공개 소스 체크아웃을 기준으로 합니다. 공개 npm 패키지 조회나 전역 설치를
설치 전제로 삼지 않으며, 저장소 공개 또는 패키지 게시를 요구하지 않습니다.

필수 환경은 Windows, Node.js 22.12.0 이상, Git, 설치된 Codex 런타임 및 비공개
저장소 접근 권한입니다. 아래 PowerShell 명령은 해당 소스의 작업 폴더에서 실행합니다.
`<...>`는 실행 전에 운영 환경에서 확인한 값으로 바꾸는 자리표시자입니다. 서버 주소,
계정 식별자와 자격 증명을 문서에 기록하지 마십시오. 각 명령의 종료 코드가 0인지
확인하고 실패하면 다음 명령으로 넘어가지 않습니다.

## 최초 설치 순서

다음 순서를 건너뛰지 않습니다.

1. 권한이 있는 비공개 저장소를 체크아웃하고 빌드합니다. 이미 작업 중인 체크아웃이
   있으면 clone과 새 폴더 이동을 생략하고 그 폴더를 사용합니다. 기존 변경을 초기화하거나
   다른 체크아웃으로 덮어쓰지 않습니다. 저장소 URL에는 토큰을 삽입하지 않습니다.

   ```powershell
   git clone '<PRIVATE_REPOSITORY_URL>' OmniCodex
   Set-Location .\OmniCodex
   npm ci --ignore-scripts
   npm run build
   node dist/cli.js --help
   ```

   이후 예시도 전역 명령 대신 `node dist/cli.js`를 사용합니다.
2. Auth0 issuer, 전용 API audience, `/mcp/full` OAuth resource, 허용할 owner `sub`와
   Chat origin을 확인해 저장합니다. 아래 일반 gateway 초기화는 즉시 설정을 저장합니다.
   `init --local-only`는 보조 기능만 초기화하므로 gateway 설치를 대신하지 않습니다.

   ```powershell
   node dist/cli.js init `
     --issuer '<AUTH0_ISSUER_URL>' `
     --audience '<MCP_API_AUDIENCE>' `
     --resource '<MCP_RESOURCE_URL>' `
     --subject '<OWNER_SUBJECT>' `
     --allowed-origin '<CHAT_ORIGIN>' `
     --non-interactive --json
   ```

   resource는 경로가 정확히 `/mcp/full`인 HTTPS URL이며 audience와 인증 설정이
   일치해야 합니다. origin은 허용할 정확한 origin만 지정합니다.
3. 공식 Auth0 device login과 필요한 MFA를 완료한 뒤 전용 API 및 DCR 설정을 확인합니다.

   ```powershell
   node dist/cli.js auth login --json
   node dist/cli.js auth setup --json
   node dist/cli.js auth status --json
   ```

4. 안정된 HTTPS ingress를 하나만 구성합니다. 이미 승인된 ingress가 있다면 그대로
   유지합니다. 다음은 아직 gateway를 시작하지 않은 최초 설치에서 ngrok를 선택하는
   예시입니다. 운영 중에는 터널 설정 변경이 거부되므로 그대로 재실행하지 않습니다.
   외부에서 안전하게 주입한 환경 변수의 토큰을 stdin으로 전달합니다. 토큰을 명령 인수나
   문서에 적지 않으며, 로컬 저장 값은 CurrentUser DPAPI 암호문입니다.

   ```powershell
   if ([string]::IsNullOrWhiteSpace($env:OMNICODEX_NGROK_TOKEN)) {
     throw '안전한 경로로 ngrok 토큰 환경 변수를 먼저 설정하십시오.'
   }
   try {
     $env:OMNICODEX_NGROK_TOKEN | node dist/cli.js tunnel set ngrok `
       --url '<HTTPS_INGRESS_ORIGIN>' --authtoken-stdin --json
     if ($LASTEXITCODE -ne 0) { throw 'ngrok 설정에 실패했습니다.' }
   } finally {
     Remove-Item Env:OMNICODEX_NGROK_TOKEN -ErrorAction SilentlyContinue
   }
   ```

   기존 DPAPI 자격 증명 참조를 재사용할 때는 `--authtoken-stdin` 대신
   `--credential-ref '<EXISTING_DPAPI_CREDENTIAL_REF>'`를 사용합니다. 둘을 함께 지정하지 않습니다.
5. gateway 상태와 로컬 진단을 확인하고 격리 런타임을 검사합니다.

   ```powershell
   node dist/cli.js start --json
   node dist/cli.js status --json
   node dist/cli.js doctor --json
   node dist/cli.js runtime probe --json
   ```

   `status`의 `configured`, `running`, `state.lifecycle`을 구분해 확인합니다.
   `runtime probe`는 별도의 숨겨진 런타임을 시작하는 검사이며 단순 상태 조회가 아닙니다.
   로컬 진단 성공만으로 다음 단계의 실제 Chat 연결을 성공 처리하지 않습니다.
6. 해당 클라이언트에서 사용하는 ChatGPT 계정의 **설정 → 보안 및 로그인 → 개발자 모드**를
   켠 뒤 **플러그인 → +**에서 이름 `OmniCodex`, URL
   `<REGISTERED_MCP_ENDPOINT_URL>`, OAuth+DCR로 MCP를 등록합니다. URL의 경로는
   정확히 `/mcp/full`이어야 합니다. OAuth Accept 화면만으로
   성공 처리하지 않습니다. 주인님께서 선택하신 모델과 추론 설정을 유지한 일반
   Chat에서 실제 네이티브 도구 결과와 최종 응답을 확인해야 합니다. 데스크톱 앱의
   일반 Chat은 앱에 로그인한 계정에서 같은 서비스를 등록하고, 발급된
   `plugin_asdk_app...` ID를 로컬 플러그인의 `.app.json`에 연결합니다.
   플러그인 manifest의 `apps` 필드는 이 파일을 가리켜야 합니다.
   Codex 모드에 로컬 MCP 서버를 추가하는 것으로 이 계정 등록이 완료되지는 않습니다.
   [공식 로컬 플러그인 설정 절차](https://developers.openai.com/plugins/build/plugins#create-and-test-a-plugin-locally-with-an-mcp-server)를
   따라 연결한 뒤 웹 → 앱 → 웹 순서로 호출합니다.
   각 클라이언트의 계정에서 확인한 실제 등록 ID는 `--client-binding web`과 `--client-binding desktop`으로
   각각 보관하며, 한쪽을 연결하기 위해 다른 쪽의 등록을 교체하지 않습니다.
   로컬 플러그인 표시만으로 앱 계정의 연결 성공을 판단하지 않습니다.
   아래 독립 등록 예시로 각 보조 기능을 설정한 뒤 두 Chat을 함께 열어 다시 검증합니다.
   각 대화의 실행 문맥, 결과와 Goal이 다른 대화에 섞이지 않아야 합니다.
7. 두 클라이언트의 종단간 성공 후에만 로그온 자동 시작을 설정합니다.

   ```powershell
   node dist/cli.js autostart enable --json
   node dist/cli.js autostart status --json
   node dist/cli.js autostart test --json
   ```

   정확한 현재 사용자
   `\OmniCodex\Gateway` Scheduled Task action·VBS 바이트·새 hidden launcher 성공 receipt를
   확인합니다. `HKCU` Run key는 대체 경로로 허용하지 않으며, 구 개발판의 정확한 owned
   등록만 Scheduled Task의 권위 있는 readback 후 제거합니다. 수동 검사는 `manual-test`,
   Task 실행은 `scheduled-task`로 receipt에 분리되고 관측한 Windows boot 시각에도 묶입니다.
   따라서 실제 재부팅 뒤 `rebootVerifiedForCurrentBoot: true`가 된 경우만 reboot gate를
   만족하며 수동 test는 대신할 수 없습니다.

## Gateway 상태 확인과 재시작

gateway용 `status`와 `restart`는 최상위 명령입니다. `gateway`라는 중간 하위 명령을
붙이지 않습니다. 상태 확인은 다음과 같습니다.

```powershell
node dist/cli.js status --json
node dist/cli.js oracle status --client-binding web --json
node dist/cli.js oracle status --client-binding desktop --json
```

소스를 승인된 상태로 갱신한 뒤에는 작업 폴더에서 빌드하고 해당 빌드의 CLI로 재시작합니다.
진행 중인 요청이 끝나도록 drain한 뒤 OmniCodex 소유 프로세스를 교체하는 명령입니다.
기존 Codex 앱을 종료하는 명령이 아닙니다. 서비스 전환을 유발하므로 단순 진단 때는
실행하지 않습니다. 이 문서만 바꾼 경우에도 재시작은 필요하지 않습니다.

```powershell
npm run build
node dist/cli.js restart --json
node dist/cli.js status --json
node dist/cli.js oracle status --client-binding web --json
node dist/cli.js oracle status --client-binding desktop --json
```

같은 실행 빌드가 이미 `ready`이면 `restart`는 `restarted: false`,
`alreadyCurrent: true`를 반환하며 재시작을 생략합니다. 같은 빌드라도 재기동이 필요한
경우에만 다음 대체 명령을 사용합니다. `--drain-timeout`의 단위는 밀리초이며 예시의
대기 한도는 운영 상황에 맞게 선택합니다. `restart`에는 `--execute`를 붙이지 않습니다.

```powershell
node dist/cli.js restart --force --drain-timeout 300000 --json
```

재시작 후에는 위의 세 상태 명령을 다시 실행하고 웹 → 앱 → 웹의 실제 도구 호출까지
확인합니다. 한쪽이 실패해도 다른 쪽 등록을 삭제하거나 덮어써서 복구하지 않습니다.

## 웹·데스크톱 독립 Oracle 등록

`oracle setup/status/test/disable`에는 항상 `--client-binding web` 또는
`--client-binding desktop`을 명시합니다. 생략 시 기본값은 `web`입니다. `setup`은
계정에 앱을 새로 등록하는 명령이 아니라 이미 해당 Chat 계정에 등록된 앱의 정보를
로컬에 보관하는 명령입니다. 한쪽의 setup이나 disable은 다른 쪽의 저장된 등록을 보존합니다.

`<WEB_CONNECTOR_ID>`와 `<DESKTOP_CONNECTOR_ID>`는 각 클라이언트의 실제 계정 등록에서
확인합니다. 웹 ID를 데스크톱 플러그인 파일에 복사하는 것으로 계정 연결을 대신하지 않습니다.
`<WEB_RUN_ID>`와 `<DESKTOP_RUN_ID>`는 각 바인딩의 정확한 실행 식별자입니다.
`<MCP_RESOURCE_URL>`은 gateway의 OAuth resource와 일치해야 하며
`<REGISTERED_MCP_ENDPOINT_URL>`은 각 Chat에 실제 등록한 같은 서비스의 endpoint입니다.
두 URL 모두 HTTPS이고 경로가 `/mcp/full`이어야 하며 사용자 정보, 쿼리와 fragment를 넣지 않습니다.
resource와 endpoint가 같은 구성이라면 두 자리표시자에 같은 값을 사용합니다.

`<WEB_LOOPBACK_CDP_URL>`과 `<DESKTOP_LOOPBACK_CDP_URL>`에는 각 등록 계정에 접근 가능한
승인용 브라우저의 명시적으로 구성된 HTTP loopback CDP URL을 넣습니다. 포트가 필요하며
외부 서버 IP를 직접 넣는 항목이 아닙니다. 각 계정에 접근 가능한 CDP 연결은 사전에
준비되어 있어야 합니다. 일반 웹 Chat과 데스크톱 Chat의 등록은 독립적으로 유지합니다.

### Setup: 각 등록 저장

다음 예시는 `--execute`로 실제 저장합니다. 같은 전체 명령에서 `--execute`만 빼면
입력 검증과 미리보기만 수행하며 저장하지 않습니다. connector 이름은 정확히
`OmniCodex`를 사용합니다. `--endpoint`를 생략하면 같은 등록의 기존 값 또는 resource가
사용되므로 실제 등록값을 명시하는 예시를 사용합니다.

```powershell
node dist/cli.js oracle setup --client-binding web `
  --connector-id '<WEB_CONNECTOR_ID>' `
  --connector-name OmniCodex `
  --run-id '<WEB_RUN_ID>' `
  --resource '<MCP_RESOURCE_URL>' `
  --endpoint '<REGISTERED_MCP_ENDPOINT_URL>' `
  --surface /mcp/full `
  --cdp-endpoint '<WEB_LOOPBACK_CDP_URL>' `
  --execute --non-interactive --json

node dist/cli.js oracle setup --client-binding desktop `
  --connector-id '<DESKTOP_CONNECTOR_ID>' `
  --connector-name OmniCodex `
  --run-id '<DESKTOP_RUN_ID>' `
  --resource '<MCP_RESOURCE_URL>' `
  --endpoint '<REGISTERED_MCP_ENDPOINT_URL>' `
  --surface /mcp/full `
  --cdp-endpoint '<DESKTOP_LOOPBACK_CDP_URL>' `
  --execute --non-interactive --json
```

호스트가 발급한 action version을 확인한 경우에만 해당 setup에
`--action-version-id '<WEB_ACTION_VERSION_ID>'` 또는
`--action-version-id '<DESKTOP_ACTION_VERSION_ID>'`를 추가합니다. 값을 임의로 만들거나
다른 등록에서 가져오지 않습니다. setup 성공은 로컬 저장·재읽기 성공이지 Chat 연결 검증 성공이 아닙니다.

### Status와 Test: 두 등록을 각각 검증

```powershell
node dist/cli.js oracle status --client-binding web --json
node dist/cli.js oracle status --client-binding desktop --json

# 먼저 설정을 점검합니다. 승인 컨트롤을 클릭하지 않는 미리보기입니다.
node dist/cli.js oracle test --client-binding web --non-interactive --json
node dist/cli.js oracle test --client-binding desktop --non-interactive --json

# 실제 연결·권한 조정과 현재 도구 목록 검증이 필요할 때 실행합니다.
node dist/cli.js oracle test --client-binding web --execute --non-interactive --json
node dist/cli.js oracle test --client-binding desktop --execute --non-interactive --json

node dist/cli.js oracle status --client-binding web --json
node dist/cli.js oracle status --client-binding desktop --json
```

`test --execute`에는 실행 중인 gateway와 해당 계정에 접근 가능한 CDP가 필요합니다.
최초 OAuth 로그인은 해당 승인 브라우저에서 완료해야 할 수 있습니다. `--non-interactive`는
로그인 완료를 대신하지 않습니다. 미리보기에서도 보조 기능이 소유한 설정 탭은 열고 닫을 수
있지만 승인 컨트롤을 클릭하지는 않습니다. 실행 모드는 연결·최대 권한을 조정하고 현재
도구 목록을 검증하며 이미 검증된 연결은 재사용할 수 있습니다.

각 status의 `clientBinding`, `enabled`, `configuredComplete`, `complete`,
`bindingEndpointCurrent`를 구분합니다. 저장된 구성만 완전한 것과 gateway·공개 endpoint까지
준비된 것은 다릅니다. 정상 연결 판정에서는 해당 binding, `enabled: true`,
`complete: true`를 확인하고 선택한 모델·추론 설정을 유지한 두 일반 Chat에서
웹 → 앱 → 웹으로 실제 네이티브 결과와 최종 응답을 다시 확인합니다.

`oracle status --activity-only`는 현재 daemon의 공통 활동 카운터만 조회하는 별도
진단입니다. 클라이언트별 등록 상태나 두 Chat의 종단간 성공을 대신하지 않습니다.

### Disable: 필요할 때 한쪽 보조 기능만 비활성화

다음 두 블록은 대안입니다. 설치·검증 직후 순서대로 실행하지 말고 비활성화할 쪽만
선택합니다. `--execute` 없는 명령은 미리보기이고 뒤의 명령이 실제 저장입니다.

웹 보조 기능만 비활성화하는 경우:

```powershell
node dist/cli.js oracle disable --client-binding web --non-interactive --json
node dist/cli.js oracle disable --client-binding web --execute --non-interactive --json
node dist/cli.js oracle status --client-binding web --json
node dist/cli.js oracle status --client-binding desktop --json
```

데스크톱 보조 기능만 비활성화하는 경우:

```powershell
node dist/cli.js oracle disable --client-binding desktop --non-interactive --json
node dist/cli.js oracle disable --client-binding desktop --execute --non-interactive --json
node dist/cli.js oracle status --client-binding desktop --json
node dist/cli.js oracle status --client-binding web --json
```

disable은 선택한 로컬 보조 기능의 `enabled`를 false로 저장할 뿐 Chat 계정의 MCP 앱을
삭제하거나 브라우저를 종료하지 않습니다. 실행 후 대상의 비활성화와 다른 등록의 보존을
각각 확인합니다. 현재 CLI의 Oracle 하위 명령은 setup, status, test, disable이며
별도 `oracle watch` 명령은 없습니다.

## Auth0 DCR 정리

Auth0 DCR quota가 가득 찼다면 후보의 공개 메타데이터와 fingerprint를 검토한 뒤
현재 웹·데스크톱 등록이 사용하지 않는 정확히 한 stale client만 선택합니다.

```powershell
node dist/cli.js auth dcr-clients --json
node dist/cli.js auth cleanup-dcr `
  --client-id '<STALE_CLIENT_ID>' --fingerprint '<EXACT_SHA256>' --json
```

미리보기 결과와 두 활성 등록의 보존을 확인한 경우에만 실제 삭제합니다.

```powershell
node dist/cli.js auth cleanup-dcr `
  --client-id '<STALE_CLIENT_ID>' --fingerprint '<EXACT_SHA256>' `
  --execute --non-interactive --json
```

변경성 도구에는 MCP 호출 봉투 전용 선택 필드 `omnicodexInvocationId`가 노출됩니다. 이를
지원하는 호출자는 의도한 작업마다 새 식별자를 한 번 만들고, 동일한 작업을 재시도할 때만
같은 값을 사용합니다. OmniCodex는 Codex 네이티브 호출 전에 이 필드를 제거하고, 모든 MCP
세션이 공유하는 단일 owner-bound 내구성 ledger에서 중복을 결합합니다. 따라서 동시 중복
호출도 네이티브로는 한 번만 실행되며, 다른 인수로 식별자를 재사용하면 거부됩니다. 캐시된
구형 스키마 때문에 이 필드를 보낼 수 없는 클라이언트는 별도의 내구성 5초 fan-out cohort를
사용합니다. 서로 다른 세션으로 복제된 동일 호출은 한 번만 실행하고, 같은 세션의 서로 다른
요청은 별도 의도로 실행합니다. 전송 뒤 결과를 확정할 수 없어진 변경은 재시작 후에도 다시
실행하지 않습니다. 읽기 전용 1급 도구에는 이 식별자가 필요하지 않습니다.

## 별도 패키지 릴리스의 업데이트·검증

현재 비공개 소스 설치의 갱신은 위의 빌드·restart 절차를 사용합니다. CLI의 `update`는
정확한 npm 릴리스가 별도로 존재할 때만 사용하는 경로이며 소스 체크아웃 갱신을 대신하지
않습니다. `rollback`도 이미 보관된 패키지 릴리스가 전제입니다. 아래 안내는 해당
릴리스가 실제 준비된 경우에만 적용하며 설치를 위해 공개 배포를 요구하지 않습니다.

업데이트는 `node dist/cli.js update --target-version '<PACKAGE_VERSION>' --expected-commit '<EXACT_40_CHAR_LOWERCASE_SHA>' --execute --json`, 롤백은
`node dist/cli.js rollback --target-version '<RETAINED_PACKAGE_VERSION>' --execute --json`입니다. arbitrary path
rename이 아니라 exact npm integrity·registry gitHead·GitHub 저장소·SLSA DSSE의
subject digest와 resolved commit·signature audit·SBOM·실제 runtime probe를
검증합니다. 보관된 버전도 registry/provenance/signature audit를 다시 수행하고 실제
설치 package 파일 digest와 SBOM이 같아야 재사용합니다. 일반 호출은 5분, 명시적 model
turn은 30분까지 drain한 뒤 owned daemon을 중지하고 matching snapshot→stable pointer→
draining 상태 daemon 순으로 전환합니다. protected MCP 관측 뒤에만 admission을 열며,
실패하면 이전 snapshot→pointer→owned daemon을 같은 트랜잭션으로 복원합니다.

후보/공개 릴리스는 같은 commit·package version·packed SHA-256에 묶인 실제
`release-acceptance.json`의 모든 필수 gate가 통과해야 합니다. 확인은
`node dist/cli.js acceptance status`, 강제 검증은 `node dist/cli.js acceptance verify`를 사용합니다.
실제 gate가 성공한 직후 다음 명령으로 기록합니다.

```powershell
node dist/cli.js acceptance record `
  --gate '<GATE_NAME>' --source-commit '<EXACT_40_CHAR_LOWERCASE_SHA>' `
  --package-version '<PACKAGE_VERSION>' --package-sha256 '<PACKAGE_SHA256>' `
  --artifact '<ARTIFACT_KIND>=<ABSOLUTE_ARTIFACT_PATH>' --execute --non-interactive --json
```

릴리스 acceptance는 런타임 실행이나 대화 Goal 진행의 전제 조건이 아닙니다.
증거 파일에는 artifact 종류·크기·SHA-256만 남고 원본 경로나
내용은 복사되지 않으며, 다른 build 혼합과 기존 gate 증거 교체는 거부됩니다.

Oracle 보조 기능의 setup, test, disable은 `--execute`가 없으면 미리보기이며
status는 조회 명령입니다. 위의 클라이언트별 전체 명령을 사용합니다.
explicit loopback CDP에만 attach하고 exact `Connect`와 `항상 허용` 외에는
클릭하지 않습니다. Chrome을 시작·프로필 변경·종료하지 않고, 무관한 탭을 이동하지도
않습니다. 설정 조정이 필요하면 보조 기능이 소유한 exact 앱 설정 target만 열고
이동합니다. 보안 구조와 채택 근거는 [PRD](../PRD.md)와
[reference ledger](reference-ledger.md)를 참조하십시오.
