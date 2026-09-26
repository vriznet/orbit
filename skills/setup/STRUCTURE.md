# orbit:setup 레포 구조 — 폴더·파일 역할 안내

이 폴더는 **orbit:setup 스킬 하나**다. orbit 저장소(플러그인+마켓플레이스) 안 `skills/setup/`에 살고, 이 폴더가 스킬 루트(=`SKILL.md`·`scripts/`·`assets/`의 기준)다.

## 가장 중요한 구분: "설치기" vs "설치될 원본(assets)"

이 레포에는 비슷해 보이는 게 두 벌 있어 헷갈리기 쉽다. 먼저 이 층부터 이해하면 나머지가 쉽다.

| 층 | 위치 | 무엇인가 |
|---|---|---|
| **설치기(스킬 자체)** | 루트의 `SKILL.md`, `scripts/` | 설치를 **수행하는** 도구. 대상 저장소에 복사되지 않는다. |
| **설치될 원본** | `assets/` 아래 전부 | 설치기가 **대상 저장소로 복사하는** 내용. 설치 결과물의 원본. |

그래서 `scripts/install.mjs`(설치기)와 `assets/scripts/worklog.mjs`(설치되면 대상 저장소의
`scripts/worklog.mjs`가 되는 것)는 **완전히 다른 것**이다. 전자는 설치를 돌리고, 후자는 설치가
끝난 프로젝트에서 매일 쓰는 도구다.

---

## 1. 루트 파일

| 파일 | 역할 |
|---|---|
| `SKILL.md` | **스킬의 지침("뇌")**. `/orbit:setup` 호출 시 Claude Code가 이 파일을 에이전트 맥락에 로드한다. 무엇을 묻고, 어떤 순서로 설치하고, 결과를 어떻게 보고할지가 적혀 있다. 프론트매터의 `name:`이 슬래시 명령 이름이다. |
| `README.md` | 사람이 읽는 저장소 소개 + 다른 맥에 설치·테스트하는 법. |
| `STRUCTURE.md` | (이 문서) 폴더·파일 역할 안내. |
| `.gitignore` | git 무시 목록(`.DS_Store` 등). |

## 2. `scripts/` — 설치기 로직 (스킬 자체, 대상에 복사 안 됨)

| 파일 | 역할 |
|---|---|
| `install.mjs` | **핵심 설치기**. `plan`(무엇을 만들지 계산·충돌 점검)과 `apply`(실제 설치)를 수행한다. 파일 해시로 소유·변경을 판정하고, 훅 병합·매니페스트 기록·안전한 롤백을 담당한다. |
| `test-install.sh` | **회귀 테스트 스위트**. 신규 설치·마이그레이션·업그레이드·충돌 감지·원장 동시성 등 과거 결함이 재발하지 않는지 확인한다. 설치 절차가 아니라 스킬을 고친 뒤 사람이 돌려 확인하는 용도. |

## 3. `assets/` — 대상 저장소에 설치될 원본

설치기가 이 아래 파일들을 대상 저장소로 복사한다. 슬러그·경로 자리표시자는 설치 시 치환된다.

### 3.1 루트 템플릿

| 파일 | 설치되면 | 역할 |
|---|---|---|
| `CLAUDE.md.tmpl` | 대상 `CLAUDE.md` | Claude용 프로젝트 지침(지식 맵·규칙 진입점). |
| `AGENTS.md.tmpl` | 대상 `AGENTS.md` | Codex용 진입점(선택: Codex 협업 시). |
| `package.json.tmpl` | 대상 `package.json`(병합) | `wiki:check` 등 npm 스크립트 등록용. |

### 3.2 `assets/scripts/` — 설치 후 대상 저장소의 하네스 도구

설치되면 대상 저장소의 `scripts/`가 된다. 프로젝트에서 매일 쓰는 원장·위키·협업 도구다.

