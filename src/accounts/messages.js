const messages = {
  en: {
    title: "👥 Codex accounts", private: "🔐 Account management is available to account administrators in private chat only.",
    add: "🔐 Sign in / add", check: "🔎 Check", remove: "🗑 Remove", cancel: "Cancel", use: "Use",
    rotate: "🔁 Auto-rotate", on: "ON", off: "OFF", ready: "Ready", pending: "Signing in", reauth: "Sign-in required",
    instruction: "Select an account for future tasks. Running tasks keep their current account.",
    commands: "/reauth [name] · /accounts rename <id> <name> · /accounts use <id>",
    start: "🔐 Starting ChatGPT device login…", busy: "A login is already pending. Use /reauth cancel to cancel it.",
    code: "Open the official sign-in page and enter this one-time code. Complete sign-in in your browser.",
    done: "✅ Account added. Select it below to use it.", cancelled: "🔐 Sign-in cancelled.", failed: "Could not complete account action:",
    deleteConfirm: "Remove this saved login and its account-local session files?", next: "✅ Account selected for the next task.",
    rename: "Rename with", cooldown: "Cooldown until", usage: "Primary window usage", refreshed: "✅ Account status refreshed."
  },
  ko: {
    title: "👥 Codex 계정", private: "🔐 계정 관리는 계정 관리자와의 개인 채팅에서만 사용할 수 있습니다.",
    add: "🔐 로그인·계정 추가", check: "🔎 상태 확인", remove: "🗑 삭제", cancel: "취소", use: "사용",
    rotate: "🔁 자동 계정 전환", on: "켜짐", off: "꺼짐", ready: "사용 가능", pending: "로그인 중", reauth: "로그인 필요",
    instruction: "다음 작업에 사용할 계정을 선택하세요. 실행 중인 작업은 시작한 계정을 유지합니다.",
    commands: "/reauth [이름] · /accounts rename <id> <이름> · /accounts use <id>",
    start: "🔐 ChatGPT 기기 로그인을 준비하고 있습니다…", busy: "진행 중인 로그인이 있습니다. /reauth cancel로 취소할 수 있습니다.",
    code: "공식 로그인 페이지를 열고 아래 일회용 코드를 입력하세요. 브라우저에서 로그인을 완료해 주세요.",
    done: "✅ 계정을 추가했습니다. 아래에서 선택하면 사용할 수 있습니다.", cancelled: "🔐 로그인을 취소했습니다.", failed: "계정 작업을 완료하지 못했습니다:",
    deleteConfirm: "저장된 로그인과 이 계정의 로컬 대화 기록을 삭제할까요?", next: "✅ 다음 작업에 사용할 계정을 선택했습니다.",
    rename: "이름 변경", cooldown: "다시 시도할 시각", usage: "기본 사용량 구간", refreshed: "✅ 계정 상태를 확인했습니다."
  },
  "zh-tw": {
    title: "👥 Codex 帳號", private: "🔐 帳號管理僅限管理員在私人聊天中使用。",
    add: "🔐 登入／新增", check: "🔎 檢查", remove: "🗑 移除", cancel: "取消", use: "使用",
    rotate: "🔁 自動切換", on: "開啟", off: "關閉", ready: "可使用", pending: "登入中", reauth: "需要登入",
    instruction: "選擇後續工作的帳號。執行中的工作會保留原帳號。",
    commands: "/reauth [名稱] · /accounts rename <id> <名稱> · /accounts use <id>",
    start: "🔐 正在準備 ChatGPT 裝置登入…", busy: "已有待完成的登入。使用 /reauth cancel 取消。",
    code: "開啟官方登入頁面，輸入下方的一次性代碼，並在瀏覽器中完成登入。",
    done: "✅ 帳號已新增。請在下方選擇使用。", cancelled: "🔐 登入已取消。", failed: "無法完成帳號操作：",
    deleteConfirm: "移除此登入資料及帳號的本機對話紀錄？", next: "✅ 已選擇後續工作的帳號。",
    rename: "重新命名", cooldown: "重試時間", usage: "主要時段使用量", refreshed: "✅ 帳號狀態已更新。"
  }
};
export function accountText(language, key) { return (messages[language] || messages.en)[key] || key; }
