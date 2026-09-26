---
name: setup
description: 저장소에 orbit 프로젝트 하네스를 설치한다. worklog 작업 일지, GTD 할일 원장, ADR, 연결형 위키, 제한된 결정 맥락 수집(decision-context), Claude 훅과 선택형 Codex·리뷰어 모듈을 안전하게 설치한다. "orbit 깔아줘", "하네스 설치", "이 레포에 orbit 세팅", "harness setup" 같은 요청, 신규 설치·기존 docs 마이그레이션·업그레이드 상황이면 반드시 이 스킬을 쓴다.
---

# Orbit setup

이 스킬은 대상 Git 저장소에 하네스(worklog·할일·ADR·위키·훅과 선택 모듈)를 설치한다. 실행 위치와 무관하게 이 디렉터리의 `assets/`를 원본으로 삼아 대상 저장소에만 파일을 만든다.

## 불변 원칙

- 대상 문서 볼트는 프로젝트 슬러그에서 한 번 계산한 `<slug>-docs/`를 모든 파일에 사용한다.
- `<slug>-docs/`는 프로젝트 지식, ADR, 작업 기록을 위한 문서 전용 영역이다. 소스 코드, 빌드 산출물, 비밀 설정, 애플리케이션이 읽고 쓰는 런타임 데이터의 위치로 제안하거나 사용하지 않는다.
- 설치하는 `CLAUDE.md`, `AGENTS.md`, `<slug>-docs/rules.md`에 이 문서 경계를 매 작업에 적용할 규칙으로 남긴다. 제품 데이터의 기본 위치는 저장소 루트 아래 `data/`처럼 용도를 드러내는 별도 경로다.
- Claude의 매 사용자 턴은 `UserPromptSubmit`에서 세션별 미기록 상태로 시작한다. `worklog.mjs append`가 해당 상태를 완료 처리하고, `Stop` 훅은 누락된 첫 종료를 막는다.
- 종료 훅이 다시 실행됐는데도 기록이 없으면 최소 복구 항목을 자동으로 남기고 종료를 허용한다. `stop_hook_active`를 확인해 무한 반복을 만들지 않는다.
- `new`, `migrate`, `upgrade`를 섞지 않는다.
- 적용 전에 항상 `plan`을 실행한다.
- 기존 파일이나 같은 이름의 npm 스크립트가 다르면 자동으로 덮어쓰지 않는다.
- 훅은 이벤트 배열별로 연결하고 완전히 같은 핸들러만 중복 제거한다.
- Codex와 리뷰어는 사용자가 선택한 경우에만 설치한다.
- git과 Node.js 18 이상이 없으면 설치하지 않는다. 없는 도구를 사용자 동의 없이 설치하지 않고, 사용자가 도구 설치를 거부하면 orbit 설치를 취소한다.
- 이 스킬은 대상 저장소에만 파일을 만든다. 스킬 자신의 배포(플러그인 릴리스)는 이 설치 흐름의 범위가 아니다.

## 가장 먼저: 필수 도구 확인

orbit은 Git 저장소에 설치되고, 설치기와 훅이 Node.js로 돈다. 다른 어떤 단계보다 먼저 두 도구가
있는지 확인한다. macOS에서 명령줄 도구 없이 `git`을 바로 실행하면 설치 창이 저절로 뜨므로,
`/usr/bin/git`이면 `xcode-select -p`로 설치 여부부터 본다.

```bash
GIT_PATH="$(command -v git || true)"
if [ -z "$GIT_PATH" ] || { [ "$(uname)" = "Darwin" ] && [ "$GIT_PATH" = "/usr/bin/git" ] && ! xcode-select -p >/dev/null 2>&1; }; then
  echo "git: 없음"
else
  git --version
fi
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  node --version
else
  echo "node: 없음 또는 18 미만"
fi
```

- 둘 다 있으면 다음 절로 넘어간다.
- 하나라도 없으면 설치 흐름을 멈추고 `AskUserQuestion`을 한 질문만 담아 호출한다.

```text
헤더: 필수 도구
질문: orbit을 설치하려면 <빠진 도구>가 먼저 필요합니다. 지금 설치할까요?
선택 1: 설치하고 계속
설명: <빠진 도구>를 설치한 뒤 다시 확인하고 orbit 설치를 이어 갑니다.
선택 2: orbit 설치 취소
설명: 아무 파일도 바꾸지 않고 끝냅니다.
```

