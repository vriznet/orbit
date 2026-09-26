#!/usr/bin/env bash
# orbit:setup 회귀 테스트 — install.mjs·원장 스크립트가
# 과거 결함 검토에서 고친 동작을
# 계속 지키는지 확인한다.
#
# 실행: bash ~/.claude/skills/setup/scripts/test-install.sh
# 이 스크립트는 설치 절차의 일부가 아니다 — 스킬을 고친 뒤 사람이 직접 돌려서 확인하는 용도다.

set -uo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
FAIL=0

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAIL=1; }

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

new_repo() {
  local dir="$1"
  mkdir -p "$dir" && (cd "$dir" && git init -q .)
}

echo "== 시나리오 1: 새로 설치 =="
R1="$WORK/scenario1"
new_repo "$R1"
PLAN1="$(node "$SKILL_DIR/scripts/install.mjs" plan --repo "$R1" --project-name "Scenario1" --slug scenario1 --mode new 2>&1)"
CONFLICTS1="$(echo "$PLAN1" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['conflicts']))" 2>/dev/null || echo "err")"
[ "$CONFLICTS1" = "0" ] && pass "plan 충돌 0" || fail "plan 충돌 감지 실패 (got: $CONFLICTS1)"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R1" --project-name "Scenario1" --slug scenario1 --mode new >/dev/null 2>&1
if [ $? -eq 0 ]; then pass "apply 성공"; else fail "apply 실패"; fi
CHECK_OK=1
for f in worklog.mjs worklog-hook.mjs tasks.mjs wiki-lib.mjs wiki-links.mjs wiki-context.mjs wiki-hook.mjs wiki.mjs; do
  node --check "$R1/scripts/$f" >/dev/null 2>&1 || CHECK_OK=0
done
[ "$CHECK_OK" = "1" ] && pass "설치된 스크립트 8종 node --check 통과" || fail "설치된 스크립트 문법 오류"

echo "== 시나리오 2: 옮기기(migrate) 무경고 덮어쓰기 회귀 =="
R2="$WORK/scenario2"
new_repo "$R2"
mkdir -p "$R2/docs"
echo "CUSTOM CONTENT - must not be lost" > "$R2/docs/rules.md"
echo "worklog" > "$R2/docs/worklog.md"
PLAN2="$(node "$SKILL_DIR/scripts/install.mjs" plan --repo "$R2" --project-name "Scenario2" --slug scenario2 --mode migrate 2>&1)"
CONFLICTS2="$(echo "$PLAN2" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['conflicts']))" 2>/dev/null || echo "err")"
if [ "$CONFLICTS2" != "0" ] && [ "$CONFLICTS2" != "err" ]; then pass "customized docs/rules.md 충돌 감지됨 (${CONFLICTS2}건)"; else fail "충돌 감지 실패 — migrate가 다시 무경고 덮어쓸 위험 (got: $CONFLICTS2)"; fi
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R2" --project-name "Scenario2" --slug scenario2 --mode migrate >/dev/null 2>&1
if [ $? -ne 0 ]; then pass "apply가 충돌로 거부됨"; else fail "apply가 충돌에도 진행됨"; fi
if grep -q "CUSTOM CONTENT" "$R2/docs/rules.md" 2>/dev/null; then pass "원본 docs/rules.md 보존됨"; else fail "원본 내용이 사라짐(데이터 손실)"; fi

echo "== 시나리오 3: 무관한 docs/ 공존 =="
R3="$WORK/scenario3"
new_repo "$R3"
mkdir -p "$R3/docs"
echo "# unrelated api docs" > "$R3/docs/api.md"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R3" --project-name "Scenario3" --slug scenario3 --mode new >/dev/null 2>&1
if [ $? -eq 0 ]; then pass "무관한 docs/가 있어도 new 설치 성공"; else fail "무관한 docs/ 때문에 설치가 막힘"; fi
if [ -f "$R3/docs/api.md" ] && grep -q "unrelated api docs" "$R3/docs/api.md"; then pass "무관한 docs/api.md 그대로 보존"; else fail "무관한 docs/ 내용이 변경됨"; fi

echo "== 시나리오 4: 보완 설치(upgrade) 재실행 =="
R4="$WORK/scenario4"
new_repo "$R4"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R4" --project-name "Scenario4" --slug scenario4 --mode new >/dev/null 2>&1
BEFORE_HOOKS="$(cat "$R4/.claude/settings.json")"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R4" --project-name "Scenario4" --slug scenario4 --mode upgrade >/dev/null 2>&1
AFTER_HOOKS="$(cat "$R4/.claude/settings.json")"
if [ "$BEFORE_HOOKS" = "$AFTER_HOOKS" ]; then pass "재실행해도 settings.json 훅 중복 없음"; else fail "재실행 시 settings.json이 바뀜(중복 가능성)"; fi

echo "== 시나리오 5: 부분 설치(--no-githooks) =="
R5="$WORK/scenario5"
new_repo "$R5"
(cd "$R5" && git config core.hooksPath .husky)
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R5" --project-name "Scenario5" --slug scenario5 --mode new --no-githooks >/dev/null 2>&1
if [ $? -eq 0 ]; then pass "hooksPath 선점 상태에서 --no-githooks 설치 성공"; else fail "--no-githooks가 있어도 설치 실패"; fi
CURRENT_HOOKS_PATH="$(cd "$R5" && git config --get core.hooksPath)"
[ "$CURRENT_HOOKS_PATH" = ".husky" ] && pass "기존 core.hooksPath(.husky) 보존" || fail "core.hooksPath가 임의로 바뀜"

echo "== 시나리오 6: 원장 동시 실행(잠금) =="
# 실사용은 Claude·Codex 2~3개가 동시에 도는 정도다. 15+15=30은 그보다 10배 과한
# 부하로 잠금 로직을 검증하기엔 충분하다 — 이보다 훨씬 큰(50+50=100 이상) 동시성은
# 공유 개발 머신의 프로세스·fd 자원을 불필요하게 소모해 테스트 자체가 흔들릴 수 있다
# (2026-07-30 검증 중 확인: 100way 스트레스에서 디버깅 스크립트 자체의 자원 고갈로
# $SKILL_DIR 등 셸 변수가 오염되는 무관한 잡음을 겪었다 — 실제 잠금 로직 결함은 아니었음).
R6="$WORK/scenario6"
new_repo "$R6"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R6" --project-name "Scenario6" --slug scenario6 --mode new >/dev/null 2>&1
(cd "$R6" && node scripts/tasks.mjs init >/dev/null 2>&1)
for i in $(seq 1 15); do (cd "$R6" && node scripts/tasks.mjs add "concA-$i" --owner ai --action someday --urgency low --source test >/dev/null 2>&1) & done
for i in $(seq 1 15); do (cd "$R6" && node scripts/tasks.mjs add "concB-$i" --owner both --action someday --urgency low --source test >/dev/null 2>&1) & done
wait
OPEN_COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$R6/scenario6-docs/tasks.json','utf8')).open.length)" 2>/dev/null || echo "err")"
[ "$OPEN_COUNT" = "30" ] && pass "동시 30건 add 모두 보존" || fail "동시 실행에서 유실 발생 (got: $OPEN_COUNT / 기대 30)"

echo "== 시나리오 7: 훅 배선(begin이 UserPromptSubmit에만) =="
R7="$WORK/scenario7"
new_repo "$R7"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R7" --project-name "Scenario7" --slug scenario7 --mode new >/dev/null 2>&1
BEGIN_IN_SESSIONSTART="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R7/.claude/settings.json','utf8'));
const has = (arr) => (arr||[]).some((g) => (g.hooks||[]).some((h) => (h.args||[]).join(' ').includes('worklog-hook.mjs\" begin')));
console.log(has(s.hooks.SessionStart) ? 'yes' : 'no');
")"
BEGIN_IN_UPS="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R7/.claude/settings.json','utf8'));
const has = (arr) => (arr||[]).some((g) => (g.hooks||[]).some((h) => (h.args||[]).join(' ').includes('worklog-hook.mjs\" begin')));
console.log(has(s.hooks.UserPromptSubmit) ? 'yes' : 'no');
")"
if [ "${BEGIN_IN_SESSIONSTART}" = "no" ] && [ "${BEGIN_IN_UPS}" = "yes" ]; then
  pass "begin이 UserPromptSubmit에만 배선됨"
else
  fail "begin 배선 위치 오류 (SessionStart=${BEGIN_IN_SESSIONSTART} UPS=${BEGIN_IN_UPS})"
fi
HOOK_EVENT="$(cd "$R7" && echo '{"session_id":"s7"}' | node scripts/worklog-hook.mjs begin | python3 -c "import json,sys; print(json.load(sys.stdin)['hookSpecificOutput']['hookEventName'])" 2>/dev/null || echo err)"
[ "${HOOK_EVENT}" = "UserPromptSubmit" ] && pass "begin 출력 hookEventName=UserPromptSubmit" || fail "hookEventName 불일치: ${HOOK_EVENT}"
rm -rf "$R7/.git/orbit-state" 2>/dev/null

echo "== 시나리오 8: 턴 수명주기(카운터·토큰·차단·자동복구) =="
R8="$WORK/scenario8"
new_repo "$R8"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R8" --project-name "Scenario8" --slug scenario8 --mode new >/dev/null 2>&1
SID8="s8-session"
SECRET8="비밀프롬프트원문-XYZ789"
STATE_FILE8="$R8/.git/orbit-state/worklog/${SID8}.json"

BEGIN8_1="$(cd "$R8" && printf '{"session_id":"%s","prompt":"%s"}' "${SID8}" "${SECRET8}" | node scripts/worklog-hook.mjs begin)"
TOKEN8_1="$(echo "${BEGIN8_1}" | python3 -c "import json,sys,re; d=json.load(sys.stdin); print(re.search(r'--turn-token \"([0-9a-f]+)\"', d['hookSpecificOutput']['additionalContext']).group(1))" 2>/dev/null || echo "")"
COUNTER8_1="$(python3 -c "import json; print(json.load(open('${STATE_FILE8}'))['counter'])" 2>/dev/null || echo err)"
[ "${COUNTER8_1}" = "1" ] && pass "begin 1회차: counter=1" || fail "counter 초기값 이상 (got ${COUNTER8_1})"

BEGIN8_2="$(cd "$R8" && printf '{"session_id":"%s","prompt":"%s"}' "${SID8}" "${SECRET8}" | node scripts/worklog-hook.mjs begin)"
TOKEN8_2="$(echo "${BEGIN8_2}" | python3 -c "import json,sys,re; d=json.load(sys.stdin); print(re.search(r'--turn-token \"([0-9a-f]+)\"', d['hookSpecificOutput']['additionalContext']).group(1))" 2>/dev/null || echo "")"
COUNTER8_2="$(python3 -c "import json; print(json.load(open('${STATE_FILE8}'))['counter'])" 2>/dev/null || echo err)"
if [ "${COUNTER8_2}" = "2" ] && [ -n "${TOKEN8_1}" ] && [ -n "${TOKEN8_2}" ] && [ "${TOKEN8_1}" != "${TOKEN8_2}" ]; then
  pass "begin 2회: counter 1→2, 토큰 상이"
else
  fail "counter/토큰 이상 (counter=${COUNTER8_2} t1=${TOKEN8_1} t2=${TOKEN8_2})"
fi

(cd "$R8" && node scripts/worklog.mjs append claude "옛토큰시도" "옛토큰결과" --session-id "${SID8}" --turn-token "${TOKEN8_1}" >/dev/null 2>&1)
STOPDECISION8="$(cd "$R8" && echo "{\"session_id\":\"${SID8}\"}" | node scripts/worklog-hook.mjs stop | python3 -c "import json,sys; print(json.load(sys.stdin).get('decision',''))" 2>/dev/null || echo err)"
[ "${STOPDECISION8}" = "block" ] && pass "옛 토큰 append 후에도 Stop이 차단됨" || fail "옛 토큰이 턴을 완료 처리함(Stop 미차단, got: ${STOPDECISION8})"

