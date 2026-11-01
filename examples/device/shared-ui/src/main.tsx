import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isNative, request, type Snapshot, type Step } from "./bridge";
import "./style.css";

const streamingTelligenceLogo = new URL("../../../../docs/assets/streamingtelligence-logo.png", import.meta.url).href;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}

type PendingRequest = { controllerUrl: string; requestId: string; secret: string; expiresAt: number };
const pendingRequestKey = "gelato.pending-pairing-request.v1";

function controllerAddress(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("请输入完整的控制端地址，例如 https://example.com");
  }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("请输入 HTTPS 控制端根地址，不要填写配对链接或附加路径");
  }
  return url.origin;
}

function savedPendingRequest(): PendingRequest | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingRequestKey) || "null") as PendingRequest | null;
    if (value && value.expiresAt > Date.now() && value.requestId && value.secret) return value;
  } catch { /* Ignore invalid local state. */ }
  localStorage.removeItem(pendingRequestKey);
  return null;
}

async function controllerJson(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `控制端返回 ${response.status}`);
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

function SetupStep({
  step,
  busy,
  act,
}: {
  step: Step;
  busy: boolean;
  act: (operation: string, args?: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <div className="step">
      <div className="step-title">
        <strong>{step.title}</strong>
        {step.check?.state !== "unknown" && (
          <span>{step.check?.state === "checking" ? "检测中" : step.check?.state === "failed" ? "未满足" : "已验证"}</span>
        )}
      </div>
      <p className="preserve-lines">{step.detail}</p>
      {((step.action && step.button) || (step.secondaryAction && step.secondaryButton)) && (
        <div className="actions">
          {step.action && step.button && (
            <button
              className="button primary"
              disabled={busy || step.disabled}
              onClick={() => void act("action", { action: step.action })}
            >
              {step.button}
            </button>
          )}
          {step.secondaryAction && step.secondaryButton && (
            <button
              className="button secondary"
              disabled={busy || step.disabled}
              onClick={() => void act("action", { action: step.secondaryAction })}
            >
              {step.secondaryButton}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<"connection" | "settings">("connection");
  const [state, setState] = useState<Snapshot>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [addressDraft, setAddressDraft] = useState("");
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(savedPendingRequest);
  const [approvedCode, setApprovedCode] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const refreshLock = useRef<Promise<void> | null>(null);
  const pairingLock = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (!isNative) return;
    if (refreshLock.current) {
      if (!force) return;
      await refreshLock.current;
    }
    const task = (async () => {
      try {
        setState(await request<Snapshot>("snapshot"));
      } catch (e) {
        setError(errorText(e));
      }
    })();
    refreshLock.current = task;
    try {
      await task;
    } finally {
      if (refreshLock.current === task) refreshLock.current = null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    const foreground = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh]);

  const act = async (
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(operation);
    setError("");
    try {
      await request(operation, args);
      await refresh(true);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy("");
    }
  };

  const verified = state?.pairingVerified ?? state?.online ?? false;
  const connected = !!state?.paired && verified;
  const before = state?.steps.filter((step) => step.phase === "before-pairing") ?? [];
  const pendingBefore = before.filter((step) => !step.done);
  const visibleBefore = state?.paired
    ? pendingBefore.filter((step) => step.check?.state === "failed")
    : pendingBefore;
  const blocked = pendingBefore.some((step) => step.required && step.check?.state === "failed");
  const pendingAfter = state?.steps.filter((step) => step.phase === "before-control" && !step.done) ?? [];
  const completePairing = useCallback(async (controllerUrl: string, code: string) => {
    if (pairingLock.current) return;
    pairingLock.current = true;
    setBusy("pair");
    setError("");
    setApprovedCode(code);
    try {
      await request("configure", { controllerUrl });
      await request("stagePairingCode", { code });
      await request("pair");
      localStorage.removeItem(pendingRequestKey);
      setPendingRequest(null);
      setApprovedCode("");
      await refresh(true);
    } catch (e) {
      setError(errorText(e));
      await refresh(true);
    } finally {
      pairingLock.current = false;
      setBusy("");
    }
  }, [refresh]);

  useEffect(() => {
    if (!pendingRequest || state?.paired || approvedCode) return;
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const result = await controllerJson(
          `${pendingRequest.controllerUrl}/pairing-requests/${encodeURIComponent(pendingRequest.requestId)}`,
          { headers: { Authorization: `Bearer ${pendingRequest.secret}` } }
        );
        if (stopped) return;
        if (result.status === "approved" && typeof result.pairingCode === "string") {
          await completePairing(pendingRequest.controllerUrl, result.pairingCode);
        } else if (result.status === "denied") {
          localStorage.removeItem(pendingRequestKey);
          setPendingRequest(null);
          setError("控制端拒绝了这次配对请求");
        }
      } catch (e) {
        if (!stopped && (pendingRequest.expiresAt <= Date.now() || errorText(e).includes("not found"))) {
          localStorage.removeItem(pendingRequestKey);
          setPendingRequest(null);
          setError("配对请求已过期，请重新连接");
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { if (!document.hidden) void poll(); }, 2500);
    const foreground = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", foreground);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", foreground); };
  }, [pendingRequest, state?.paired, approvedCode, completePairing]);

  const connectToController = async () => {
    if (!state || busy) return;
    setBusy("connect");
    setError("");
    try {
      const controllerUrl = controllerAddress(addressDraft);
      const agentKind = state.platform === "android" ? "android-phone" : "ios";
      const result = await controllerJson(`${controllerUrl}/pairing-requests`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentKind, displayName: state.displayName || "这台设备" })
      });
      if (!result.requestId || !result.secret || !Number.isFinite(result.expiresAt)) {
        throw new Error("控制端没有返回有效的配对请求");
      }
      const pending: PendingRequest = { controllerUrl, requestId: result.requestId,
        secret: result.secret, expiresAt: result.expiresAt };
      localStorage.setItem(pendingRequestKey, JSON.stringify(pending));
      setPendingRequest(pending);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const cancelPairingRequest = async () => {
    if (!pendingRequest) return;
    try {
      await fetch(`${pendingRequest.controllerUrl}/pairing-requests/${encodeURIComponent(pendingRequest.requestId)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${pendingRequest.secret}` }
      });
    } catch { /* Local cancellation still succeeds when offline. */ }
    localStorage.removeItem(pendingRequestKey);
    setPendingRequest(null);
    setApprovedCode("");
  };
  const status = !state?.paired
    ? "尚未配对"
    : state.platform === "ios" && state.connectionEnabled === false
      ? "连接已关闭"
      : !verified
        ? "正在连接"
        : !state.controlAllowed
          ? "已连接 · 控制关闭"
          : !state.ready
            ? "已连接 · 控制待就绪"
            : "已连接 · 可以控制";

  return (
    <div className="app" style={{ paddingTop: state?.platform === "android" ? `${state.topInsetDp ?? 0}px` : undefined }}>
      <header className="header">
        <div className="brand">
          <img src={streamingTelligenceLogo} alt="StreamingTelligence" />
          <strong>Gelato</strong>
        </div>
        <button
          className="header-action"
          onClick={() => {
            setPage(page === "connection" ? "settings" : "connection");
            setConfirmForget(false);
            setError("");
          }}
        >
          {page === "connection" ? "设置" : "返回连接"}
        </button>
      </header>

      <main>
        {!isNative && (
          <section className="panel">
            <h1>请在设备上打开</h1>
            <p>配对和控制状态只能从已安装的设备端读取。</p>
          </section>
        )}

        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="关闭错误提示">关闭</button>
          </div>
        )}

        {isNative && !state && (
          <section className="panel">
            <h1>正在读取设备状态…</h1>
            <button className="button secondary" onClick={() => void refresh(true)}>重新读取</button>
          </section>
        )}

        {state && page === "connection" && (
          <>
            <section className="status">
              <div className="status-top">
                <span className="device-name">{state.displayName || "这台设备"}</span>
                <span className={`status-tag ${connected ? "connected" : ""}`}>{status}</span>
              </div>
              <p>
                {!state.paired
                  ? "完成需要的本机准备后，输入控制端地址发起配对。"
                  : !verified
                    ? state.connectionEnabled === false
                      ? "本机凭据已保存；连接由你关闭。"
                      : "正在验证旧凭据；首次鉴权失败会自动清除。"
                    : !state.controlAllowed
                      ? "连接已验证。只有你开启控制后，控制端才能发送操作。"
                      : !state.ready
                        ? "连接已验证；继续完成下方的设备控制准备。"
                        : "设备已就绪。关闭控制不会删除配对。"}
              </p>
            </section>

            {state.paired && state.pendingControllerUrl && (
              <div className="alert" role="status">
                收到另一个控制端的配对信息。要更换控制端，请先在设置中清除本机配对。
              </div>
            )}

            {state.error && !state.paired && (
              <div className="alert" role="status">{state.error}</div>
            )}

            {state.error && state.paired && verified && (
              <section className="panel warning">
                <h2>连接提示</h2>
                <p>{state.error}</p>
                {state.paired && (
                  <button className="button secondary" disabled={!!busy} onClick={() => void act("action", { action: "reconnect" })}>
                    重新连接
                  </button>
                )}
              </section>
            )}

            {state.paired && !verified && state.platform === "ios" && state.connectionEnabled === false && (
              <section className="panel">
                <h2>开启连接</h2>
                <button className="button primary" disabled={!!busy}
                  onClick={() => void act("connection", { enabled: true })}>开启并验证</button>
              </section>
            )}

            {visibleBefore.length > 0 && (
              <section className="panel">
                <div className="section-heading">
                  <h2>{state.paired ? "需要处理的准备项" : "配对前准备"}</h2>
                </div>
                {visibleBefore.map((step) => <SetupStep key={step.id} step={step} busy={!!busy} act={act} />)}
              </section>
            )}

            {!state.paired && (
              <section className="panel">
                {pendingRequest ? (
                  <>
                    <h2>{approvedCode ? "正在完成配对" : "等待控制端确认"}</h2>
                    <p>控制端：{pendingRequest.controllerUrl}</p>
                    <p>请在控制端的“Pairing requests”中确认设备“{state.displayName || "这台设备"}”
                      （请求尾号 {pendingRequest.requestId.slice(-6)}）。确认后这里会自动完成配对。</p>
                    {approvedCode && (
                      <button className="button primary" disabled={!!busy || blocked}
                        onClick={() => void completePairing(pendingRequest.controllerUrl, approvedCode)}>
                        重试完成配对
                      </button>
                    )}
                    <button className="button secondary" disabled={!!busy}
                      onClick={() => void cancelPairingRequest()}>取消这次请求</button>
                  </>
                ) : (
                  <>
                    <h2>连接控制端</h2>
                    <p>填入控制端的 HTTPS 地址。连接后，控制端确认这台设备即可完成首次配对。</p>
                    <form onSubmit={(event) => { event.preventDefault(); void connectToController(); }}>
                      <label htmlFor="controller-address">控制端地址</label>
                      <input id="controller-address" className="controller-address-input" type="url" value={addressDraft}
                        onChange={(event) => setAddressDraft(event.target.value)}
                        placeholder="https://example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
                      <button className="button primary" disabled={!!busy || blocked || !addressDraft.trim()}>
                        {blocked ? "先完成上方必要授权" : "连接并请求配对"}
                      </button>
                    </form>
                  </>
                )}
              </section>
            )}

            {state.paired && (
              <section className="panel">
                <h2>连接与控制</h2>
                {state.platform === "ios" && (
                  <div className="setting-row">
                    <div><strong>保持连接</strong><small>关闭后保留配对记录</small></div>
                    <button className="button secondary" disabled={!!busy} onClick={() => void act("connection", { enabled: state.connectionEnabled === false })}>
                      {state.connectionEnabled === false ? "开启" : "关闭"}
                    </button>
                  </div>
                )}
                <div className="setting-row">
                  <div><strong>允许接入控制</strong><small>关闭后拒绝控制命令</small></div>
                  <button className={`button ${state.controlAllowed ? "secondary" : "primary"}`} disabled={!!busy} onClick={() => void act("access", { allowed: !state.controlAllowed })}>
                    {state.controlAllowed ? "关闭" : "开启"}
                  </button>
                </div>
              </section>
            )}

            {connected && state.controlAllowed && pendingAfter.length > 0 && (
              <section className="panel emphasis">
                <h2>控制前置条件</h2>
                {pendingAfter.map((step) => <SetupStep key={step.id} step={step} busy={!!busy} act={act} />)}
              </section>
            )}

            {connected && state.controlAllowed && state.ready && (
              <section className="panel">
                <h2>控制功能已可用</h2>
                <p>可以离开此页。实际后台连接能力仍受设备系统限制。</p>
              </section>
            )}

            {connected && (
              <section className="panel">
                <h2>给控制端发送消息</h2>
                <textarea aria-label="发送给控制端的消息" value={draft} maxLength={16384} onChange={(event) => setDraft(event.target.value)} />
                <button className="button primary" disabled={!!busy || !draft.trim()} onClick={async () => {
                  if (await act("message", { text: draft })) setDraft("");
                }}>发送</button>
                {state.lastReply && <p className="reply preserve-lines">{state.lastReply}</p>}
              </section>
            )}
          </>
        )}

        {state && page === "settings" && (
          <>
            <h1 className="page-title">设置</h1>
            {confirmForget && state.platform === "ios" && (
              <section className="panel warning">
                <h2>确认重新首次配对</h2>
                <p>清除本机地址、凭据和 iPhone 系统配对记录，并关闭控制。控制端服务器上的记录需在控制端撤销。</p>
                <div className="actions">
                  <button className="button danger" disabled={!!busy} onClick={async () => {
                    if (await act("forget")) {
                      setConfirmForget(false);
                      setPage("connection");
                    }
                  }}>确认清除本机记录</button>
                  <button className="button secondary" disabled={!!busy} onClick={() => setConfirmForget(false)}>取消</button>
                </div>
              </section>
            )}
            <section className="panel">
              <h2>设备设置</h2>
              <div className="setting-row">
                <div><strong>系统权限与后台运行</strong><small>在本机系统中检查</small></div>
                <button className="button secondary" disabled={!!busy} onClick={() => void act("action", { action: "settings" })}>打开</button>
              </div>
              {(
                <div className="setting-row">
                  <div><strong>屏幕共享</strong>
                    <small>按需开启，系统会要求确认</small></div>
                  <button className="button secondary" disabled={!!busy || !state.controlAllowed} onClick={() => void act("action", {
                    action: state.screenSharing ? "screen-stop" : "screen-start"
                  })}>
                    {state.screenSharing ? "停止" : "开始"}
                  </button>
                </div>
              )}
            </section>
            {state.platform === "ios" && (state.paired || !!state.controllerUrl) && !confirmForget && (
              <section className="panel">
                <h2>重新开始首次配对</h2>
                <p>只清除本机地址、凭据和 iPhone 系统配对记录，并关闭控制。控制端服务器上的记录需在控制端撤销。</p>
                <button className="button danger-outline" onClick={() => {
                  setConfirmForget(true);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}>清除本机记录…</button>
              </section>
            )}
            <p className="version">Gelato · {state.version || "设备端"}</p>
          </>
        )}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