- `설치하고 계속`을 고르면 설치 방법을 안내한다. 명령은 사용자가 직접 실행하거나, 사용자가 실행을
  허락한 경우에만 대신 실행한다. 관리자 권한(`sudo`)이 필요한 명령은 대신 실행하지 않는다.
  - git: macOS는 `xcode-select --install`(설치 창에서 사용자가 마무리) 또는 Homebrew가 있으면
    `brew install git`. 그 밖의 환경은 운영체제의 패키지 관리자로 설치한다.
  - Node.js 18 이상: Homebrew가 있으면 `brew install node`, 없으면 https://nodejs.org 의 LTS 설치 파일.
- 설치가 끝나면 위 확인 명령을 다시 실행한다. 통과해야만 다음 절로 넘어간다. 여전히 빠진 도구가
  있으면 무엇이 빠졌는지 알리고 같은 질문을 다시 한다.
- `orbit 설치 취소`를 고르거나 도구 설치를 거부하면 어떤 파일도 바꾸지 않고 설치를 끝낸다.

## 먼저 확인하고 물을 것

1. 현재 디렉터리가 대상 Git 저장소 루트인지 확인한다. Git 저장소가 아니면 `git init`을 할지 묻고,
   사용자가 동의하지 않으면 설치를 끝낸다.
2. 디렉터리 이름과 `package.json`에서 프로젝트 표시 이름 후보를 만든다. 후보를 실제 값으로 확정하지 않는다.
3. `AskUserQuestion`을 한 질문만 담아 호출해 표시 이름을 받는다. 구체적인 후보 두 개를 선택지로 보여주고 Claude Code UI가 제공하는 `Type something` 자유 입력도 사용할 수 있게 둔다.
4. 표시 이름 답을 받은 뒤에만 별도의 `AskUserQuestion`을 호출해 슬러그를 받는다. 확정된 표시 이름에서 만든 슬러그와 저장소 폴더 이름에서 만든 슬러그를 선택지로 보여준다.
5. Codex 병행과 리뷰어 에이전트 5종 여부를 묻는다.

### AskUserQuestion 호출 형식 (모든 질문 공통)

이 스킬의 모든 `AskUserQuestion` 호출은 아래 필수 필드를 빠짐없이 채운다. 하나라도 빠지면
질문 내용과 무관하게 `Invalid tool parameters`로 호출 자체가 실패한다.

- `question`: 완전한 문장으로 끝나는 질문.
- `header`: 12자 이내의 짧은 라벨(예: `표시 이름`, `슬러그`).
- `options`: 2~4개. **각 선택지는 `label`(실제로 선택될 값)과 `description`(값의 출처·의미)
  둘 다 필수다** — 이 문서의 질문 형태 예시는 라벨만 보여주지만, 호출할 때는 선택지마다
  `description`을 반드시 채운다.
- `multiSelect`: 단일 선택 질문이어도 생략하지 말고 `false`를 명시한다.

호출이 `Invalid tool parameters`로 실패하면 같은 내용을 그대로 재시도하지 말고 위 필수
필드부터 점검해 채운 뒤 다시 호출한다. 그래도 실패하면 그 질문만 평문 질문으로 물어 답을
받고 다음 단계로 진행한다 — 도구 오류 때문에 설치 흐름을 멈추지 않는다.

### 표시 이름과 슬러그 입력 규칙

- 표시 이름과 슬러그를 같은 `AskUserQuestion` 호출에 넣지 않는다. 표시 이름 답을 받은 다음 슬러그 질문을 호출한다.
- 폴더 이름이나 `package.json` 값을 사용자 답 없이 확정하지 않는다.
- 선택지에 `직접 지정`, `직접 입력`, `사용자 지정`, `Other`, `Type something` 같은 가짜 항목을 만들지 않는다. 이런 일반 선택지를 누르면 그 문구 자체가 답이 되어 버린다.
- 자유 입력은 Claude Code가 질문 UI에 자동으로 붙이는 `Type something` 입력을 사용한다.
- 사용자가 자유 입력으로 보낸 문자열은 추천 선택지의 라벨과 달라도 실제 답으로 받아야 한다. 빈 값이거나 취소된 경우 다음 단계로 넘어가지 않는다.
- 표시 이름은 사용자가 입력한 대소문자와 공백을 그대로 보존한다.
- 슬러그는 영문 소문자, 숫자, 하이픈만 허용한다. 자유 입력값이 `^[a-z0-9]+(?:-[a-z0-9]+)*$`를 통과하지 못하면 이유를 설명하고 슬러그 질문만 다시 한다. 폴더 이름으로 몰래 되돌리지 않는다.
- 두 추천 후보가 같으면 두 번째 후보는 폴더 이름에 `-app`을 붙여 서로 다른 실제 값을 제시한다. 자유 입력을 대신하는 추상적인 선택지는 만들지 않는다.

표시 이름 질문의 형태:

```text
헤더: 표시 이름
질문: 프로젝트에서 사용할 표시 이름을 선택하거나 직접 입력하세요.
선택 1: 추정한 읽기 좋은 이름의 실제 값 (추천)
선택 2: 저장소 폴더 이름의 실제 값
```

