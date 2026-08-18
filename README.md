# TiCa Relay

TiCa 릴레이 소설 프로젝트를 매년 독립적으로 운영하기 위한 웹 도구입니다.

## 주요 기능

- 프로젝트 생성, 참가 신청, 참가자 추첨, 집필 순서 추첨
- 참가자는 개인 링크로 접속해 최근 문장만 보고 한 문장 작성
- 관리자는 전체 원고, 참가자, 진행 상태, 검수 상태 확인
- Owner 승인 기반 관리자 계정 구조
- 최종 원고 TXT 다운로드

## 로컬 실행

```bash
npm install
npm start
```

브라우저에서 엽니다.

```text
http://localhost:3000
```

로컬에서 `DATABASE_URL`이 없으면 `data/db.json`에 저장합니다.

## 실제 배포 구조

운영 배포에서는 JSON 파일 대신 PostgreSQL을 사용합니다.

```text
Render/Railway/Fly/VPS
        +
Neon PostgreSQL
```

`DATABASE_URL` 환경변수가 있으면 서버가 자동으로 PostgreSQL 저장소를 사용합니다.

필요한 환경변수:

```text
DATABASE_URL=postgresql://...
TICA_STORAGE=postgres
NODE_VERSION=20
```

## Vercel 배포

1. GitHub에 이 프로젝트를 올립니다.
2. Vercel에서 Add New Project를 누르고 GitHub 저장소를 선택합니다.
3. Framework Preset은 Other로 둡니다.
4. Environment Variables에 아래 값을 추가합니다.

```text
DATABASE_URL=Neon에서 복사한 connection string
TICA_STORAGE=postgres
NODE_VERSION=20
```

5. Deploy를 누릅니다.
6. 배포 후 Vercel이 제공하는 `https://...vercel.app` 주소를 사용합니다.

참가 신청 링크와 개인 작성 링크는 배포 주소를 기준으로 자동 생성됩니다.

```text
https://...vercel.app/?apply=프로젝트ID
https://...vercel.app/?token=개인토큰
```

## Render 배포

1. Neon에서 PostgreSQL 프로젝트를 만들고 connection string을 복사합니다.
2. GitHub에 이 프로젝트를 올립니다.
3. Render에서 New Web Service를 만들고 GitHub 저장소를 연결합니다.
4. Build Command는 `npm install`, Start Command는 `npm start`로 설정합니다.
5. Environment에 `DATABASE_URL`, `TICA_STORAGE=postgres`, `NODE_VERSION=20`을 추가합니다.
6. 배포 후 Render가 제공하는 `https://...onrender.com` 주소를 사용합니다.

`render.yaml`을 사용하면 Render Blueprint로도 배포할 수 있습니다.