(cd "$R8" && echo "{\"session_id\":\"${SID8}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop >/dev/null 2>&1)
if grep -q "자동 복구" "$R8/scenario8-docs/worklog.md" 2>/dev/null; then
  if grep -q "${SECRET8}" "$R8/scenario8-docs/worklog.md" "${STATE_FILE8}" 2>/dev/null; then
    fail "프롬프트 원문이 worklog나 상태 파일에 남아 있음(H09 회귀)"
  else
    pass "자동 복구 항목 생성 + 프롬프트 원문 미기록"
  fi
else
  fail "자동 복구 항목이 생성되지 않음"
fi

(cd "$R8" && echo "{\"session_id\":\"${SID8}\"}" | node scripts/worklog-hook.mjs begin >/dev/null 2>&1)
COUNTER8_3="$(python3 -c "import json; print(json.load(open('${STATE_FILE8}'))['counter'])" 2>/dev/null || echo err)"
[ "${COUNTER8_3}" = "3" ] && pass "복구 후 begin → counter 3(리셋 안 됨)" || fail "counter가 리셋됨(got ${COUNTER8_3})"

# S8 보완: 구버전 스키마(pending 불리언) 상태 파일 마이그레이션 — 업그레이드된 저장소의
# 활성 세션이 "턴 #undefined" 차단을 겪지 않아야 한다.
OLD_STATE8="$R8/.git/orbit-state/worklog/oldschema.json"
printf '{"sessionId":"oldschema","turn":4,"pending":true,"prompt":"","startedAt":"2026-01-01T00:00:00.000Z"}\n' > "${OLD_STATE8}"
OLDOUT8="$(cd "$R8" && echo '{"session_id":"oldschema"}' | node scripts/worklog-hook.mjs stop)"; OLDRC8=$?
OLDPENDING8="$(python3 -c "import json; print(json.load(open('${OLD_STATE8}'))['pending'])" 2>/dev/null || echo err)"
OLDCOUNTER8="$(python3 -c "import json; print(json.load(open('${OLD_STATE8}'))['counter'])" 2>/dev/null || echo err)"
if [ "${OLDRC8}" = "0" ] && [ -z "${OLDOUT8}" ] && [ "${OLDPENDING8}" = "None" ] && [ "${OLDCOUNTER8}" = "4" ]; then
  pass "구버전 스키마 상태 → 무차단 통과·counter 4 승계 마이그레이션"
else
  fail "구버전 스키마 마이그레이션 실패 (rc=${OLDRC8} out=${OLDOUT8} pending=${OLDPENDING8} counter=${OLDCOUNTER8})"
fi

echo "== 시나리오 9: 버전 업그레이드(매니페스트 해시로 이전 산출물 인식, H02 회귀) =="
R9="$WORK/scenario9"
new_repo "$R9"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R9" --project-name "Scenario9" --slug scenario9 --mode new >/dev/null 2>&1
SKILL_COPY9="$WORK/skillcopy9"
cp -R "$SKILL_DIR" "$SKILL_COPY9"
{ echo ""; echo "<!-- v-next marker -->"; } >> "$SKILL_COPY9/assets/CLAUDE.md.tmpl"
PLAN9="$(node "$SKILL_COPY9/scripts/install.mjs" plan --repo "$R9" --project-name "Scenario9" --slug scenario9 --mode upgrade 2>&1)"
CONFLICTS9="$(echo "${PLAN9}" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['conflicts']))" 2>/dev/null || echo err)"
[ "${CONFLICTS9}" = "0" ] && pass "스킬 템플릿 갱신(버전업) → 충돌 0" || fail "정상 버전업인데 충돌 발생 (got: ${CONFLICTS9})"
node "$SKILL_COPY9/scripts/install.mjs" apply --repo "$R9" --project-name "Scenario9" --slug scenario9 --mode upgrade >/dev/null 2>&1
grep -q "v-next marker" "$R9/CLAUDE.md" && pass "새 템플릿 내용이 실제로 반영됨" || fail "apply 후에도 새 내용이 반영 안 됨"

echo "USER EDIT" >> "$R9/CLAUDE.md"
PLAN9B="$(node "$SKILL_COPY9/scripts/install.mjs" plan --repo "$R9" --project-name "Scenario9" --slug scenario9 --mode upgrade 2>&1)"
CONFLICTS9B="$(echo "${PLAN9B}" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['conflicts']))" 2>/dev/null || echo err)"
if [ "${CONFLICTS9B}" != "0" ] && [ "${CONFLICTS9B}" != "err" ]; then
  pass "사용자가 고친 파일은 충돌로 감지됨"
else
  fail "사용자 수정이 충돌로 감지되지 않음(H02 계열 회귀, got: ${CONFLICTS9B})"
fi

echo "== 시나리오 10: 훅 교체(타임아웃 변경 후 업그레이드 → 중복 없음, H03 회귀) =="
R10="$WORK/scenario10"
new_repo "$R10"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R10" --project-name "Scenario10" --slug scenario10 --mode new >/dev/null 2>&1
node -e "
const fs=require('fs');
const f='$R10/.claude/settings.json';
const s=JSON.parse(fs.readFileSync(f,'utf8'));
s.hooks.Stop[1].hooks[0].timeout = 999;
fs.writeFileSync(f, JSON.stringify(s,null,2)+'\n');
"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R10" --project-name "Scenario10" --slug scenario10 --mode upgrade >/dev/null 2>&1
DUP_CHECK10="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R10/.claude/settings.json','utf8'));
function countOwned(arr, marker) {
  return (arr||[]).reduce((acc,g)=>acc+(g.hooks||[]).filter((h)=>(h.args||[]).join(' ').includes(marker)).length, 0);
}
console.log(countOwned(s.hooks.Stop, 'worklog-hook.mjs\" stop'));
")"
[ "${DUP_CHECK10}" = "1" ] && pass "타임아웃 변경 후 업그레이드해도 핸들러 중복 없음(정확히 1개)" || fail "핸들러가 중복됨 (got: ${DUP_CHECK10})"
TIMEOUT_RESTORED10="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R10/.claude/settings.json','utf8'));
const g = s.hooks.Stop.find((g) => (g.hooks||[]).some((h) => (h.args||[]).join(' ').includes('worklog-hook.mjs\" stop')));
console.log(g.hooks[0].timeout);
")"
[ "${TIMEOUT_RESTORED10}" = "10" ] && pass "타임아웃이 최신 배선으로 교체됨" || fail "타임아웃이 교체되지 않음 (got: ${TIMEOUT_RESTORED10})"

echo "== 시나리오 13: 설치 롤백(중간 실패 시 전체 원복, H07 회귀) =="
R13="$WORK/scenario13"
new_repo "$R13"
mkdir -p "$R13/.claude"
mkdir "$R13/.claude/orbit-manifest.json" # 파일이 있어야 할 자리를 디렉터리로 막아 마지막 단계(매니페스트 쓰기)에서 실패를 유도
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R13" --project-name "Scenario13" --slug scenario13 --mode new >/dev/null 2>&1
APPLY13_CODE=$?
[ "${APPLY13_CODE}" = "2" ] && pass "매니페스트 쓰기 실패 시 apply가 실패로 종료(exit 2)" || fail "apply가 실패하지 않음(got ${APPLY13_CODE})"
[ ! -f "$R13/scripts/worklog.mjs" ] && pass "롤백: scripts/worklog.mjs 생성되지 않음(원복됨)" || fail "롤백 실패: scripts/worklog.mjs가 남아있음"
[ ! -f "$R13/CLAUDE.md" ] && pass "롤백: CLAUDE.md 원복됨" || fail "롤백 실패: CLAUDE.md가 남아있음"
[ ! -f "$R13/package.json" ] && pass "롤백: package.json 원복됨" || fail "롤백 실패: package.json이 남아있음"
[ ! -f "$R13/.claude/settings.json" ] && pass "롤백: settings.json 원복됨" || fail "롤백 실패: settings.json이 남아있음"
HOOKSPATH13="$(cd "$R13" && git config --get core.hooksPath || true)"
[ -z "${HOOKSPATH13}" ] && pass "롤백: git core.hooksPath 원복(unset)됨" || fail "롤백 실패: core.hooksPath가 여전히 설정됨(${HOOKSPATH13})"
# P04/S30 — 매니페스트 쓰기(atomicWrite)가 rename 단계에서 실패해도(자리가 디렉터리)
# 임시 파일이 정리돼야 한다.
TMPLEFT13="$(find "$R13" -name '*.orbit-*.tmp' 2>/dev/null | wc -l | tr -d ' ')"
[ "${TMPLEFT13}" = "0" ] && pass "매니페스트 쓰기 실패 후 *.orbit-*.tmp 잔재 없음" || fail "임시 파일 잔재 있음(${TMPLEFT13}건)"
rm -rf "$R13/.claude/orbit-manifest.json" 2>/dev/null

echo "== 시나리오 13b: 설치 롤백(권한 거부로 중간 실패, chmod 555) =="
R13B="$WORK/scenario13b"
new_repo "$R13B"
mkdir -p "$R13B/.claude"
chmod 555 "$R13B/.claude"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R13B" --project-name "Scenario13b" --slug scenario13b --mode new >/dev/null 2>&1
APPLY13B_CODE=$?
chmod 755 "$R13B/.claude" 2>/dev/null # 테스트 끝에 chmod 복구(정리 단계에서 rm -rf가 막히지 않게)
[ "${APPLY13B_CODE}" = "2" ] && pass "권한 거부로 중간 실패 시 apply가 실패로 종료(exit 2)" || fail "apply가 실패하지 않음(got ${APPLY13B_CODE})"
[ ! -f "$R13B/scripts/worklog.mjs" ] && pass "롤백: 권한 거부 이전에 만든 scripts/worklog.mjs도 원복됨" || fail "롤백 실패: scripts/worklog.mjs가 남아있음"
[ ! -f "$R13B/CLAUDE.md" ] && pass "롤백: CLAUDE.md 원복됨" || fail "롤백 실패: CLAUDE.md가 남아있음"

echo "== 시나리오 14: 옛 자동 학습 훅 정리·모르는 옵션 거부 =="
R14="$WORK/scenario14"
new_repo "$R14"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R14" --project-name "Scenario14" --slug scenario14 --mode new >/dev/null 2>&1
# 예전 버전이 선택 모듈로 심던 observe.sh 배선과 사용자 훅을 넣고, 매니페스트도 그 시절 모양으로 만든다.
node -e "
const fs = require('fs');
const f = '$R14/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const observe = (phase) => ({ hooks: [{ type: 'command', command: 'bash', args: ['-c', 'bash \"\$CLAUDE_PROJECT_DIR/.claude/skills/continuous-learning-v2/hooks/observe.sh\" ' + phase + ' 2>/dev/null || true'], timeout: 5 }] });
s.hooks.PreToolUse = [observe('pre'), { hooks: [{ type: 'command', command: 'echo user-pre' }] }];
s.hooks.PostToolUse = [...(s.hooks.PostToolUse || []), observe('post')];
fs.writeFileSync(f, JSON.stringify(s, null, 2));
const mf = '$R14/.claude/orbit-manifest.json';
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.modules = { ...m.modules, ecc: true };
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
"
node "$SKILL_DIR/scripts/install.mjs" update --repo "$R14" >/dev/null 2>&1
UPDATE14_CODE=$?
[ "${UPDATE14_CODE}" = "0" ] && pass "옛 자동 학습 배선이 있는 저장소 update 성공" || fail "update 실패(got ${UPDATE14_CODE})"
WIRING14="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R14/.claude/settings.json','utf8'));
const all = Object.values(s.hooks).flat().flatMap((g) => g.hooks || []);
const count = (marker) => all.filter((h) => (h.args || []).join(' ').includes(marker) || (h.command || '').includes(marker)).length;
const m = JSON.parse(require('fs').readFileSync('$R14/.claude/orbit-manifest.json','utf8'));
console.log(JSON.stringify({ observe: count('observe.sh'), wikiPost: count('wiki-hook.mjs\" post'), userPre: count('echo user-pre'), eccKey: 'ecc' in (m.modules || {}) }));
")"
echo "${WIRING14}" | grep -q '"observe":0' && echo "${WIRING14}" | grep -q '"wikiPost":1' && echo "${WIRING14}" | grep -q '"userPre":1' && echo "${WIRING14}" | grep -q '"eccKey":false' \
  && pass "update가 옛 observe.sh 배선만 정리·wiki 훅 1개·사용자 훅 보존·매니페스트 ecc 없음 (${WIRING14})" \
  || fail "옛 배선 정리 이상 (${WIRING14})"
