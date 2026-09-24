# orbit:setup (skill)

orbit 플러그인이 배포하는 설치 스킬의 개발 홈. orbit 저장소 안에서 `skills/setup/`에 산다.

## 구조

- `SKILL.md` — 스킬 지침("뇌"). 설치 절차·질문·보고 규칙.
- `scripts/install.mjs` — 설치기(plan/apply/update).
- `scripts/test-install.sh` — 회귀 테스트.
- `assets/` — 대상 저장소에 복사될 원본(문서 템플릿·훅 스니펫·에이전트·커맨드·githooks).

## 회귀 테스트

```bash
bash skills/setup/scripts/test-install.sh
```

## 로컬 시험

```bash
# 이 저장소를 로컬 마켓플레이스로 등록한 뒤 플러그인 설치
claude plugin marketplace add /path/to/orbit

# 또는 개발용 사본으로 /setup-dev 슬래시 시험
cp -R skills/setup ~/.claude/skills/setup-dev
```

## 불변 원칙

- 설치기는 대상 저장소 안만 건드린다. 전역 설정·플러그인은 건드리지 않는다.
- 스킬 자신의 배포는 플러그인 릴리스 흐름으로만 한다(설치기가 자기 자신을 승격하지 않는다).
