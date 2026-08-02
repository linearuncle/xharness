// xAI (Grok) OAuth 设备码流程（RFC 8628），移植自 pi-mono packages/ai/src/auth/oauth/xai.ts
// 与 SuperGrok / X Premium 订阅账号配套：登录后拿到 access/refresh token，
// access token 以 Authorization: Bearer 方式调用 https://api.x.ai/v1/responses（OpenAI Response API）。
// 零依赖：纯 fetch，主进程运行。

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
// 提前于报告的过期时间刷新，避免请求中途 token 失效
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
// RFC 8628：服务端未给 interval 时用 5 秒；slow_down 时加 5 秒
const DEFAULT_POLL_INTERVAL_S = 5;
const SLOW_DOWN_INCREMENT_MS = 5000;

async function postForm(url, fields, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("登录已取消");
    throw err;
  }
  let body = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {
    if (signal?.aborted) throw new Error("登录已取消");
    throw new Error(`xAI OAuth 返回了非法 JSON（HTTP ${response.status}）`);
  }
  return { ok: response.ok, status: response.status, body };
}

function failure(action, r) {
  const detail = [r.body.error, r.body.error_description].filter((x) => typeof x === "string").join(": ");
  return new Error(`xAI OAuth ${action}失败（HTTP ${r.status}）${detail ? `：${detail}` : ""}`);
}

// 验证 URI 会被交给系统浏览器打开：强制 https，防止恶意响应拉起别的程序
function validateHttpsUri(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("xAI OAuth 响应中的验证地址不可信"); }
  if (url.protocol !== "https:") throw new Error("xAI OAuth 响应中的验证地址不可信");
  return url.href;
}

function requiredString(body, field) {
  const v = body[field];
  if (typeof v !== "string" || !v) throw new Error(`xAI OAuth 响应缺少字段: ${field}`);
  return v;
}

function credentialFromTokenResponse(body, previousRefreshToken) {
  const access = requiredString(body, "access_token");
  // 刷新时若未轮换 refresh_token，xAI 可能省略该字段：沿用旧值
  const refresh =
    body.refresh_token === undefined && previousRefreshToken
      ? previousRefreshToken
      : requiredString(body, "refresh_token");
  const lifetime =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return { access, refresh, expires: Date.now() + lifetime * 1000 - REFRESH_SKEW_MS };
}

/** 第一步：申请设备码。返回展示给用户的 userCode 与浏览器打开的验证地址。 */
export async function startDeviceFlow(signal) {
  const r = await postForm(
    XAI_DEVICE_CODE_URL,
    { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "xharness" },
    signal
  );
  if (!r.ok) throw failure("设备授权", r);
  const interval = r.body.interval;
  return {
    deviceCode: requiredString(r.body, "device_code"),
    userCode: requiredString(r.body, "user_code"),
    verificationUri: validateHttpsUri(requiredString(r.body, "verification_uri")),
    verificationUriComplete:
      typeof r.body.verification_uri_complete === "string" && r.body.verification_uri_complete
        ? validateHttpsUri(r.body.verification_uri_complete)
        : undefined,
    intervalSeconds:
      typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined,
    expiresInSeconds:
      typeof r.body.expires_in === "number" && r.body.expires_in > 0 ? r.body.expires_in : 1800,
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("登录已取消"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("登录已取消")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 第二步：轮询令牌端点直至用户在浏览器完成授权。返回 {access, refresh, expires}。 */
export async function pollForTokens(device, signal) {
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  let intervalMs = Math.max(1000, (device.intervalSeconds ?? DEFAULT_POLL_INTERVAL_S) * 1000);
  await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)), signal);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("登录已取消");
    const r = await postForm(
      XAI_TOKEN_URL,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_CLIENT_ID,
        device_code: device.deviceCode,
      },
      signal
    );
    if (r.ok) return credentialFromTokenResponse(r.body);

    const err = r.body.error;
    if (err === "authorization_pending") {
      // 继续等
    } else if (err === "slow_down") {
      intervalMs =
        typeof r.body.interval === "number" && r.body.interval > 0
          ? Math.max(1000, r.body.interval * 1000)
          : intervalMs + SLOW_DOWN_INCREMENT_MS;
    } else if (err === "access_denied" || err === "authorization_denied") {
      throw new Error("授权被拒绝");
    } else if (err === "expired_token") {
      throw new Error("设备码已过期，请重新登录");
    } else {
      throw failure("令牌轮询", r);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), signal);
  }
  throw new Error("登录超时，请重新发起");
}

/** 刷新 access token（提前 5 分钟触发；refresh token 未轮换时沿用旧值）。 */
export async function refreshAccessToken(refreshToken, signal) {
  const r = await postForm(
    XAI_TOKEN_URL,
    { grant_type: "refresh_token", client_id: XAI_CLIENT_ID, refresh_token: refreshToken },
    signal
  );
  if (!r.ok) throw failure("令牌刷新", r);
  return credentialFromTokenResponse(r.body, refreshToken);
}