OUT14="$(node "$SKILL_DIR/scripts/install.mjs" plan --repo "$R14" --project-name "Scenario14" --slug scenario14 --mode upgrade --ecc 2>&1)"; CODE14=$?
[ "${CODE14}" != "0" ] && echo "${OUT14}" | grep -q "알 수 없는 옵션: --ecc" && pass "모르는 옵션(--ecc) 거부" || fail "모르는 옵션을 받아들임(code=${CODE14})"
OUT14B="$(node "$SKILL_DIR/scripts/install.mjs" plan --repo "$R14" --project-name "Scenario14" --slug --codex --mode upgrade 2>&1)"; CODE14B=$?
[ "${CODE14B}" != "0" ] && echo "${OUT14B}" | grep -q "값이 필요합니다: --slug" && pass "값 옵션이 뒤 플래그를 값으로 삼키지 않음" || fail "값 옵션이 플래그를 삼킴(code=${CODE14B})"

echo "== 시나리오 15: 모듈 승계 버전업(F2 회귀) =="
R15="$WORK/scenario15"
new_repo "$R15"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R15" --project-name "Scenario15" --slug scenario15 --mode new --codex --reviewers >/dev/null 2>&1
APPLY15_1_CODE=$?
[ "${APPLY15_1_CODE}" = "0" ] && pass "--codex --reviewers 신규 설치 성공" || fail "--codex --reviewers 신규 설치 실패(got ${APPLY15_1_CODE})"

SKILL_COPY15="$WORK/skillcopy15"
cp -R "$SKILL_DIR" "$SKILL_COPY15"
{ echo ""; echo "<!-- v-next marker 15 -->"; } >> "$SKILL_COPY15/assets/CLAUDE.md.tmpl"

PLAN15="$(node "$SKILL_COPY15/scripts/install.mjs" plan --repo "$R15" --project-name "Scenario15" --slug scenario15 --mode upgrade 2>&1)"
CONFLICTS15="$(echo "${PLAN15}" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['conflicts']))" 2>/dev/null || echo err)"
[ "${CONFLICTS15}" = "0" ] && pass "플래그 없는 upgrade plan 충돌 0(모듈 승계)" || fail "플래그 없는 upgrade가 충돌 발생 (got: ${CONFLICTS15})"

node "$SKILL_COPY15/scripts/install.mjs" apply --repo "$R15" --project-name "Scenario15" --slug scenario15 --mode upgrade >/dev/null 2>&1
APPLY15_2_CODE=$?
[ "${APPLY15_2_CODE}" = "0" ] && pass "플래그 없는 upgrade apply 성공" || fail "플래그 없는 upgrade apply 실패(got ${APPLY15_2_CODE})"
grep -q "v-next marker 15" "$R15/CLAUDE.md" && pass "새 CLAUDE.md 템플릿 내용이 반영됨" || fail "새 템플릿 내용이 반영 안 됨"
[ -f "$R15/AGENTS.md" ] && pass "codex 산출물(AGENTS.md) 유지됨" || fail "codex 산출물이 사라짐"
[ -f "$R15/.claude/agents/security-reviewer.md" ] && pass "리뷰어 산출물 유지됨" || fail "리뷰어 산출물이 사라짐"

MANIFEST15="$(node -e "
const m = JSON.parse(require('fs').readFileSync('$R15/.claude/orbit-manifest.json','utf8'));
const hasAgents = Object.prototype.hasOwnProperty.call(m.files||{}, 'AGENTS.md');
console.log(JSON.stringify({hasAgents, codex: m.modules && m.modules.codex, reviewers: m.modules && m.modules.reviewers}));
")"
echo "${MANIFEST15}" | grep -q '"hasAgents":true' && echo "${MANIFEST15}" | grep -q '"codex":true' && echo "${MANIFEST15}" | grep -q '"reviewers":true' \
  && pass "매니페스트에 AGENTS.md 해시 + modules.codex/reviewers=true 유지 (${MANIFEST15})" \
  || fail "매니페스트가 codex/reviewers 구성을 잃음 (${MANIFEST15})"

echo "== 시나리오 16: 특수문자 표시 이름 렌더(node --check 게이트, N01 회귀) =="
R16="$WORK/scenario16"
new_repo "$R16"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R16" --project-name "Alice's \"App\" 테스트" --slug scenario16 --mode new >/dev/null 2>&1
APPLY16_CODE=$?
[ "${APPLY16_CODE}" = "0" ] && pass "특수문자 표시 이름으로 apply 성공" || fail "특수문자 표시 이름 apply 실패(got ${APPLY16_CODE})"
CHECK16_OK=1
for f in worklog.mjs worklog-hook.mjs tasks.mjs wiki-lib.mjs wiki-links.mjs wiki-context.mjs wiki-hook.mjs wiki.mjs; do
  node --check "$R16/scripts/$f" >/dev/null 2>&1 || CHECK16_OK=0
done
[ "${CHECK16_OK}" = "1" ] && pass "설치된 .mjs 8종 모두 node --check 통과" || fail "특수문자 렌더로 문법 오류 발생"
(cd "$R16" && node scripts/tasks.mjs add "특수문자테스트" --owner ai --action next --urgency low --source test >/dev/null 2>&1)
ADD16_CODE=$?
LIST16="$(cd "$R16" && node scripts/tasks.mjs list 2>&1)"
if [ "${ADD16_CODE}" = "0" ] && echo "${LIST16}" | grep -q "특수문자테스트"; then
  pass "tasks.mjs add/list 실동작 확인"
else
  fail "tasks.mjs add/list 실패(add rc=${ADD16_CODE})"
fi
# drop: 이유 없으면 거부, 이유 있으면 열린 목록에서 빠지고 취소 아카이브에 이유와 함께 남아야 한다
DROP16_ID="$(cd "$R16" && node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((d.open.find(t=>t.title==='특수문자테스트')||{}).id||'')" "$(ls "$R16"/*/tasks.json | head -1)")"
(cd "$R16" && node scripts/tasks.mjs drop "$DROP16_ID" >/dev/null 2>&1)
DROP16_NOREASON=$?
(cd "$R16" && node scripts/tasks.mjs drop "$DROP16_ID" --reason "테스트 취소" >/dev/null 2>&1)
DROP16_CODE=$?
LIST16B="$(cd "$R16" && node scripts/tasks.mjs list 2>&1)"
DONE16="$(cat "$R16"/*/tasks-done.md 2>/dev/null)"
if [ "${DROP16_NOREASON}" != "0" ] && [ "${DROP16_CODE}" = "0" ] && ! echo "${LIST16B}" | grep -q "특수문자테스트" && echo "${DONE16}" | grep -q "취소 아카이브" && echo "${DONE16}" | grep -q "테스트 취소"; then
  pass "tasks.mjs drop: 이유 필수·열린 목록 제거·취소 아카이브 기록"
else
  fail "tasks.mjs drop 실패(noreason rc=${DROP16_NOREASON}, drop rc=${DROP16_CODE})"
fi

echo "== 시나리오 17: worklog 자동 복구 실패 시 재차단(N02b 회귀) =="
R17="$WORK/scenario17"
new_repo "$R17"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R17" --project-name "Scenario17" --slug scenario17 --mode new >/dev/null 2>&1
SID17="s17-session"
STATE_FILE17="$R17/.git/orbit-state/worklog/${SID17}.json"
VAULT_STATE17="$R17/scenario17-docs/worklog-state.json"

(cd "$R17" && echo "{\"session_id\":\"${SID17}\"}" | node scripts/worklog-hook.mjs begin >/dev/null 2>&1)
node -e "require('fs').mkdirSync('$R17/scenario17-docs', {recursive:true}); require('fs').writeFileSync('${VAULT_STATE17}', '{broken')"

STOP17_1="$(cd "$R17" && echo "{\"session_id\":\"${SID17}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop)"; STOP17_1_RC=$?
DECISION17_1="$(echo "${STOP17_1}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('decision',''))" 2>/dev/null || echo err)"
PENDING17_1="$(python3 -c "import json; d=json.load(open('${STATE_FILE17}')); print('none' if d['pending'] is None else 'present')" 2>/dev/null || echo err)"
FAILURES17_1="$(python3 -c "import json; print(json.load(open('${STATE_FILE17}'))['pending']['recoveryFailures'])" 2>/dev/null || echo err)"
if [ "${STOP17_1_RC}" = "0" ] && [ "${DECISION17_1}" = "block" ] && [ "${PENDING17_1}" = "present" ] && [ "${FAILURES17_1}" = "1" ]; then
  pass "복구 실패 → exit 0·pending 유지·recoveryFailures=1·decision block"
else
  fail "복구 실패 처리 이상 (rc=${STOP17_1_RC} decision=${DECISION17_1} pending=${PENDING17_1} failures=${FAILURES17_1})"
fi

rm -f "${VAULT_STATE17}"
STOP17_2="$(cd "$R17" && echo "{\"session_id\":\"${SID17}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop)"; STOP17_2_RC=$?
PENDING17_2="$(python3 -c "import json; d=json.load(open('${STATE_FILE17}')); print('none' if d['pending'] is None else 'present')" 2>/dev/null || echo err)"
if [ "${STOP17_2_RC}" = "0" ] && [ "${PENDING17_2}" = "none" ] && grep -q "자동 복구" "$R17/scenario17-docs/worklog.md" 2>/dev/null; then
  pass "상태 복구 후 재차단 재진입 → 자동 복구 성공·pending null"
else
  fail "상태 복구 후 재진입 복구 실패 (rc=${STOP17_2_RC} pending=${PENDING17_2})"
fi

echo "== 시나리오 18: 세션 상태 손상 시 격리 후 차단(N02a 회귀) =="
R18="$WORK/scenario18"
new_repo "$R18"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R18" --project-name "Scenario18" --slug scenario18 --mode new >/dev/null 2>&1
SID18="s18-session"
STATE_DIR18="$R18/.git/orbit-state/worklog"
STATE_FILE18="${STATE_DIR18}/${SID18}.json"

(cd "$R18" && echo "{\"session_id\":\"${SID18}\"}" | node scripts/worklog-hook.mjs begin >/dev/null 2>&1)
printf '{bad' > "${STATE_FILE18}"

STOP18="$(cd "$R18" && echo "{\"session_id\":\"${SID18}\"}" | node scripts/worklog-hook.mjs stop)"; STOP18_RC=$?
DECISION18="$(echo "${STOP18}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('decision',''))" 2>/dev/null || echo err)"
CORRUPT18_COUNT="$(ls "${STATE_DIR18}"/${SID18}.json.corrupt-* 2>/dev/null | wc -l | tr -d ' ')"
PENDING18="$(python3 -c "import json; d=json.load(open('${STATE_FILE18}')); print('present' if d.get('pending') else 'none')" 2>/dev/null || echo err)"
if [ "${STOP18_RC}" = "0" ] && [ "${DECISION18}" = "block" ] && [ "${CORRUPT18_COUNT}" != "0" ] && [ "${PENDING18}" = "present" ]; then
  pass "손상 세션 상태 → 격리 + 차단(경고만 내고 통과하지 않음)"
else
  fail "손상 세션 상태 처리 이상 (rc=${STOP18_RC} decision=${DECISION18} corrupt=${CORRUPT18_COUNT} pending=${PENDING18})"
fi