| 파일 | 역할 |
|---|---|
| `worklog.mjs` | 작업 일지 CLI(append/summary/found/catchup/recent). 세션·에이전트 사이 턴 기록. append의 선택 칸 `--why`(판단)·`--found`(발견), 이미 쓴 항목에 발견을 덧붙이는 `found`. `catchup`은 작성자 이름별 책갈피로 따라잡기(소비), `recent`는 최근 8턴과 그 앞 구간 요약을 주입하는 읽기 전용 명령(`--mode compact`면 머리글 '컴팩션 전 기록'). |
| `worklog-hook.mjs` | 세션·턴 상태 훅. 매 턴 일지 미기록을 감지하고 종료를 막는다(begin/stop). 도구를 많이 쓴 턴에 '발견' 칸이 비면 한 번 알린다. |
| `memory-hook.mjs` | 기억 훅: precompact(상태 파일), compact-restore(SessionStart compact 주입), postcompact(요약 저장), turn-start(git 지문), stop(대화 글 사본·도구 색인), pre-tool(파일별 기억 목록·큰 파일 개요 안내). |
| `memory-lib.mjs` | 기억 훅 공용: 세션 기록 파서, 상태 폴더, 잠금, git 지문, 저장소 상대 경로, 기억 번호. |
| `memory.mjs` | 기억 CLI: `search`(ADR·위키·worklog·대화 사본·도구 활동, 번호 목록), `show <번호>`, `forget <문구> [--apply]`(/forget 스킬이 부름). |
| `redact.mjs` | 기억 파일에 넣기 전 알려진 모양의 비밀값을 가린다. |
| `code.mjs` | 코드 개요·펼치기(`outline`/`unfold`). tree-sitter WASM은 설치 때 `~/.cache/orbit/code-tools/`에 받는다. |
| `tasks.mjs` | GTD 할일 원장 CLI(add/list/review/done/drop/edit). ID는 `T-슬러그-YYMMDD-HHMMSS`. `drop <id> --reason`은 이유가 사라진 할일을 완료와 구분해 취소 아카이브로 보낸다. |
| `wiki.mjs` | 위키 노트 CRUD(new/list/show/set/rename/rm). |
| `wiki-lib.mjs` | 위키 공통 라이브러리(파싱·프론트매터 등). |
| `wiki-links.mjs` | 위키 링크·스키마 검사기(`wiki:check`), 안전한 자동 연결. |
| `wiki-context.mjs` | ADR에서 연결된 문서를 예산 안에서 골라 맥락 목록을 만든다. |
| `wiki-hook.mjs` | Write/Edit 후·세션 종료 시 위키 링크를 검사하는 훅(post/stop). |
| `worktree-merge-inspect.mjs` | 병렬 워크트리 병합 시 공유 원장 충돌을 진단한다. |
| `claude-catchup.sh` | Claude 세션 시작 시 일지 따라잡기 주입. |
| `codex-catchup.sh` | Codex 세션 시작 시 일지 따라잡기 주입(선택: Codex). |

### 3.3 `assets/claude/` — 대상 저장소의 `.claude/` 원본

| 경로 | 역할 |
|---|---|
| `settings.hooks.base.json` | **항상** 설치되는 훅 배선(SessionStart 두 갈래·UserPromptSubmit·PreToolUse·PostToolUse·PreCompact·PostCompact·Stop → worklog·memory·wiki 훅). 설치기가 대상 `settings.json`에 병합한다. |
| `agents/context-reader.md` | **항상** 설치. ADR 맥락을 제한 범위로 읽어 보고하는 서브에이전트. |
| `agents/recall-searcher.md` | **항상** 설치. `/recall`이 부르는 기억 검색 서브에이전트(Sonnet 고정, 읽기 전용). |
| `agents/database-reviewer.md` 외 4개 | **선택(리뷰어)**. 코드 리뷰 전문 에이전트 5종(database·react·security·silent-failure·typescript). |
| `commands/aside.md`, `checkpoint.md` | **항상** 설치되는 일반 슬래시 명령. |
| `skills/decision-context/` | **항상** 설치. ADR 기반 제한 맥락 수집 스킬(+`agents/openai.yaml`). |
| `skills/worktree-merge/SKILL.md` | **항상** 설치. 워크트리 병합 시 원장 충돌 처리 스킬. |
| `skills/recall/SKILL.md` | **항상** 설치. 옛 결정·이유·대화를 찾는 스킬(사용자·모델 모두 호출). |
| `skills/forget/SKILL.md` | **항상** 설치. `/forget <문구>`로만 부르는 기억 지우기 스킬(모델 자동 호출 끔). |

