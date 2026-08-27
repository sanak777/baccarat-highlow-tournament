# 바카라산악회 하이로우 토너먼트

24인 실시간 하이로우 토너먼트입니다. Node.js, Express, Socket.IO로 동작합니다.

## 관리자 기능

- 게임 시작: 착석자는 유지하고 첫 라운드를 시작합니다.
- 게임 재시작: 좌석은 유지하며 전원 보유금, 카드, 라운드, 랭킹을 초기화합니다.
- 게임 종료(방폭): 모든 참가자와 좌석, 게임 상태를 제거합니다.

## Render 배포

1. 이 저장소로 새 Web Service를 생성합니다.
2. Blueprint를 사용하면 `render.yaml`이 자동 적용됩니다.
3. 환경변수 `ADMIN_PASSWORD`에 방장 비밀번호를 입력합니다.
4. Build Command는 `npm install`, Start Command는 `npm start`입니다.

서버 상태 확인: `/health`