echo "== 시나리오 19: 이벤트 키 삭제 버전업 시 사용자 훅 보존(N05 회귀) =="
R19="$WORK/scenario19"
new_repo "$R19"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R19" --project-name "Scenario19" --slug scenario19 --mode new >/dev/null 2>&1
node -e "
const fs = require('fs');
const f = '$R19/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
s.hooks.SessionStart = s.hooks.SessionStart || [];
s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'bash', args: ['-c', 'echo user-hook'] }] });
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"
SKILL_COPY19="$WORK/skillcopy19"
cp -R "$SKILL_DIR" "$SKILL_COPY19"
node -e "
const fs = require('fs');
const f = '$SKILL_COPY19/assets/claude/settings.hooks.base.json';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
delete s.hooks.SessionStart;
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"
node "$SKILL_COPY19/scripts/install.mjs" apply --repo "$R19" --project-name "Scenario19" --slug scenario19 --mode upgrade >/dev/null 2>&1
APPLY19_CODE=$?
[ "${APPLY19_CODE}" = "0" ] && pass "SessionStart 키 삭제된 버전으로 upgrade 성공" || fail "upgrade 실패(got ${APPLY19_CODE})"
WIRING19="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R19/.claude/settings.json','utf8'));
const groups = s.hooks.SessionStart || [];
let harness = 0, user = 0;
for (const g of groups) {
  for (const h of (g.hooks||[])) {
    const joined = (h.args||[]).join(' ');
    if (joined.includes('worklog.mjs\" catchup') || joined.includes('worklog.mjs\" recent') || joined.includes('worklog-hook.mjs\"') || joined.includes('wiki-hook.mjs\"') || joined.includes('continuous-learning-v2/hooks/observe.sh')) harness++;
    else user++;
  }
}
console.log(JSON.stringify({harness, user}));
")"
echo "${WIRING19}" | grep -q '"harness":0' && echo "${WIRING19}" | grep -q '"user":1' \
  && pass "SessionStart: 하네스 훅 0개·사용자 훅 1개 보존 (${WIRING19})" \
  || fail "SessionStart 훅 정리 이상 (${WIRING19})"

echo "== 시나리오 20: 대형 항목 뒤 상태 후퇴에도 번호 중복 없음(N06 회귀) =="
R20="$WORK/scenario20"
new_repo "$R20"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R20" --project-name "Scenario20" --slug scenario20 --mode new >/dev/null 2>&1
BIGRESULT20="$(python3 -c "print('x' * 9500)")"
(cd "$R20" && node scripts/worklog.mjs append claude "첫턴" "${BIGRESULT20}" >/dev/null 2>&1)
STATE20="$R20/scenario20-docs/worklog-state.json"
node -e "
const fs = require('fs');
const f = '$STATE20';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
s.next = 1;
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"
(cd "$R20" && node scripts/worklog.mjs append claude "둘째턴" "결과2" >/dev/null 2>&1)
LOG20="$R20/scenario20-docs/worklog.md"
COUNT_HASH1_20="$(grep -c '^## \[#1\]' "$LOG20")"
COUNT_HASH2_20="$(grep -c '^## \[#2\]' "$LOG20")"
if [ "${COUNT_HASH1_20}" = "1" ] && [ "${COUNT_HASH2_20}" = "1" ]; then
  pass "9KB 항목 뒤 상태 후퇴에도 #1 중복 없이 #2로 이어짐"
else
  fail "번호 중복 발생 (count#1=${COUNT_HASH1_20} count#2=${COUNT_HASH2_20})"
fi

echo "== 시나리오 23: 잠금 해제 소유 검증(N07 회귀) =="
R23="$WORK/scenario23"
new_repo "$R23"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R23" --project-name "Scenario23" --slug scenario23 --mode new >/dev/null 2>&1
(cd "$R23" && node scripts/tasks.mjs init >/dev/null 2>&1)
DATA23="$R23/scenario23-docs/tasks.json"
LOCK23="${DATA23}.lock"
mkdir -p "$LOCK23"
echo 99999999 > "$LOCK23/pid"
(cd "$R23" && node scripts/tasks.mjs add "stale-lock-add" --owner ai --action someday --urgency low --source test >/dev/null 2>&1)
ADD23_1_CODE=$?
[ "${ADD23_1_CODE}" = "0" ] && pass "죽은 pid의 스테일 잠금 회수 후 add 성공" || fail "스테일 잠금 회수 실패(got ${ADD23_1_CODE})"
[ ! -d "$LOCK23" ] && pass "정상 완료 후 자기 소유 잠금 정리됨" || fail "잠금 디렉터리가 남아있음"

sleep 60 &
LIVE_PID23=$!
mkdir -p "$LOCK23"
echo "${LIVE_PID23}" > "$LOCK23/pid"
(cd "$R23" && node scripts/tasks.mjs add "live-lock-add" --owner ai --action someday --urgency low --source test >/dev/null 2>&1)
ADD23_2_CODE=$?
[ "${ADD23_2_CODE}" != "0" ] && pass "살아있는 프로세스의 잠금은 스테일로 보지 않음(add 대기 끝 실패, exit ${ADD23_2_CODE})" || fail "살아있는 잠금인데 add가 성공함"
[ -d "$LOCK23" ] && pass "타인 소유 잠금이 삭제되지 않고 남아있음" || fail "타인 소유 잠금이 삭제됨(N07 회귀)"
kill "${LIVE_PID23}" 2>/dev/null
wait "${LIVE_PID23}" 2>/dev/null
rm -rf "$LOCK23" 2>/dev/null

echo "== 시나리오 27: worklog 미기록 턴 대기열(orphans, P02 회귀) =="
R27="$WORK/scenario27"
new_repo "$R27"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R27" --project-name "Scenario27" --slug scenario27 --mode new >/dev/null 2>&1
SID27="s27-session"
STATE_FILE27="$R27/.git/orbit-state/worklog/${SID27}.json"
VAULT_STATE27="$R27/scenario27-docs/worklog-state.json"

(cd "$R27" && echo "{\"session_id\":\"${SID27}\"}" | node scripts/worklog-hook.mjs begin >/dev/null 2>&1)
node -e "require('fs').mkdirSync('$R27/scenario27-docs', {recursive:true}); require('fs').writeFileSync('${VAULT_STATE27}', '{broken')"

STOP27_1="$(cd "$R27" && echo "{\"session_id\":\"${SID27}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop)"; STOP27_1_RC=$?
DECISION27_1="$(echo "${STOP27_1}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('decision',''))" 2>/dev/null || echo err)"
[ "${STOP27_1_RC}" = "0" ] && [ "${DECISION27_1}" = "block" ] && pass "1회차 자동 복구 실패 → block" || fail "1회차 처리 이상 (rc=${STOP27_1_RC} decision=${DECISION27_1})"

STOP27_2="$(cd "$R27" && echo "{\"session_id\":\"${SID27}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop)"; STOP27_2_RC=$?
DECISION27_2="$(echo "${STOP27_2}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('decision',''))" 2>/dev/null || echo err)"
[ "${STOP27_2_RC}" = "0" ] && [ "${DECISION27_2}" = "block" ] && pass "2회차 자동 복구 실패 → block" || fail "2회차 처리 이상 (rc=${STOP27_2_RC} decision=${DECISION27_2})"

STOP27_3="$(cd "$R27" && echo "{\"session_id\":\"${SID27}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop)"; STOP27_3_RC=$?
DECISION27_3="$(echo "${STOP27_3}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('decision','none'))" 2>/dev/null || echo err)"
PENDING27_3="$(python3 -c "import json; d=json.load(open('${STATE_FILE27}')); print('none' if d['pending'] is None else 'present')" 2>/dev/null || echo err)"
ORPHANS27_3="$(python3 -c "import json; print(len(json.load(open('${STATE_FILE27}')).get('orphans', [])))" 2>/dev/null || echo err)"
if [ "${STOP27_3_RC}" = "0" ] && [ "${DECISION27_3}" = "none" ] && [ "${PENDING27_3}" = "none" ] && [ "${ORPHANS27_3}" = "1" ]; then
  pass "3회차 실패 → 무한 차단 대신 통과·pending null·orphans 1건 보존"
else
  fail "3회차 처리 이상 (rc=${STOP27_3_RC} decision=${DECISION27_3} pending=${PENDING27_3} orphans=${ORPHANS27_3})"
fi

(cd "$R27" && echo "{\"session_id\":\"${SID27}\"}" | node scripts/worklog-hook.mjs begin >/dev/null 2>&1)
ORPHANS27_AFTERBEGIN="$(python3 -c "import json; print(len(json.load(open('${STATE_FILE27}')).get('orphans', [])))" 2>/dev/null || echo err)"
COUNTER27_AFTERBEGIN="$(python3 -c "import json; print(json.load(open('${STATE_FILE27}'))['counter'])" 2>/dev/null || echo err)"
if [ "${ORPHANS27_AFTERBEGIN}" = "1" ] && [ "${COUNTER27_AFTERBEGIN}" = "2" ]; then
  pass "begin 재호출: 새 pending 생성(counter 2)·orphans 덮어쓰지 않고 유지(1건)"
else
  fail "begin 후 orphans/counter 이상 (orphans=${ORPHANS27_AFTERBEGIN} counter=${COUNTER27_AFTERBEGIN})"
fi

rm -f "${VAULT_STATE27}"
STOP27_4="$(cd "$R27" && echo "{\"session_id\":\"${SID27}\", \"stop_hook_active\": true}" | node scripts/worklog-hook.mjs stop)"; STOP27_4_RC=$?
ORPHANS27_FINAL="$(python3 -c "import json; print(len(json.load(open('${STATE_FILE27}')).get('orphans', [])))" 2>/dev/null || echo err)"
PENDING27_FINAL="$(python3 -c "import json; d=json.load(open('${STATE_FILE27}')); print('none' if d['pending'] is None else 'present')" 2>/dev/null || echo err)"
AUTORECOVER_COUNT27="$(grep -c "자동 복구" "$R27/scenario27-docs/worklog.md" 2>/dev/null)"
AUTORECOVER_COUNT27="${AUTORECOVER_COUNT27:-0}"
if [ "${STOP27_4_RC}" = "0" ] && [ "${ORPHANS27_FINAL}" = "0" ] && [ "${PENDING27_FINAL}" = "none" ] && [ "${AUTORECOVER_COUNT27}" -ge "2" ]; then
  pass "상태 복구 후 재진입 → 현재 턴 + 대기열 턴 모두 자동 복구·orphans 0"
else
  fail "최종 복구 실패 (rc=${STOP27_4_RC} orphans=${ORPHANS27_FINAL} pending=${PENDING27_FINAL} autorecover=${AUTORECOVER_COUNT27})"
fi

OLDSCHEMA_SID27="s27-oldschema"
OLDSCHEMA_STATE27="$R27/.git/orbit-state/worklog/${OLDSCHEMA_SID27}.json"
printf '{"sessionId":"%s","counter":1,"pending":null}\n' "${OLDSCHEMA_SID27}" > "${OLDSCHEMA_STATE27}"
OLDSCHEMA_OUT27="$(cd "$R27" && echo "{\"session_id\":\"${OLDSCHEMA_SID27}\"}" | node scripts/worklog-hook.mjs stop)"; OLDSCHEMA_RC27=$?
[ "${OLDSCHEMA_RC27}" = "0" ] && pass "orphans 필드 없는 구스키마 상태 → stop이 오류 없이 통과" || fail "구스키마 orphans 마이그레이션 실패(rc=${OLDSCHEMA_RC27})"

echo "== 시나리오 28: 훅 소유 완전 일치 판정(비앵커 위치의 마커 문자열 4종 보존, P03 회귀) =="
R28="$WORK/scenario28"
new_repo "$R28"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R28" --project-name "Scenario28" --slug scenario28 --mode new >/dev/null 2>&1
node -e "
const fs = require('fs');
const f = '$R28/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
s.hooks.Notification = s.hooks.Notification || [];
const markers = [
  'scripts/worklog.mjs\" catchup',
  'scripts/worklog-hook.mjs\"',
  'scripts/wiki-hook.mjs\"',
  'continuous-learning-v2/hooks/observe.sh',
];
for (const m of markers) {
  s.hooks.Notification.push({ hooks: [{ type: 'command', command: 'bash', args: ['-lc', 'echo user docs: ' + m + '\"'] }] });
}
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R28" --project-name "Scenario28" --slug scenario28 --mode upgrade >/dev/null 2>&1
APPLY28_CODE=$?
[ "${APPLY28_CODE}" = "0" ] && pass "비앵커 위치 마커 4종을 심은 채 upgrade 성공" || fail "upgrade 실패(got ${APPLY28_CODE})"
NOTIFCOUNT28="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R28/.claude/settings.json','utf8'));
const groups = s.hooks.Notification || [];
console.log(groups.reduce((acc,g)=>acc+(g.hooks||[]).length, 0));
")"
[ "${NOTIFCOUNT28}" = "4" ] && pass "부분 문자열만 같은 사용자 훅 4개 모두 보존됨(정확히 4개)" || fail "사용자 훅이 오삭제됨 (got ${NOTIFCOUNT28})"