### 3.4 `assets/docs/` — 문서 볼트 스캐폴딩

설치되면 대상의 `<slug>-docs/`가 된다(빈 뼈대).

| 파일 | 역할 |
|---|---|
| `rules.md` | 글쓰기·자기검증·ADR/할일 감지·커밋 규칙 상세. |
| `backlog.md` | 조건부·미착수 작업 원장(트리거→무엇). |
| `open-questions.md` | 미해결 질문·상시 리스크 원장. |
| `decisions/README.md` | ADR 인덱스(빈 뼈대). |
| `templates/adr.md` | 새 ADR 작성 템플릿(`D-슬러그-YYMMDD-HHMMSS`). |
| `templates/wiki.md` | 새 위키 노트 템플릿. |
| `templates/worklog.md` | worklog 턴·요약 항목 양식. |
| `templates/backlog.md` | backlog 트리거 항목 양식. |
| `templates/subagent-brief.md` | 서브에이전트 위임 글 양식(클린 모드의 유일한 맥락). |
| `wiki/_index.md` | 위키 진입점. |
| `wiki/_schema.md` | 위키 노트 스키마·갱신 기준. |

### 3.5 `assets/githooks/commit-msg`

설치되면 대상 `.githooks/commit-msg`. 커밋 메시지에 `Decision:` 트레일러가 있는데 실제
`decisions/` 변경이 없으면 경고하는 git 훅.


### 3.7 `assets/legacy/` — 마이그레이션 감지용 옛 버전

옛 하네스가 설치했던 파일들의 이전 세대 사본(`CLAUDE.md.tmpl`, `docs/*`, `scripts/*` 등).
설치기는 대상의 기존 파일이 **이 옛 버전과 같으면** "하네스가 만든 것"으로 인정해 안전하게
업데이트한다(사용자 수정본과 구분하기 위한 기준). 대상에 새로 복사되지는 않는다.

---

## 모듈별 설치 여부 요약

- **항상 설치**: `scripts/`의 원장·위키·기억·코드 도구, `settings.hooks.base`, `context-reader`·`recall-searcher`,
  `aside`·`checkpoint`, `decision-context`, `worktree-merge`, `recall`, `forget`, `docs/` 스캐폴딩,
  `githooks/commit-msg`. 코드 도구(tree-sitter WASM)는 저장소 밖 `~/.cache/orbit/code-tools/`에 받는다.
- **선택 — Codex**: `AGENTS.md`, `codex-catchup.sh`.
- **선택 — 리뷰어**: `agents/`의 리뷰어 5종.

---

## 한눈에 흐름

1. 사용자가 대상 저장소에서 `/orbit:setup` 호출 → Claude Code가 `SKILL.md` 로드.
   에이전트가 먼저 git·Node.js가 있는지 확인한다(없으면 설치를 안내하고, 거부하면 취소).
2. 에이전트가 `SKILL.md` 지침대로 `scripts/install.mjs plan` 실행 → 만들 파일과 충돌 계산.
3. 사용자 확인 후 `apply` → `assets/`의 해당 파일들을 대상 저장소로 복사·병합, 매니페스트 기록.
4. 이후 그 저장소에서는 설치된 `scripts/`·훅·`docs/`가 매일 하네스로 동작한다.
