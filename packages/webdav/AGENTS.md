# packages/webdav (`@genoffice/webdav`)

WebDAV 연결의 뒷단(main) 코드다. 사용자가 입력한 서버 주소 확인, Basic·Digest 로그인, 폴더 목록(PROPFIND), 내려받기(GET), 조건부 올리기(PUT)를 담는다. 결정 기록 0117.

## 맡은 범위

- 주소: `parseServerUrl`(`src/client.ts`). http·https만, 주소 안의 계정 정보와 쿼리는 거절한다. 평문 HTTP는 `insecure`로 표시한다.
- 로그인: `src/auth.ts`. `chooseScheme`(Digest 우선), `digestHeader`(MD5·SHA-256, `qop=auth`), `basicHeader`.
- 호출: `WebDavClient`(`src/client.ts`). `check`, `list`, `stat`, `download`, `upload`. 결과는 `{ ok: true, … }` 또는 `{ ok: false, kind }`이고 던지지 않는다. 경로는 연결한 폴더(`baseUrl`) 기준의 상대 경로이고, 퍼센트 인코딩은 클라이언트가 한다.
- 응답 읽기: `parseMultiStatus`(`src/xml.ts`). 207 본문을 지역 이름으로 읽는 작은 해석기다.

## 맡지 않는 것 (경계)

- 비밀번호 암호화·보관은 껍데기 앱이 한다(`apps/shell/src/main/webdav/webdav-servers.ts`, Electron `safeStorage`). 이 패키지는 Electron을 import하지 않는다.
- 파일을 탭으로 여는 일, 저장 뒤 올리기를 정하는 일, 충돌을 사람에게 묻는 일은 껍데기 앱의 `webdav-files.ts`가 한다.
- 열 수 있는 확장자와 올리기 형식은 `@genoffice/google-drive`의 `formats.ts`를 껍데기 앱이 가져다 쓴다. 이 패키지에는 두지 않는다.

## 항상 지켜야 하는 것

- 응답 본문의 XML을 진짜 XML 해석기로 읽지 않는다. DTD·외부 엔티티를 풀지 않고, `&amp;` 등 다섯 기본 엔티티와 숫자 문자 참조만 푼다.
- 목록의 `href`에 `..` 구간이 있으면 그 항목을 버린다. 연결한 폴더 밖 항목은 목록에 내지 않는다.
- 로그인 정보는 `Authorization` 헤더로만 서버에 간다. 리다이렉트는 같은 출처(origin)로만 따라가고, 다른 서버나 다른 스킴이면 `network`로 끝낸다. 401은 한 번만 다시 시도한다.
- 쓰기는 마지막으로 본 상태가 그대로일 때만 한다. 강한 ETag가 있으면 `If-Match`, 약한 ETag나 태그가 없으면 올리기 직전에 `PROPFIND`로 보고 `differs`로 비교한다. 새 파일은 `If-None-Match: *`다. 서버가 달라졌으면 `changed`를 돌려주고 덮어쓰지 않는다.
- 내려받기는 크기 상한(호출자가 준 `maxBytes`)을 지키고, 넘으면 읽기를 멈춘다.
- 비밀번호와 파일 내용을 오류 글에 싣지 않는다.

## 테스트

- 실행: `npm run test -w @genoffice/webdav`, `npm run typecheck -w @genoffice/webdav`.
- 테스트는 네트워크에 닿지 않는다. 모든 호출은 주입한 `fetch`를 지난다.
- 바꾸면 반드시 테스트하는 것: Digest 응답값(RFC 2617 예시), 같은 출처 리다이렉트만 따라가는지, `If-Match`·`If-None-Match` 헤더, 약한 ETag일 때 먼저 보는 동작, 연결한 폴더 밖·`..` 항목 제외, 크기 상한.