echo "== 시나리오 29: 훅 소유 레거시 폴백 재검증(매니페스트 hookSignatures 없음, P03 회귀) =="
R29="$WORK/scenario29"
new_repo "$R29"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R29" --project-name "Scenario29" --slug scenario29 --mode new >/dev/null 2>&1
node -e "
const fs = require('fs');
const f = '$R29/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
s.hooks.SessionStart = s.hooks.SessionStart || [];
s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'bash', args: ['-c', 'echo user-hook'] }] });
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"
node -e "
const fs = require('fs');
const f = '$R29/.claude/orbit-manifest.json';
const m = JSON.parse(fs.readFileSync(f, 'utf8'));
delete m.hookSignatures;
fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
"
SKILL_COPY29="$WORK/skillcopy29"
cp -R "$SKILL_DIR" "$SKILL_COPY29"
node -e "
const fs = require('fs');
const f = '$SKILL_COPY29/assets/claude/settings.hooks.base.json';
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
delete s.hooks.SessionStart;
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"
node "$SKILL_COPY29/scripts/install.mjs" apply --repo "$R29" --project-name "Scenario29" --slug scenario29 --mode upgrade >/dev/null 2>&1
APPLY29_CODE=$?
[ "${APPLY29_CODE}" = "0" ] && pass "매니페스트에 hookSignatures 없이도(레거시 폴백) upgrade 성공" || fail "레거시 폴백 upgrade 실패(got ${APPLY29_CODE})"
WIRING29="$(node -e "
const s = JSON.parse(require('fs').readFileSync('$R29/.claude/settings.json','utf8'));
const groups = s.hooks.SessionStart || [];
let harness = 0, user = 0;
for (const g of groups) {
  for (const h of (g.hooks||[])) {
    const joined = (h.args||[]).join(' ');
    if (joined.includes('worklog.mjs\" catchup') || joined.includes('worklog.mjs\" recent') || joined.includes('worklog-hook.mjs\"') || joined.includes('wiki-hook.mjs\"') || joined.includes('continuous-learning-v2/hooks/observe.sh')) harness++;
    else user++;
  }
}
console.log(JSON.stringify({harness, user}));
")"
echo "${WIRING29}" | grep -q '"harness":0' && echo "${WIRING29}" | grep -q '"user":1' \
  && pass "레거시 폴백(앵커드 정규식): 진짜 하네스 훅 제거·사용자 훅 보존 (${WIRING29})" \
  || fail "레거시 폴백 훅 정리 이상 (${WIRING29})"

echo "== 시나리오 30: 임시 파일 정리(jscheck 스크래치, P04 회귀) =="
SKILL_COPY30="$WORK/skillcopy30"
cp -R "$SKILL_DIR" "$SKILL_COPY30"
printf '\nfunction broken( {{\n' >> "$SKILL_COPY30/assets/scripts/worklog.mjs"
R30="$WORK/scenario30"
new_repo "$R30"
TMPDIR_BEFORE30="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'orbit-jscheck-*' 2>/dev/null | wc -l | tr -d ' ')"
node "$SKILL_COPY30/scripts/install.mjs" plan --repo "$R30" --project-name "Scenario30" --slug scenario30 --mode new >/dev/null 2>&1
PLAN30_CODE=$?
[ "${PLAN30_CODE}" != "0" ] && pass "손상된 .mjs 자산 → plan이 jscheck 게이트에서 거부(exit ${PLAN30_CODE})" || fail "손상된 .mjs인데 plan이 통과함"
TMPDIR_AFTER30="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'orbit-jscheck-*' 2>/dev/null | wc -l | tr -d ' ')"
[ "${TMPDIR_AFTER30}" = "${TMPDIR_BEFORE30}" ] && pass "jscheck 스크래치 디렉터리 잔재 없음(전:${TMPDIR_BEFORE30} 후:${TMPDIR_AFTER30})" || fail "jscheck 스크래치 디렉터리 잔재 있음(전:${TMPDIR_BEFORE30} 후:${TMPDIR_AFTER30})"

echo "== 시나리오 32: wiki new =="
R32="$WORK/scenario32"
new_repo "$R32"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R32" --project-name "Scenario32" --slug scenario32 --mode new >/dev/null 2>&1
# _index.md는 tasks.md·worklog.md를 링크한다 — SKILL.md 설치 후 스모크와 같은 순서로
# 먼저 만들어 둬야 wiki:check가 이 무관한 사전조건 때문에 실패하지 않는다(기존에도 있던 조건).
(cd "$R32" && node scripts/tasks.mjs init >/dev/null 2>&1)
(cd "$R32" && node scripts/worklog.mjs append claude "설치" "스모크" >/dev/null 2>&1)
(cd "$R32" && node scripts/wiki.mjs new "테스트 노트" --summary "회귀 시험용 노트" --aliases "테스트,test-note" >/dev/null 2>&1)
NEW32_CODE=$?
[ "${NEW32_CODE}" = "0" ] && pass "wiki new 실행 성공" || fail "wiki new 실행 실패(got ${NEW32_CODE})"
NOTE32_FILE="$R32/scenario32-docs/wiki/테스트-노트.md"
[ -f "${NOTE32_FILE}" ] && pass "노트 파일 생성됨" || fail "노트 파일이 생성되지 않음(${NOTE32_FILE})"
grep -q '^title: "테스트 노트"' "${NOTE32_FILE}" && pass "프런트매터 title 유효" || fail "프런트매터 title 이상"
CHECK32="$(cd "$R32" && npm run --silent wiki:check 2>&1)"; CHECK32_RC=$?
[ "${CHECK32_RC}" = "0" ] && pass "wiki:check 통과" || fail "wiki:check 실패: ${CHECK32}"
LIST32="$(cd "$R32" && node scripts/wiki.mjs list 2>&1)"
echo "${LIST32}" | grep -q "테스트 노트" && pass "wiki list에 노출됨" || fail "wiki list에 노출 안 됨"
INDEX32="$R32/scenario32-docs/wiki/_index.md"
grep -q "wiki:auto start" "${INDEX32}" && grep -q "테스트-노트" "${INDEX32}" && pass "인덱스 자동 블록에 등록됨" || fail "인덱스 자동 블록 갱신 실패"

echo "== 시나리오 33: wiki rename 링크 무결성(P03/S33 회귀 고정) =="
R33="$WORK/scenario33"
new_repo "$R33"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R33" --project-name "Scenario33" --slug scenario33 --mode new >/dev/null 2>&1
(cd "$R33" && node scripts/tasks.mjs init >/dev/null 2>&1)
(cd "$R33" && node scripts/worklog.mjs append claude "설치" "스모크" >/dev/null 2>&1)
(cd "$R33" && node scripts/wiki.mjs new "노트 A" --summary "A 노트" >/dev/null 2>&1)
(cd "$R33" && node scripts/wiki.mjs new "노트 B" --summary "B 노트" >/dev/null 2>&1)
NOTE_B33="$R33/scenario33-docs/wiki/노트-B.md"
node -e "
const fs = require('fs');
const f = '${NOTE_B33}';
let c = fs.readFileSync(f, 'utf8');
c = c.replace('related: []', 'related:\n  - \"[[wiki/노트-A]]\"');
c += '\n[[wiki/노트-A|A쪽]] 참고.\n';
fs.writeFileSync(f, c);
"
(cd "$R33" && node scripts/wiki.mjs rename "노트 A" "노트-C" >/dev/null 2>&1)
RENAME33_CODE=$?
[ "${RENAME33_CODE}" = "0" ] && pass "wiki rename 실행 성공" || fail "wiki rename 실행 실패(got ${RENAME33_CODE})"
[ ! -f "$R33/scenario33-docs/wiki/노트-A.md" ] && pass "이전 파일 제거됨" || fail "이전 파일이 남아있음"
[ -f "$R33/scenario33-docs/wiki/노트-C.md" ] && pass "새 파일 생성됨" || fail "새 파일이 생성되지 않음"
grep -q '노트-C' "${NOTE_B33}" && pass "참조 노트의 링크가 새 id로 바뀜(related·본문 모두)" || fail "참조 노트의 링크가 갱신되지 않음"
grep -q 'A쪽' "${NOTE_B33}" && pass "표시 라벨 보존됨" || fail "표시 라벨이 사라짐"
CHECK33="$(cd "$R33" && npm run --silent wiki:check 2>&1)"; CHECK33_RC=$?
[ "${CHECK33_RC}" = "0" ] && pass "rename 후 wiki:check 깨진 링크 0" || fail "rename 후 wiki:check 실패: ${CHECK33}"

echo "== 시나리오 34: wiki rm 인바운드 링크 보호 =="
R34="$WORK/scenario34"
new_repo "$R34"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R34" --project-name "Scenario34" --slug scenario34 --mode new >/dev/null 2>&1
(cd "$R34" && node scripts/wiki.mjs new "노트 X" --summary "X 노트" >/dev/null 2>&1)
(cd "$R34" && node scripts/wiki.mjs new "노트 Y" --summary "Y 노트" >/dev/null 2>&1)
NOTE_Y34="$R34/scenario34-docs/wiki/노트-Y.md"
node -e "
const fs = require('fs');
const f = '${NOTE_Y34}';
let c = fs.readFileSync(f, 'utf8');
c += '\n[[wiki/노트-X]] 참고.\n';
fs.writeFileSync(f, c);
"
(cd "$R34" && node scripts/wiki.mjs rm "노트 X" >/dev/null 2>&1)
RM34_1_CODE=$?
[ "${RM34_1_CODE}" != "0" ] && pass "인바운드 링크 있는 노트 rm → 거부(exit ${RM34_1_CODE})" || fail "인바운드 링크가 있는데 rm이 성공함"
[ -f "$R34/scenario34-docs/wiki/노트-X.md" ] && pass "거부 후 파일 보존됨" || fail "거부됐는데 파일이 사라짐"
RMOUT34="$(cd "$R34" && node scripts/wiki.mjs rm "노트 X" --force 2>&1)"
RM34_2_CODE=$?
[ "${RM34_2_CODE}" = "0" ] && pass "--force → rm 성공" || fail "--force인데 rm 실패(got ${RM34_2_CODE})"
[ ! -f "$R34/scenario34-docs/wiki/노트-X.md" ] && pass "--force 후 파일 삭제됨" || fail "--force인데 파일이 남아있음"
echo "${RMOUT34}" | grep -q "끊긴 링크" && pass "--force 삭제 시 끊긴 링크 보고됨" || fail "끊긴 링크 보고가 없음"

echo "== 시나리오 35: wiki set =="
R35="$WORK/scenario35"
new_repo "$R35"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R35" --project-name "Scenario35" --slug scenario35 --mode new >/dev/null 2>&1
(cd "$R35" && node scripts/tasks.mjs init >/dev/null 2>&1)
(cd "$R35" && node scripts/worklog.mjs append claude "설치" "스모크" >/dev/null 2>&1)
(cd "$R35" && node scripts/wiki.mjs new "노트 Z" --summary "초기 요약" >/dev/null 2>&1)
NOTE_Z35="$R35/scenario35-docs/wiki/노트-Z.md"
CREATED35_BEFORE="$(grep '^created:' "${NOTE_Z35}")"
(cd "$R35" && node scripts/wiki.mjs set "노트 Z" --status active --summary "바뀐 요약" >/dev/null 2>&1)
SET35_CODE=$?
[ "${SET35_CODE}" = "0" ] && pass "wiki set 실행 성공" || fail "wiki set 실행 실패(got ${SET35_CODE})"
grep -q '^status: active' "${NOTE_Z35}" && pass "status 변경됨" || fail "status가 변경되지 않음"
grep -q '^summary: "바뀐 요약"' "${NOTE_Z35}" && pass "summary 변경됨" || fail "summary가 변경되지 않음"
CREATED35_AFTER="$(grep '^created:' "${NOTE_Z35}")"
[ "${CREATED35_BEFORE}" = "${CREATED35_AFTER}" ] && pass "created는 변경되지 않음" || fail "created가 잘못 변경됨"
TODAY35="$(date +%Y-%m-%d)"
grep "^updated:" "${NOTE_Z35}" | grep -q "${TODAY35}" && pass "updated가 오늘 날짜로 갱신됨" || fail "updated 갱신 안 됨"
CHECK35="$(cd "$R35" && npm run --silent wiki:check 2>&1)"; CHECK35_RC=$?
[ "${CHECK35_RC}" = "0" ] && pass "set 후 wiki:check 통과(스키마 유효)" || fail "set 후 wiki:check 실패: ${CHECK35}"

