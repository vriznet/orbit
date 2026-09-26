// 비밀값 가림 — orbit이 디스크에 남기는 기억(컴팩션 상태 파일·요약, 대화 글 사본, 도구 색인)에
// 들어가기 전에 알려진 모양의 비밀값을 [REDACTED]로 바꾼다. 완벽하지 않다: 모양이 알려지지
// 않은 비밀값은 그대로 남을 수 있다. 결정: D-프로젝트-기억-분담(결정 6).
//
// 네 단계, 구체적인 것부터:
//   1. PEM 개인키 덩어리(끝 표지가 잘렸으면 글 끝까지)
//   2. 주소 안 비밀번호(scheme://이름:비밀번호@호스트)
//   3. 이름표 없이도 알아보는 토큰 모양(sk-ant-, sk-, ghp_, github_pat_, AKIA, Bearer …)
//   4. 이름이 비밀 같은 값(API_KEY=…, "ANTHROPIC_AUTH_TOKEN": "…"). 구분자는 `:`·`=`만 받는다 —
//      빈칸까지 받으면 "secret information" 같은 평범한 문장이 가려진다. 한 번·두 번 이스케이프된
//      JSON의 따옴표(\" \\\")도 구분자로 받는다.
// 모든 패턴은 길이가 정해진 문자 모임을 써서 되돌아가기가 폭주하지 않는다.

export const REDACTED = '[REDACTED]';

const PEM = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g;

const URL_PASSWORD = /(\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s/:@"'\\]{1,256}:)([^\s@"'\\/]{1,256})(@)/g;

const KNOWN_TOKENS = new RegExp([
  'sk-ant-[A-Za-z0-9_-]{16,}',
  'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}',
  '\\bsk-[A-Za-z0-9]{20,}',
  '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}',
  '\\bgithub_pat_[A-Za-z0-9_]{30,}',
  '\\bglpat-[A-Za-z0-9_-]{20,}',
  '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
  '\\bAIza[0-9A-Za-z_-]{35}',
  '\\bxox[abposr]-[A-Za-z0-9-]{10,}',
  '\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',
  '\\bnpm_[A-Za-z0-9]{36}',
  '\\bhf_[A-Za-z0-9]{30,}',
  '\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
  'https://hooks\\.slack\\.com/services/[A-Za-z0-9/]{10,}',
].join('|'), 'g');

const BEARER = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/=-]{16,4096})/gi;

// 비밀 같은 낱말과 이름의 나머지(ANTHROPIC_AUTH_TOKEN → AUTH + _TOKEN)
const SECRET_LABEL = '((?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|pwd'
  + '|authorization|auth|credentials?|session[_-]?(?:id|key)|cookie)[A-Za-z0-9_-]{0,40})';

// "이름": "값" 꼴 — 따옴표 안의 값은 빈칸이 섞여도 닫는 따옴표까지 가린다.
const QUOTED_LABELED = new RegExp(
  SECRET_LABEL
  + '((?:\\\\{0,8}["\'])?[ \\t]{0,8}[:=][ \\t]{0,8}\\\\{0,8}["\'])'
  + '((?:bearer|basic|token|bot)[ \\t]+)?'
  + '([^"\'\\\\\\n]{4,4096})',
  'gi',
);

const LABELED = new RegExp(
  SECRET_LABEL
  // 구분자: `:` 또는 `=`가 꼭 하나 있어야 한다. 앞뒤의 따옴표(이스케이프 포함)·빈칸은 허용
  + '((?:\\\\{0,8}["\']|[ \\t]){0,8}[:=](?:\\\\{0,8}["\']|[ \\t]){0,8})'
  + '((?:bearer|basic|token|bot)[ \\t]+)?'
  // 값은 따옴표·역슬래시·빈칸·흔한 구분 기호에서 멈춘다
  + '([^\\s"\'\\\\,;&<>{}\\[\\]()]{6,4096})',
  'gi',
);

const AUTH_SCHEMES = /^(?:bearer|basic|token|bot)$/i;

export function redact(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);
  text = text.replace(PEM, REDACTED);
  text = text.replace(URL_PASSWORD, (_, head, _secret, at) => `${head}${REDACTED}${at}`);
  text = text.replace(KNOWN_TOKENS, REDACTED);
  text = text.replace(BEARER, (_, word, gap) => `${word}${gap}${REDACTED}`);
  const replaceLabeled = (whole, label, separator, scheme, secret) => (
    secret.startsWith(REDACTED) || AUTH_SCHEMES.test(secret) ? whole : `${label}${separator}${scheme || ''}${REDACTED}`
  );
  text = text.replace(QUOTED_LABELED, replaceLabeled);
  text = text.replace(LABELED, replaceLabeled);
  return text;
}

// 자르기 전에 조금 더 넓게 가린다 — 자르는 자리에 걸친 비밀값의 앞 절반이 남지 않게.
export function redactPrefix(value, limit, margin = 512) {
  if (value === null || value === undefined) return value;
  return redact(String(value).slice(0, limit + margin)).slice(0, limit);
}
