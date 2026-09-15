const {
  BAHA_USER_ID,
  BAHA_PASSWORD,
  BAHA_SESSION_TTL_MS,
  BAHA_LOGIN_COOLDOWN_MS,
} = require("./config");

// 場外（bsn=60076）整板掛著「兒少保護警示」：未登入的 probe 只拿得到警示頁。
// 能看的條件是帳號本身滿 15 歲、完成手機認證、開啟「顯示敏感內容」——所以沒有
// 繞過的技巧，只能真的登入一個符合條件的帳號（ermiana 的做法）。登入走手機 App
// 的 API：它不擋機器人，驗證碼固定吃 cookie 裡的 ckAPP_VCODE，回來的
// BAHAENUR / BAHARUNE 就是整個 gamer.com.tw 的 session。
const LOGIN_URL = "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php";
const APP_VCODE = "9487";
const SESSION_COOKIES = ["BAHAENUR", "BAHARUNE"];
const LOGIN_TIMEOUT_MS = 8000;

let session = null; // { cookies: {BAHAENUR, BAHARUNE}, loggedInAt }
let inflightLogin = null;
let loginBlockedUntil = 0;

function isBahamutLoginConfigured() {
  return Boolean(BAHA_USER_ID && BAHA_PASSWORD);
}

function pickSessionCookies(setCookieHeaders) {
  const found = {};
  for (const header of setCookieHeaders) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (SESSION_COOKIES.includes(name) && value && value !== "deleted") {
      found[name] = value;
    }
  }
  return SESSION_COOKIES.every((name) => found[name]) ? found : null;
}

async function login() {
  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `ckAPP_VCODE=${APP_VCODE}`,
    },
    body: new URLSearchParams({
      uid: BAHA_USER_ID,
      passwd: BAHA_PASSWORD,
      vcode: APP_VCODE,
    }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  const cookies = pickSessionCookies(response.headers.getSetCookie?.() || []);
  if (!cookies) {
    // 失敗時 body 是 {"code":0,"message":"帳號、密碼或驗證碼錯誤！"} 之類
    const body = await response.text().catch(() => "");
    let message = body.slice(0, 120);
    try {
      message = JSON.parse(body).message || message;
    } catch {}
    throw new Error(`status=${response.status} ${message}`);
  }
  return cookies;
}

// 回傳 session cookies，或 null（沒設帳號 / 登入失敗冷卻中）。永遠不 throw：
// 登不進去就照舊用未登入的 probe，預覽不能因為 session 壞掉而變差。
// 失敗後冷卻一段時間，免得每個場外連結都去撞登入 API 把帳號撞到鎖。
async function getBahamutSessionCookies({ force = false } = {}) {
  if (!isBahamutLoginConfigured()) return null;

  const fresh = session && Date.now() - session.loggedInAt < BAHA_SESSION_TTL_MS;
  if (fresh && !force) return session.cookies;
  // 帳號本身沒開「顯示敏感內容」時，登入後照樣被牆；別讓每個場外連結都重登一次
  const justLoggedIn = session && Date.now() - session.loggedInAt < BAHA_LOGIN_COOLDOWN_MS;
  if (fresh && force && justLoggedIn) return session.cookies;
  if (Date.now() < loginBlockedUntil) return fresh ? session.cookies : null;

  if (!inflightLogin) {
    inflightLogin = login()
      .then((cookies) => {
        session = { cookies, loggedInAt: Date.now() };
        console.log(`[baha-session] logged in${force ? " (forced refresh)" : ""}`);
        return cookies;
      })
      .catch((error) => {
        loginBlockedUntil = Date.now() + BAHA_LOGIN_COOLDOWN_MS;
        console.warn(`[baha-session] login failed: ${error.message}`);
        return null;
      })
      .finally(() => {
        inflightLogin = null;
      });
  }
  return inflightLogin;
}

// Playwright addCookies 的形狀；domain 帶前導點才會送到 forum. 與 m. 兩個子網域
function toProbeCookies(cookies) {
  if (!cookies) return null;
  return Object.entries(cookies).map(([name, value]) => ({
    name,
    value,
    domain: ".gamer.com.tw",
    path: "/",
  }));
}

function resetBahamutSessionForTests() {
  session = null;
  inflightLogin = null;
  loginBlockedUntil = 0;
}

module.exports = {
  getBahamutSessionCookies,
  isBahamutLoginConfigured,
  pickSessionCookies,
  toProbeCookies,
  resetBahamutSessionForTests,
};