echo "== 시나리오 37: worklog recent(비소비·앞 구간 요약+턴8, SessionStart 배선) =="
R37="$WORK/scenario37"
new_repo "$R37"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R37" --project-name "Scenario37" --slug scenario37 --mode new >/dev/null 2>&1
for i in $(seq 1 10); do (cd "$R37" && node scripts/worklog.mjs append claude "q$i" "r$i" >/dev/null 2>&1); done
(cd "$R37" && node scripts/worklog.mjs summary claude "요약본" >/dev/null 2>&1)
STATE37F="$R37/scenario37-docs/worklog-state.json"
OUT37A="$(cd "$R37" && node scripts/worklog.mjs recent claude)"
STATE37A="$(cat "$STATE37F")"
OUT37B="$(cd "$R37" && node scripts/worklog.mjs recent claude)"
STATE37B="$(cat "$STATE37F")"
echo "$OUT37A" | grep -q "최근 맥락" && pass "recent 출력 헤더" || fail "recent 헤더 없음"
CNT37="$(echo "$OUT37A" | grep -c '^## \[#')"
[ "$CNT37" = "8" ] && pass "recent 턴 8개 출력" || fail "recent 턴 개수=${CNT37}(8 기대)"
echo "$OUT37A" | grep -q '^## \[요약' && pass "recent 앞 구간 요약 포함" || fail "recent 요약 없음"
[ "$STATE37A" = "$STATE37B" ] && pass "recent 비소비(state 불변)" || fail "recent가 state 변경(비소비 위반)"
[ "$OUT37A" = "$OUT37B" ] && pass "recent 반복 출력 동일" || fail "recent 반복 출력 다름"
WIRE37="$(python3 -c "
import json
s=json.load(open('$R37/.claude/settings.json'))
j='|'.join(' '.join(h.get('args',[])) for g in s['hooks'].get('SessionStart',[]) for h in g.get('hooks',[]))
print('ok' if ('worklog.mjs\" recent' in j and 'worklog.mjs\" catchup' not in j) else 'no')
")"
[ "$WIRE37" = "ok" ] && pass "SessionStart=recent(catchup 아님)" || fail "SessionStart 배선 오류(${WIRE37})"

echo "== 시나리오 38: update(무질문·충돌 보존·부분 적용) =="
R38="$WORK/scenario38"
new_repo "$R38"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R38" --project-name "Scenario38" --slug scenario38 --mode new >/dev/null 2>&1
SKILL_COPY38="$WORK/skillcopy38"
cp -R "$SKILL_DIR" "$SKILL_COPY38"
printf '\n// UPDATE-MARKER-38\n' >> "$SKILL_COPY38/assets/scripts/worklog.mjs"
printf '\nMY-CUSTOM-38\n' >> "$R38/CLAUDE.md"
UPD38="$(node "$SKILL_COPY38/scripts/install.mjs" update --repo "$R38" 2>/dev/null)"; UPD38_CODE=$?
[ "${UPD38_CODE}" = "0" ] && pass "update 종료코드 0(충돌 있어도 미중단)" || fail "update 종료코드=${UPD38_CODE}"
grep -q "UPDATE-MARKER-38" "$R38/scripts/worklog.mjs" && pass "update가 worklog.mjs 갱신" || fail "worklog.mjs 미갱신"
grep -q "MY-CUSTOM-38" "$R38/CLAUDE.md" && pass "update가 CLAUDE.md 보존(충돌 미덮기)" || fail "CLAUDE.md 덮어써짐"
echo "$UPD38" | python3 -c "import json,sys;d=json.load(sys.stdin);print('OKC' if d['files']['conflict']>=1 and d['files']['update']>=1 else 'NO')" | grep -q OKC && pass "요약: 업데이트≥1·충돌≥1" || fail "요약 개수 이상"
python3 -c "import json;print(json.load(open('$R38/.claude/orbit-manifest.json')).get('projectName'))" | grep -q "Scenario38" && pass "manifest projectName 기록" || fail "projectName 미기록"
R38B="$WORK/scenario38b"; new_repo "$R38B"
node "$SKILL_DIR/scripts/install.mjs" update --repo "$R38B" >/dev/null 2>&1; NOMAN38=$?
[ "${NOMAN38}" != "0" ] && pass "매니페스트 없으면 update 거부" || fail "매니페스트 없는데 update 통과"

echo ""
echo "== 시나리오 39: 옛 harness-manifest 흡수(이관) =="
R39="$WORK/repo39"
mkdir -p "$R39/.claude" && git -C "$R39" init -q
mkdir -p "$R39/m39-docs" && : > "$R39/m39-docs/worklog.md" && : > "$R39/m39-docs/rules.md"
cat > "$R39/.claude/harness-manifest.json" <<'SEOF'
{
  "slug": "m39",
  "projectName": "Scenario39",
  "docsDir": "m39-docs",
  "skillVersion": "0.0.0",
  "files": {},
  "modules": { "codex": false, "ecc": false, "reviewers": false },
  "hookSignatures": []
}
SEOF
UPD39="$(node "$SKILL_DIR/scripts/install.mjs" update --repo "$R39" 2>&1)"
[ -f "$R39/.claude/orbit-manifest.json" ] && pass "orbit-manifest.json 생성(흡수)" || fail "orbit-manifest 미생성: $UPD39"
[ ! -f "$R39/.claude/harness-manifest.json" ] && pass "옛 harness-manifest 제거" || fail "옛 매니페스트 잔존"
echo "$UPD39" | grep -q '"migratedFromHarness": true' && pass "summary가 흡수를 보고" || fail "migratedFromHarness 미보고"
python3 -c "import json;print(json.load(open('$R39/.claude/orbit-manifest.json')).get('projectName'))" | grep -q "Scenario39" && pass "projectName 승계" || fail "projectName 미승계"
[ -f "$R39/m39-docs/worklog.md" ] && pass "docs 볼트 렌더" || fail "docs 볼트 미생성"

echo ""
echo "== 시나리오 40: 옛 harness-state/worklog 상태 이관 =="
R40="$WORK/repo40"
mkdir -p "$R40/.claude" && git -C "$R40" init -q
mkdir -p "$R40/m40-docs" && : > "$R40/m40-docs/worklog.md" && : > "$R40/m40-docs/rules.md"
cat > "$R40/.claude/harness-manifest.json" <<'SEOF'
{
  "slug": "m40",
  "projectName": "Scenario40",
  "docsDir": "m40-docs",
  "skillVersion": "0.0.0",
  "files": {},
  "modules": { "codex": false, "ecc": false, "reviewers": false },
  "hookSignatures": []
}
SEOF
mkdir -p "$R40/.git/harness-state/worklog" "$R40/.git/orbit-state/worklog"
echo '{"sessionId":"old","counter":3,"pending":{"turn":3,"token":"t0"},"orphans":[]}' > "$R40/.git/harness-state/worklog/old.json"
echo '{"from":"legacy"}' > "$R40/.git/harness-state/worklog/both.json"
echo '{"from":"orbit"}' > "$R40/.git/orbit-state/worklog/both.json"
UPD40="$(node "$SKILL_DIR/scripts/install.mjs" update --repo "$R40" 2>&1)"
echo "$UPD40" | grep -q '"files": 2' && pass "summary가 상태 이관 계획을 보고" || fail "stateMigration 미보고: $UPD40"
grep -q '"token":"t0"' "$R40/.git/orbit-state/worklog/old.json" 2>/dev/null && pass "진행 중 턴 상태를 새 폴더로 이관" || fail "old.json 미이관"
grep -q '"orbit"' "$R40/.git/orbit-state/worklog/both.json" && pass "새 폴더에 이미 있는 상태는 보존" || fail "기존 orbit 상태 덮어씀"
[ ! -d "$R40/.git/harness-state" ] && pass "옛 harness-state 폴더 제거" || fail "옛 상태 폴더 잔존"
UPD40B="$(node "$SKILL_DIR/scripts/install.mjs" update --repo "$R40" 2>&1)"
echo "$UPD40B" | grep -q '"stateMigration": null' && pass "재실행 시 옮길 것 없음(멱등)" || fail "재실행 stateMigration 비정상"

echo ""
echo "== 시나리오 41: 백그라운드 알림·진행 중 추가 입력 턴 처리 =="
R41="$WORK/scenario41"
new_repo "$R41"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R41" --project-name "Scenario41" --slug scenario41 --mode new >/dev/null 2>&1
S41_OUT="$(cd "$R41" && node - <<'NODE'
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const LOG = path.join(ROOT, 'scenario41-docs', 'worklog.md');
const STATE_DIR = path.join(ROOT, '.git', 'orbit-state', 'worklog');
let failed = false;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failed = true; };
const hook = (mode, input, env = {}) => {
  const r = spawnSync(process.execPath, ['scripts/worklog-hook.mjs', mode], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
};
const tokenOf = (res) => (res.json?.hookSpecificOutput?.additionalContext.match(/--turn-token "([0-9a-f]+)"/) || [])[1];
const record = (sid, token, ask = '물음', result = '결과') => spawnSync(process.execPath, ['scripts/worklog.mjs', 'append', 'claude', ask, result, '--session-id', sid, '--turn-token', token], { encoding: 'utf8' });
const state = (sid) => JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sid}.json`), 'utf8'));
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const count = (needle) => log().split(needle).length - 1;
const notice = (id, summary, result = '') => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n${result ? `<result>${result}</result>\n` : ''}<note>A task-notification fires each time.</note>\n</task-notification>`;

