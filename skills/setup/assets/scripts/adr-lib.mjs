// ADR 감지 3단계의 글(판정 질문·체크리스트)을 한곳에 둔다 — adr-hook(1단계 통과 시 주입)과 worklog(--decision 기록 시 출력)가 같이 쓴다.
// 결정: D-ADR감지-3단계-Jev-261016-235900. 시험 근거: 장기기억 비교 시험 adr-gate(대본 300턴, 사용자 기준 정답).

// 1단계 판정 질문(Jev 6판). 사용자 말 한 문장만 보고 '결정을 선언했나'를 묻는다.
// 300턴 시험: 기준 0.5에서 결정 30개 중 놓침 0, 결정 아닌 262개 중 잘못 통과 15(5.7%), 통과 53턴.
export const GATE_QUESTION = 'Judging only this one sentence, the user explicitly declares a decision or standing rule in their own words: phrases like "let us go with X" (~로 하자), "we decided" (~하기로 했어), "I will go with" (~로 할게), "from now on" (앞으로, 이제부터), "always" (늘, 항상), "fix it as / unify to" (~로 고정, ~로 통일), "do not / never do X" (~하지 마, ~는 쓰지 마), "Y instead of X" (X 말고 Y로), or "we will not do X" (~는 안 하는 걸로). This includes decisions about the environment: which device, server, OS, or runtime version to deploy or run on, e.g. "we decided to deploy on a Raspberry Pi 4" (라즈베리파이 4에 배포하기로 했어), "let us run it on Node 22.12" (Node 22.12로 가자). Answer NO for a request that just asks for work to be done, even if the request contains a specific value or method, e.g. "make the port 4310", "add a category", "move it to a table", "add an index", "trim spaces", "restore the old retention", "put the rules at the top of the file", "build this endpoint". Also NO for questions, status checks, plain statements of fact, and session closings like "let us stop here for today" (오늘은 여기까지 하자).';

// 2·3단계와 묻는 방식. 1단계를 통과한 턴(사용자 말)이나 AI가 대안 중 하나를 고른 턴(worklog --decision)에만 보인다.
export const CHECKLIST = [
  'ADR 2·3단계를 이 결정에 적용한다. 둘 다 예일 때만 응답 끝에 "이걸 ADR로 남길까요?"라고 묻는다. ADR은 스스로 만들지 않고 사용자가 승인할 때만 쓴다. 아니면 아무 말도 하지 않는다.',
  '2단계 — 무엇을 건드리나(하나라도 예): ①구조(파일·모듈을 새로 만들거나 나누거나 합침, 데이터 저장 위치·방식) ②품질 수치·정책(보안·인증, 크기·개수·시간 한도, 백업·복구, 로그·모니터링, 시간대·숫자 정밀도, 보관·삭제 기간) ③의존성(패키지, 외부 서비스, OS 기능(cron 등), 기기·런타임 버전을 더하거나 빼거나 금지) ④바깥 모양(API 경로, 응답 모양, 오류 code, 파일 형식, 포트, 환경 변수, 명령 이름, 정해진 실행 시각) ⑤작업 규칙(테스트 방법, 커밋·변경 기록, 이름 규칙, 문서 위치, 배포 절차). 사람·약속·일정·별명·답하는 말투는 어느 영역도 아니다 — ADR이 아니라 기억으로 보낸다.',
  '3단계 — 앞으로 다른 작업에도 적용되나: 이 결정을 모르는 사람이나 AI가 나중에 다른 일을 하다가 어기거나 모르고 바꿀 수 있으면 예.',
  '제외: 변수·함수 하나의 이름, 규칙을 새로 세우지 않는 버그 수정, 구조가 안 바뀌는 리팩터링, 문구 수정, 한 번만 하는 작업. 예전 결정을 번복하면 언제나 묻는다.',
  '승인되어 ADR을 쓸 때: 코드로 지킬 수 있는 결정이면 그 결정을 지키는 테스트를 함께 만들고 테스트 이름에 결정 내용과 ADR 이름을 넣는다. 결정이 적용된 코드 자리에는 ADR 이름을 주석으로 단다(ADR=왜, 테스트=지키기).',
].join('\n');

export const GATE_THRESHOLD = 0.5;
export const JEV_MODEL = 'jev-1.13.0'; // 문턱을 이 판에 맞춰 쟀다 — 판이 바뀌면 다시 잰다