슬러그 질문의 형태:

```text
헤더: 슬러그
질문: 문서 폴더와 설정에 사용할 영문 슬러그를 선택하거나 직접 입력하세요.
선택 1: 표시 이름에서 만든 실제 슬러그 (추천)
선택 2: 저장소 폴더에서 만든 실제 슬러그
```

선택지 라벨에는 `추천 이름`, `폴더 이름` 같은 설명만 쓰지 말고 실제로 선택될 값 자체를 넣는다. 설명 필드에 각 값의 출처를 적는다.


### 사용자 질문과 보고 원칙

- 사용자 화면에서 `plan`, `apply`, `new`, `migrate`, `upgrade`를 행동 이름으로 쓰지 않는다. 이 값들은 설치기 호출에만 사용한다.
- "계획이 깨끗합니다", "충돌 0", "생성 N개"만으로 설치 의미를 설명하지 않는다.
- 선택지 라벨은 사용자가 선택한 뒤 일어날 행동을 한국어로 쓴다.
- 내부 명령, 전체 파일 수, 원시 JSON은 사용자가 상세 진단을 요청한 경우에만 보여준다.
- 질문은 아래 표현을 기본으로 사용하고, 프로젝트 상황에 맞는 짧은 설명만 덧붙인다.

선택 기능 질문:

| 헤더 | 질문 | 첫 번째 선택 | 두 번째 선택 |
|---|---|---|---|
| 협업 방식 | Codex와 작업 일지를 공유할까요? | Claude + Codex | Claude만 사용 |
| 코드 검토 | 전문 코드 리뷰 에이전트 5개를 함께 설치할까요? | 설치 안 함 | 설치하기 |

각 선택지 설명에는 기능의 효과와 비용을 한 문장으로 적는다. `Codex` 같은 구현 이름은 설명 끝의 괄호에만 적는다.

`/aside`, `/checkpoint` 명령은 선택 기능과 상관없이 항상 설치된다.

`new`, `migrate`, `upgrade`는 설치기의 내부 분기다. 이 영문 값을 사용자에게 선택지로 보여주거나 "설치 모드"를 고르라고 묻지 않는다. 표시 이름과 슬러그를 모두 사용자에게 받은 뒤 저장소 상태로 다음처럼 자동 판정한다.

`docs/`라는 이름만으로 "옛 하네스 볼트"라고 단정하지 않는다. 설치기는 `docs/worklog.md`와
`docs/rules.md`가 함께 있을 때만 이 스킬이 만든 볼트(하네스 볼트)로 본다. API 문서처럼
무관한 `docs/` 폴더는 아래 표에서 "없음"과 동일하게 취급한다.

| 저장소 상태 | 사용자에게 설명할 말 | 내부 값 | 처리 |
|---|---|---|---|
| 하네스 볼트인 `docs/`도, `<slug>-docs/`도 없음 | 처음 설치 | `new` | 무관한 `docs/`가 있어도 그대로 두고 계획을 만든다 |
| 하네스 볼트인 `docs/`만 있음 | 기존 문서 폴더 옮기기 | `migrate` | "기존 docs 폴더를 <slug>-docs로 이름을 바꾸고 내용 그대로 옮길까요?"라고 확인한다 |
| `<slug>-docs/`만 있음(무관한 `docs/` 공존 포함) | 현재 설치 보완 | `upgrade` | 별도 모드 질문 없이 계획을 만든다 |
| 하네스 볼트인 `docs/`와 `<slug>-docs/`가 모두 있음 | 문서 폴더 충돌 | 없음 | 어느 쪽도 변경하지 말고 사용자에게 정리를 요청한다 |

`package.json`의 존재 여부는 이 판정 기준이 아니다. 기존 문서 이동 확인의 선택지는 "옮기기"와 "중단"처럼 행동이 드러나는 말로 쓴다.

## 프로젝트 설치

현재 디렉터리가 대상 Git 저장소 루트인지 확인한다. 다음 명령의 옵션은 질문 결과에 맞춰 구성한다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" plan \
  --repo "$PWD" \
  --project-name "표시 이름" \
  --slug "project-slug" \
  --mode "자동 판정한 내부 값" \
  --codex \
  --reviewers