// (a) 일반 사용자 프롬프트 — 지금과 동일
{
  const sid = 'a';
  const b = hook('begin', { session_id: sid, prompt: '일반 질문 원문-SECRET41', prompt_id: 'pa' });
  const t = tokenOf(b);
  ok(t && /턴\(#1\)/.test(b.json.hookSpecificOutput.additionalContext), '(a) 사용자 턴 #1 열림·기록 지시');
  ok(hook('stop', { session_id: sid, prompt_id: 'pa' }).json?.decision === 'block', '(a) 미기록이면 Stop 차단');
  record(sid, t, '(a) 물음', '(a) 결과');
  ok(hook('stop', { session_id: sid, prompt_id: 'pa' }).out === '', '(a) 기록 후 Stop 통과');
  ok(!fs.readFileSync(path.join(STATE_DIR, 'a.json'), 'utf8').includes('SECRET41'), '(a) 상태 파일에 프롬프트 원문 없음');
}

// (b) 쉬는 동안 알림 1개 — 턴으로 세지 않고 다음 사용자 턴 직전에 한 항목으로 기록
{
  const sid = 'b';
  const before = count('(자동 알림');
  const n = hook('begin', { session_id: sid, prompt: notice('b1', 'Agent "채점" finished', '점수 8/10'), prompt_id: 'pb1' });
  ok(n.status === 0 && n.out === '', '(b) 알림 begin → 기록 지시 없음');
  ok(state(sid).pending === null && state(sid).counter === 0 && state(sid).notices.length === 1, '(b) 새 턴 없음·알림 버퍼 1건');
  ok(hook('stop', { session_id: sid, prompt_id: 'pb1' }).out === '', '(b) 알림 턴 Stop 차단 안 함');
  const u = hook('begin', { session_id: sid, prompt: '다음 질문', prompt_id: 'pb2' });
  ok(/턴\(#1\)/.test(u.json.hookSpecificOutput.additionalContext), '(b) 다음 사용자 턴이 #1(알림은 세지 않음)');
  ok(count('(자동 알림') === before + 1 && log().includes('점수 8/10'), '(b) 알림 요약 1항목 기록(결과 포함)');
  ok(state(sid).notices.length === 0, '(b) 버퍼 비움');
  record(sid, tokenOf(u));
}

// (c) 알림 여러 개 연달아 — 쉬는 동안 3건은 한 항목으로, 사용자 턴 도중 3건은 그 턴에 합침
{
  const sid = 'c';
  const before = count('(자동 알림');
  for (const i of [1, 2, 3]) {
    ok(hook('begin', { session_id: sid, prompt: notice(`c${i}`, `Agent c${i} finished`), prompt_id: `pc${i}` }).out === '', `(c) 쉬는 동안 알림 ${i} → 출력 없음`);
    ok(hook('stop', { session_id: sid, prompt_id: `pc${i}` }).out === '', `(c) 알림 ${i} Stop 통과`);
  }
  const u = hook('begin', { session_id: sid, prompt: '결과 정리해줘', prompt_id: 'pc9' });
  ok(count('(자동 알림') === before + 1 && log().includes('(자동 알림 3건)'), '(c) 쉬는 동안 알림 3건 → 한 항목');
  for (const i of [4, 5, 6]) hook('begin', { session_id: sid, prompt: notice(`c${i}`, `Agent c${i} finished`), prompt_id: 'pc9' });
  const st = state(sid);
  ok(st.counter === 1 && st.pending?.turn === 1 && st.pending.notices === 3, '(c) 턴 도중 알림 3건 → 같은 턴에 개수만 합침');
  record(sid, tokenOf(u));
  ok(hook('stop', { session_id: sid, prompt_id: 'pc9' }).out === '', '(c) 기록 후 Stop 통과');
  const after = hook('begin', { session_id: sid, prompt: notice('c7', 'late'), prompt_id: 'pc9' });
  ok(after.out === '' && state(sid).notices.length === 0 && state(sid).pending === null, '(c) 기록 끝난 턴 안에서 온 알림 → 조용히 넘김');
}

// (d) 진행 중 추가 메시지 — 같은 prompt_id면 같은 턴, 중단 뒤 다시 보낸 메시지는 앞 턴을 합침
{
  const sid = 'd';
  const u1 = hook('begin', { session_id: sid, prompt: '첫 요청', prompt_id: 'pd1' });
  const u2 = hook('begin', { session_id: sid, prompt: '작업 중 추가 요청', prompt_id: 'pd1' });
  ok(tokenOf(u1) === tokenOf(u2) && /합쳐졌습니다/.test(u2.json.hookSpecificOutput.additionalContext), '(d) 작업 중 추가 메시지 → 같은 턴·같은 토큰');
  ok(state(sid).counter === 1 && state(sid).orphans.length === 0, '(d) 새 턴·orphan 없음');
  record(sid, tokenOf(u1));
  ok(hook('stop', { session_id: sid, prompt_id: 'pd1' }).out === '', '(d) 한 번 기록으로 Stop 통과');

  const before = count('(자동 복구');
  const i1 = hook('begin', { session_id: sid, prompt: '중단될 요청', prompt_id: 'pd2' });
  const i2 = hook('begin', { session_id: sid, prompt: '다시 보낸 요청', prompt_id: 'pd3' });
  const st = state(sid);
  ok(st.orphans.length === 0 && st.pending.merged.length === 1 && st.pending.merged[0].token === tokenOf(i1), '(d) 중단 뒤 새 메시지 → 앞 턴을 orphan 대신 합침');
  ok(/앞 턴\(#2\)/.test(i2.json.hookSpecificOutput.additionalContext), '(d) 합친 사실을 알림');
  record(sid, tokenOf(i1), '옛 토큰 기록', '옛 토큰 결과');
  ok(hook('stop', { session_id: sid, prompt_id: 'pd3' }).json?.decision === 'block', '(d) 옛 토큰만으로는 새 턴이 닫히지 않음(H05)');
  record(sid, tokenOf(i2));
  ok(hook('stop', { session_id: sid, prompt_id: 'pd3' }).out === '' && state(sid).pending === null, '(d) 새 토큰 기록 → 닫힘');
  ok(count('(자동 복구') === before, '(d) 자동 복구 항목 0건');
}

// (e) 알림과 사용자 글이 한 입력으로 — 사용자 턴 하나(좁은 판별)
{
  const sid = 'e';
  const e = hook('begin', { session_id: sid, prompt: `${notice('e1', 'Agent e1 finished')}\n\n이것도 같이 봐줘`, prompt_id: 'pe' });
  ok(tokenOf(e) && state(sid).pending?.turn === 1 && state(sid).notices.length === 0, '(e) 알림+사용자 글 → 사용자 턴 1개');
  const broken = hook('begin', { session_id: 'e2', prompt: '<task-notification>\n<summary>task-id 없음</summary>\n</task-notification>', prompt_id: 'pe2' });
  ok(tokenOf(broken), '(e) task-id 없는 블록 → 판별 실패 시 사용자 턴(안전 기본값)');
}

// (f) 한 도착분에 begin이 여러 번 — 알림 1 + 사용자 메시지 2(붙여넣기), 같은 prompt_id
{
  const sid = 'f';
  const beforeNotice = count('(자동 알림');
  const beforeRecover = count('(자동 복구');
  const n = hook('begin', { session_id: sid, prompt: notice('f1', 'Workflow f1 finished'), prompt_id: 'pf' });
  const u1 = hook('begin', { session_id: sid, prompt: '사용자 메시지', prompt_id: 'pf' });
  const u2 = hook('begin', { session_id: sid, prompt: '<pasted_content>붙여넣기</pasted_content>', prompt_id: 'pf' });
  const st = state(sid);
  ok(n.out === '' && st.counter === 1 && tokenOf(u1) === tokenOf(u2), '(f) 턴 번호 1개만 발급');
  record(sid, tokenOf(u1));
  ok(hook('stop', { session_id: sid, prompt_id: 'pf' }).out === '' && state(sid).orphans.length === 0, '(f) 한 번 기록으로 끝·orphan 없음');
  ok(count('(자동 알림') === beforeNotice + 1 && count('(자동 복구') === beforeRecover, '(f) 알림은 요약 1항목·자동 복구 0건');
}

// (g) 중단된 사용자 턴이 남은 채 알림 턴이 끝남 — 알림 턴 Stop은 차단하지 않고, 다음 사용자 턴이 합친다
{
  const sid = 'g';
  hook('begin', { session_id: sid, prompt: '중단될 요청', prompt_id: 'pg1' });
  hook('begin', { session_id: sid, prompt: notice('g1', 'Agent g1 finished'), prompt_id: 'pg2' });
  ok(hook('stop', { session_id: sid, prompt_id: 'pg2' }).out === '', '(g) 다른 턴(알림 턴)의 Stop → 차단 안 함');
  const u = hook('begin', { session_id: sid, prompt: '다시 요청', prompt_id: 'pg3' });
  ok(state(sid).pending.merged.length === 1 && state(sid).orphans.length === 0, '(g) 다음 사용자 턴이 미기록 턴을 합침');
  record(sid, tokenOf(u));
  ok(hook('stop', { session_id: sid, prompt_id: 'pg3' }).out === '', '(g) 기록 후 통과');
}

// (h) 알림이 20건 쌓이면 사용자 턴을 기다리지 않고 한 항목으로 기록
{
  const sid = 'h';
  const before = count('(자동 알림');
  for (let i = 1; i <= 20; i += 1) hook('begin', { session_id: sid, prompt: notice(`h${i}`, `h${i}`), prompt_id: `ph${i}` });
  ok(count('(자동 알림') === before + 1 && log().includes('(자동 알림 20건)') && state(sid).notices.length === 0, '(h) 20건 → 즉시 한 항목');
}

// (i) 동시 도착 — 알림 begin 8개를 병렬로 돌려도 버퍼 갱신이 유실되지 않음(상태 잠금)
{
  const sid = 'i';
  const jobs = Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/worklog-hook.mjs', 'begin']);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ session_id: sid, prompt: notice(`i${i}`, `i${i}`), prompt_id: `pi${i}` }));
  }));
  Promise.all(jobs).then(() => {
    ok(state(sid).notices.length === 8, `(i) 병렬 begin 8개 → 버퍼 8건(got ${state(sid).notices.length})`);

    // (j) 진단 덤프 — 원문 없이 태그 뼈대만
    hook('begin', { session_id: 'j', prompt: '덤프원문-SECRET41J', prompt_id: 'pj' }, { ORBIT_HOOK_DEBUG: '1' });
    const dumps = fs.existsSync(path.join(STATE_DIR, 'dumps')) ? fs.readdirSync(path.join(STATE_DIR, 'dumps')) : [];
    const text = dumps.map((name) => fs.readFileSync(path.join(STATE_DIR, 'dumps', name), 'utf8')).join('');
    ok(dumps.length === 1 && text.includes('"prompt_id": "pj"') && !text.includes('SECRET41J'), '(j) ORBIT_HOOK_DEBUG=1 → 덤프 1건·원문 없음');
    ok(!log().includes('SECRET41'), '(a~j) worklog에 프롬프트 원문 없음');
    process.exit(failed ? 1 : 0);
  });
}
NODE
)"; S41_RC=$?
echo "${S41_OUT}"
[ "${S41_RC}" = "0" ] || fail "시나리오 41 하위 항목 실패(위 ❌ 확인)"

echo ""
echo "== 시나리오 43: 에이전트 정책 훅은 orbit 설치 저장소에서만 =="
POLICY43="$SKILL_DIR/../../hooks/agent-policy.mjs"
R43="$WORK/scenario43"; P43="$WORK/plain43"
mkdir -p "$R43/.claude" "$R43/sub" "$P43" && git -C "$R43" init -q && git -C "$P43" init -q
echo '{}' > "$R43/.claude/orbit-manifest.json"
policy43() { printf '%s' "$2" | env -u CLAUDE_PROJECT_DIR $1 node "$POLICY43" 2>/dev/null; }
# 입력 JSON은 변수에 먼저 담는다(bash 3.2는 "$( ... \" ... )" 안의 이스케이프 따옴표를 잘못 나눈다).
J43_OMIT='{"tool_name":"Agent","cwd":"'"$R43"'","tool_input":{}}'
J43_FORK='{"tool_name":"Agent","cwd":"'"$R43/sub"'","tool_input":{"subagent_type":"fork"}}'
J43_PLAIN='{"tool_name":"Agent","cwd":"'"$P43"'","tool_input":{}}'
J43_PLAIN_GP='{"tool_name":"Agent","cwd":"'"$P43"'","tool_input":{"subagent_type":"general-purpose"}}'
J43_MODE='{"tool_name":"Agent","cwd":"'"$R43"'","tool_input":{"subagent_type":"orbit:clean-subagent"}}'
OUT43_OMIT="$(policy43 "" "$J43_OMIT")"
OUT43_FORK="$(policy43 "" "$J43_FORK")"
OUT43_PLAIN="$(policy43 "" "$J43_PLAIN")"
OUT43_PLAIN_GP="$(policy43 "CLAUDE_PROJECT_DIR=$P43" "$J43_PLAIN_GP")"
OUT43_MODE="$(policy43 "" "$J43_MODE")"
OUT43_OFF="$(policy43 "ORBIT_AGENT_POLICY=off" "$J43_OMIT")"
echo "$OUT43_OMIT" | grep -q '"permissionDecision":"deny"' && pass "orbit 저장소: 타입 생략 거부" || fail "orbit 저장소에서 타입 생략을 허용함"
echo "$OUT43_FORK" | grep -q '"permissionDecision":"deny"' && pass "orbit 저장소 하위 폴더: fork 거부" || fail "하위 폴더에서 fork를 허용함"
[ -z "$OUT43_PLAIN" ] && pass "orbit 없는 저장소: 간섭 안 함" || fail "orbit 없는 저장소에서 거부함"
[ -z "$OUT43_PLAIN_GP" ] && pass "orbit 없는 프로젝트 폴더: 간섭 안 함" || fail "orbit 없는 프로젝트 폴더에서 거부함"
[ -z "$OUT43_MODE" ] && pass "orbit 모드는 허용" || fail "orbit 모드를 거부함"
[ -z "$OUT43_OFF" ] && pass "ORBIT_AGENT_POLICY=off 탈출구" || fail "끄기가 동작하지 않음"

echo ""
echo "== 시나리오 44: recent — 앞 구간 요약·알림 묶음 제외·머리글 =="
R44="$WORK/scenario44"
new_repo "$R44"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R44" --project-name "Scenario44" --slug scenario44 --mode new >/dev/null 2>&1
for i in $(seq 1 12); do
  (cd "$R44" && node scripts/worklog.mjs append claude "q$i" "r$i" >/dev/null 2>&1)
  if [ $((i % 3)) = 0 ]; then (cd "$R44" && node scripts/worklog.mjs summary claude "요약$i" >/dev/null 2>&1); fi
done
(cd "$R44" && node scripts/worklog.mjs append claude "(자동 알림 2건) a · b" "사용자 턴 사이에 도착한 백그라운드 작업 알림을 훅이 묶어 기록함 — completed: x" >/dev/null 2>&1)
(cd "$R44" && node scripts/worklog.mjs append claude "q14" "r14" >/dev/null 2>&1)
OUT44="$(cd "$R44" && node scripts/worklog.mjs recent claude)"
OUT44C="$(cd "$R44" && node scripts/worklog.mjs recent claude --mode compact)"
CNT44="$(echo "$OUT44" | grep -c '^## \[#')"
[ "$CNT44" = "8" ] && pass "최근 턴 8개" || fail "최근 턴 개수=${CNT44}(8 기대)"
echo "$OUT44" | grep -q '^## \[#6\]' && echo "$OUT44" | grep -q '^## \[#14\]' && pass "턴 창은 #6~#14(알림 제외)" || fail "턴 창이 기대와 다름"
echo "$OUT44" | grep -q '^## \[#13\]' && fail "알림 묶음 항목이 들어감" || pass "알림 묶음 항목 제외"
echo "$OUT44" | grep -q '^## \[요약 #1~3\]' && echo "$OUT44" | grep -q '^## \[요약 #4~6\]' && pass "앞 구간 요약(#1~3·#4~6) 포함" || fail "앞 구간 요약 누락"
echo "$OUT44" | grep -q '^## \[요약 #7~9\]\|^## \[요약 #10~12\]' && fail "최근 8턴과 겹치는 요약이 들어감" || pass "겹치는 요약 제외"
ORDER44="$(echo "$OUT44" | grep -n '^## \[요약' | head -1 | grep -c '요약 #1~3')"
[ "$ORDER44" = "1" ] && pass "요약은 오래된 것부터" || fail "요약 순서 오류"
echo "$OUT44" | head -1 | grep -q '이전 세션 최근 맥락' && pass "기본 머리글" || fail "기본 머리글 오류"
echo "$OUT44C" | head -1 | grep -q '컴팩션 전 기록' && pass "compact 머리글" || fail "compact 머리글 오류"
LEN44="$(printf '%s' "$OUT44" | wc -m | tr -d ' ')"
[ "$LEN44" -le 10000 ] && pass "출력 1만 자 이하(${LEN44})" || fail "출력이 1만 자 초과(${LEN44})"

echo ""
echo "== 시나리오 45: worklog 판단(--why)·발견(--found) 칸 =="
R45="$WORK/scenario45"
new_repo "$R45"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R45" --project-name "Scenario45" --slug scenario45 --mode new >/dev/null 2>&1
LOG45="$R45/scenario45-docs/worklog.md"
(cd "$R45" && node scripts/worklog.mjs append claude "q1" "r1" --why "A를 고름 / B는 느려서 버림 / 3.5초" --found "훅 출력은 1만 자 상한" >/dev/null 2>&1)
(cd "$R45" && node scripts/worklog.mjs append claude "q2" "r2" >/dev/null 2>&1)
(cd "$R45" && node scripts/worklog.mjs append claude "q3" "r3" --found "$(printf '첫 줄\n## [#99] 가짜 머리글')" >/dev/null 2>&1)
grep -q '^- 판단: A를 고름 / B는 느려서 버림 / 3.5초$' "$LOG45" && pass "판단 칸 기록" || fail "판단 칸 없음"
grep -q '^- 발견: 훅 출력은 1만 자 상한$' "$LOG45" && pass "발견 칸 기록" || fail "발견 칸 없음"
B45="$(sed -n '/^## \[#2\]/,/^$/p' "$LOG45")"
echo "$B45" | grep -q '판단\|발견' && fail "값 없는 턴에 선택 칸이 생김" || pass "값 없으면 선택 칸 없음"
grep -q '^## \[#99\]' "$LOG45" && fail "선택 칸 줄바꿈으로 가짜 머리글 생성" || pass "선택 칸도 한 줄로 접힘"
(cd "$R45" && node scripts/worklog.mjs append claude "q4" "r4" >/dev/null 2>&1)
grep -q '^## \[#4\]' "$LOG45" && pass "선택 칸 뒤 번호 이어짐" || fail "번호 이어지지 않음"
OUT45="$(cd "$R45" && node scripts/worklog.mjs recent claude)"
echo "$OUT45" | grep -q '^- 판단: A를 고름' && [ "$(echo "$OUT45" | grep -c '^## \[#')" = "4" ] && pass "recent가 선택 칸 포함 항목을 그대로 넣음" || fail "recent 파싱 오류"
CU45="$(cd "$R45" && node scripts/worklog.mjs catchup codex)"
echo "$CU45" | grep -q '^- 발견: 훅 출력은 1만 자 상한' && pass "catchup이 선택 칸을 넘김" || fail "catchup 파싱 오류"

echo ""
echo "== 시나리오 46: 모델이 이미 기록한 알림은 묶지 않기·임시 경로 줄이기 =="
R46="$WORK/scenario46"
new_repo "$R46"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R46" --project-name "Scenario46" --slug scenario46 --mode new >/dev/null 2>&1
S46_OUT="$(cd "$R46" && node - <<'NODE'
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const LOG = path.join(process.cwd(), 'scenario46-docs', 'worklog.md');
const MARK = '훅이 묶어 기록함';
let failed = false;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failed = true; };
const hook = (mode, input) => spawnSync(process.execPath, ['scripts/worklog-hook.mjs', mode], { input: JSON.stringify(input), encoding: 'utf8' });
const tokenOf = (r) => (r.stdout.match(/--turn-token \\?"([0-9a-f]+)\\?"/) || [])[1];
const append = (...args) => spawnSync(process.execPath, ['scripts/worklog.mjs', 'append', 'claude', ...args], { encoding: 'utf8' });
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const bundles = () => log().split(MARK).length - 1;
const notice = (id, summary, result) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n<result>${result}</result>\n</task-notification>`;

// (a) 알림 → 모델이 그 턴에 직접 기록 → 다음 사용자 턴: 묶음 없음
hook('begin', { session_id: 's46', prompt: notice('a1', 'Agent A finished', '보고서 완료'), prompt_id: 'p1' });
append('(자동 알림) A 결과 반영', '문서 고침');
const u1 = hook('begin', { session_id: 's46', prompt: '다음 질문', prompt_id: 'p2' });
ok(bundles() === 0, '(a) 모델이 이미 기록한 알림은 묶음을 만들지 않음');
append('다음 질문', '답', '--session-id', 's46', '--turn-token', tokenOf(u1));

// (b) 모델 기록 앞의 알림은 빼고, 그 뒤 알림만 묶음
hook('begin', { session_id: 's46', prompt: notice('b1', 'Agent B1 finished', '앞 알림'), prompt_id: 'p3' });
append('(자동 알림) B1 반영', '처리');
hook('begin', { session_id: 's46', prompt: notice('b2', 'Agent B2 finished', '파일: `/private/tmp/claude-501/-Users-x/sess/scratchpad/voc-b2.md` 저장'), prompt_id: 'p4' });
const u2 = hook('begin', { session_id: 's46', prompt: '또 질문', prompt_id: 'p5' });
ok(bundles() === 1 && log().includes('Agent B2 finished'), '(b) 기록 뒤에 온 알림만 묶음 1개');
const lastBundle = log().slice(log().lastIndexOf('## [#'));
ok(!lastBundle.includes('B1 finished'), '(b) 이미 기록된 앞 알림은 묶음에서 빠짐');
ok(lastBundle.includes('…/voc-b2.md') && !lastBundle.includes('/private/tmp'), '(b) 임시 경로는 파일 이름만');
append('또 질문', '답', '--session-id', 's46', '--turn-token', tokenOf(u2));
process.exit(failed ? 1 : 0);
NODE
)"; S46_RC=$?
echo "${S46_OUT}"
[ "${S46_RC}" = "0" ] || fail "시나리오 46 하위 항목 실패(위 ❌ 확인)"

echo ""
echo "== 시나리오 47: worklog 훅 배선이 오류를 숨기지 않음 =="
R47="$WORK/scenario47"
new_repo "$R47"
node "$SKILL_DIR/scripts/install.mjs" apply --repo "$R47" --project-name "Scenario47" --slug scenario47 --mode new >/dev/null 2>&1
grep -q '2>/dev/null || true' "$R47/.claude/settings.json" && fail "새 설치에 오류 숨김 배선이 남음" || pass "새 설치는 오류를 숨기지 않음"
# 옛 설치본 흉내: 오류 숨김 배선 + 사용자 훅 하나
node -e '
const fs = require("fs"); const f = process.argv[1];
const s = JSON.parse(fs.readFileSync(f, "utf8"));
for (const ev of ["SessionStart", "UserPromptSubmit"]) for (const g of s.hooks[ev]) for (const h of g.hooks)
  if (/worklog\.mjs\\?" (recent|catchup)/.test(h.args[1])) h.args[1] += " 2>/dev/null || true";
s.hooks.SessionStart.push({ hooks: [{ type: "command", command: "echo user-hook-47" }] });
fs.writeFileSync(f, JSON.stringify(s, null, 2));
' "$R47/.claude/settings.json"
[ "$(grep -c '2>/dev/null || true' "$R47/.claude/settings.json")" = "2" ] && pass "옛 배선 흉내 준비(2곳)" || fail "옛 배선 흉내 준비 실패"
node "$SKILL_DIR/scripts/install.mjs" update --repo "$R47" >/dev/null 2>&1
grep -q '2>/dev/null || true' "$R47/.claude/settings.json" && fail "update 뒤에도 오류 숨김 배선이 남음" || pass "update가 옛 배선을 교체"
RC47="$(grep -c 'worklog.mjs\\" recent claude' "$R47/.claude/settings.json")"
[ "$RC47" = "1" ] && pass "recent 배선 중복 없음" || fail "recent 배선 개수=${RC47}(1 기대)"
grep -q 'user-hook-47' "$R47/.claude/settings.json" && pass "사용자 훅 보존" || fail "사용자 훅이 사라짐"
rm -f "$R47/scenario47-docs/worklog.md"
OUT47="$(cd "$R47" && node scripts/worklog.mjs recent claude 2>&1)"; RC47A=$?
[ "$RC47A" = "0" ] && [ -z "$OUT47" ] && pass "worklog 없으면 조용히 통과" || fail "worklog 없음에서 rc=${RC47A}·출력=${OUT47}"
echo '{broken' > "$R47/scenario47-docs/worklog-state.json"
ERR47="$(cd "$R47" && node scripts/worklog.mjs catchup claude 2>&1 >/dev/null)"; RC47B=$?
[ "$RC47B" != "0" ] && [ "$RC47B" != "2" ] && [ -n "$ERR47" ] && pass "상태 파일이 깨지면 오류를 알리되 막지 않음(rc=${RC47B})" || fail "깨진 상태에서 rc=${RC47B}·stderr 없음"

if [ "$FAIL" = "0" ]; then
  echo "전체 통과."
  exit 0
else
  echo "하나 이상 실패 — 위 ❌ 항목을 확인하세요."
  exit 1
fi
