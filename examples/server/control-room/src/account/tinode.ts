import { WebSocket } from "ws";

export interface AccountSession {
  user: { id: string; displayName: string };
  token: string;
  expiresAt: string;
}

export class AccountError extends Error {
  constructor(message: string, readonly status = 401) { super(message); }
}

/** The account provider's Tinode hi/login flow, including its existing token scheme. */
export class TinodeAccounts {
  constructor(private readonly url: string, private readonly apiKey: string) {}

  get configured(): boolean { return Boolean(this.url && this.apiKey); }

  async login(username: string, password: string): Promise<AccountSession> {
    if (!username.trim() || username.includes(":") || username.length > 128 ||
        !password || password.length > 1024) throw new AccountError("请输入有效的账号和密码", 400);
    return this.session(await this.exchange("login", {
      scheme: "basic", secret: Buffer.from(`${username.trim()}:${password}`).toString("base64")
    }), username.trim());
  }

  async register(username: string, password: string, displayName: string): Promise<AccountSession> {
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username) || password.length < 10 || password.length > 1024) {
      throw new AccountError("账号需为 3–64 位字母、数字或 ._-，密码至少 10 位", 400);
    }
    return this.session(await this.exchange("acc", {
      user: "new", scheme: "basic", secret: Buffer.from(`${username}:${password}`).toString("base64"),
      login: true, desc: { public: { fn: displayName.trim().slice(0, 80) || username } }
    }), displayName.trim() || username);
  }

  async verify(token: string): Promise<Pick<AccountSession, "user">> {
    if (!token || token.length > 8192) throw new AccountError("请重新登录");
    const params = await this.exchange("login", { scheme: "token", secret: token });
    // Tinode may return only the authenticated user for
    // introspection. Do not require a replacement token or invent its expiry.
    if (typeof params.user !== "string" || !params.user) throw new AccountError("账号服务未返回用户身份", 502);
    return { user: { id: params.user, displayName: params.user } };
  }

  private session(params: Record<string, unknown>, displayName?: string): AccountSession {
    if (typeof params.user !== "string" || typeof params.token !== "string" ||
        typeof params.expires !== "string" || !Number.isFinite(Date.parse(params.expires))) {
      throw new AccountError("账号服务未返回完整的登录凭据", 502);
    }
    return { user: { id: params.user, displayName: displayName || params.user },
      token: params.token, expiresAt: params.expires };
  }

  private exchange(command: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.configured) return Promise.reject(new AccountError("账号服务暂未连接，请稍后重试", 503));
    return new Promise((resolve, reject) => {
      const url = new URL(this.url);
      // Tinode's API key identifies the application; user tokens only travel in frames.
      url.searchParams.set("apikey", this.apiKey);
      const socket = new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 8000 });
      let done = false;
      let stage = "hi";
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate();
        if (error) reject(error); else resolve(value ?? {});
      };
      const timer = setTimeout(() => finish(new AccountError("账号服务连接超时", 504)), 10_000);
      socket.on("open", () => socket.send(JSON.stringify({ hi: {
        id: "hi", ver: "0.24", ua: "gelato/1.0", lang: "zh-CN"
      } })));
      socket.on("message", raw => {
        try {
          const response = JSON.parse(raw.toString());
          const ctrl = response.ctrl;
          if (!ctrl || ctrl.id !== stage) return;
          if (!Number.isInteger(ctrl.code) || ctrl.code < 200 || ctrl.code >= 300) {
            finish(new AccountError(ctrl.code === 409 ? "账号已存在，请直接登录" :
              ctrl.code === 300 ? "请先完成账号服务要求的验证" : "账号或凭据无效，请重试",
              ctrl.code === 409 ? 409 : 401));
            return;
          }
          if (stage === "hi") {
            stage = "account";
            socket.send(JSON.stringify({ [command]: { id: stage, ...body } }));
          } else finish(undefined, ctrl.params);
        } catch { finish(new AccountError("账号服务响应无效", 502)); }
      });
      socket.on("error", () => finish(new AccountError("暂时无法连接账号服务", 503)));
      socket.on("close", () => finish(new AccountError("账号服务连接中断", 503)));
    });
  }
}