```

선택하지 않은 `--codex`, `--reviewers`는 넣지 않는다. 계획에 충돌이 하나라도 있으면 `apply`를 실행하지 말고 충돌 파일과 필요한 수동 병합을 사용자에게 보여준다.

**충돌이 git 훅 경로(`core.hooksPath`가 이미 다른 곳을 가리킴)나 npm 스크립트 이름 겹침뿐이면**,
바로 수동 병합을 요구하지 말고 먼저 이렇게 물어본다: "이 저장소는 이미 다른 git 훅
설정(또는 스크립트 이름)을 쓰고 있습니다. 그 부분만 빼고 나머지만 설치할까요?" 동의하면
`--no-githooks`(git 훅 설치를 건너뜀)나 `--keep-existing-scripts`(겹치는 npm 스크립트는
기존 것을 유지)를 붙여 다시 `plan`한다. 두 옵션 모두 그 부분을 아예 설치하지 않는 것이므로,
설치 뒤 확인 요약에도 "git 훅: 건너뜀" 또는 "일부 스크립트: 기존 유지"처럼 빠졌다는 사실을 남긴다.

설치기의 `plan` 결과를 원시 JSON으로 보여주지 않는다. 사용자가 상세 진단을 요청하면 결과의
`fileList`(파일별 경로와 create/update/skip/conflict 상태)를 보여준다. 그 외에는 충돌이
없으면 다음 항목만 쉬운 말로 요약한다.

```text
문서 폴더: <slug>-docs
협업: Claude + Codex 또는 Claude만 사용
코드 리뷰: 설치 또는 설치 안 함
기존 파일 충돌: 없음
```

요약을 보여준 뒤 `AskUserQuestion`을 한 질문만 담아 호출한다.

```text
헤더: 설치 확인
질문: 위 구성으로 하네스를 설치할까요?
선택 1: 설치하기
설명: 위 구성대로 파일을 만들고 설정을 연결합니다.
선택 2: 구성 바꾸기
설명: 선택 단계로 돌아가 포함할 기능을 다시 정합니다.
선택 3: 취소
설명: 아무 파일도 변경하지 않고 설치를 끝냅니다.
```

- `설치하기`를 선택한 경우에만 같은 옵션으로 내부 `apply` 명령을 실행한다.
- `구성 바꾸기`를 선택하면 바꿀 항목을 묻고 다시 계획한 뒤 설치 확인을 새로 받는다.
- `취소`를 선택하면 어떤 파일도 변경하지 않고 끝낸다.
- UI의 `Type something`에 입력된 내용은 구성 변경 요청으로 처리한다. 내용을 반영해 다시 계획하고 설치 확인을 새로 받으며, 바로 `apply`하지 않는다.
- 질문과 선택지에 `적용`, `apply 진행`, `계획이 깨끗함` 같은 구현 표현을 쓰지 않는다.

설치기의 내부 실행 명령은 다음과 같지만, 사용자에게 명령 선택을 요구하지 않는다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" apply ...
```


## 설치 뒤 확인

사용자가 `설치하기`를 선택해 설치가 끝난 뒤에만 다음을 실행한다.

```bash
node --check scripts/worklog.mjs
node --check scripts/worklog-hook.mjs
node --check scripts/tasks.mjs
node --check scripts/wiki-lib.mjs
node --check scripts/wiki-links.mjs
node --check scripts/wiki-context.mjs
node --check scripts/wiki-hook.mjs
node --check scripts/wiki.mjs
node --check scripts/memory-hook.mjs
node --check scripts/memory.mjs
node --check scripts/code.mjs
node scripts/tasks.mjs init
node scripts/worklog.mjs append claude "하네스 세팅" "orbit:setup으로 설치하고 스모크 테스트"
node scripts/tasks.mjs list
npm run wiki:check
```

`.claude/settings.json`에서 `worklog-hook.mjs begin`이 `UserPromptSubmit`(SessionStart 아님)에 배선됐는지, PostToolUse·Stop 훅이 함께 남았는지 확인한다. `git config core.hooksPath`가 기존 사용자 훅을 가리키면 설치기는 중단해야 하며 강제로 바꾸지 않는다 — 이때 "프로젝트 설치" 절의 흐름대로 `--no-githooks`를 물어본다.

설치 요약의 `codeTools.status`를 확인한다. `installed`·`present`면 코드 개요가 동작한다. `failed`면 조용히 넘어가지 말고 사용자에게 알린다: 코드 개요·펼치기와 큰 파일 읽기 안내가 동작하지 않는다는 것, 원인(`codeTools.error`), 다시 받는 명령(`node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" code-tools`). 나머지 설치는 정상이다.

`.claude/orbit-manifest.json`은 설치기가 자동으로 생성·갱신하는 소유 기록(파일 해시·설치 모듈 구성)이다. 커밋 대상이며, 손으로 고치거나 지우지 않는다.

첫 커밋은 설치 결과를 사용자에게 보고하고 별도 승인을 받은 뒤에만 한다. 스킬 자신의 배포(플러그인 릴리스)는 이 설치 흐름의 범위가 아니다(별도 관리 절차에서 다룬다).
