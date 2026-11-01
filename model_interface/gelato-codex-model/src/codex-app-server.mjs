import { spawn } from "node:child_process";

const RPC_TIMEOUT = 30_000;
const MAX_OUTPUT_LINE = 2 * 1024 * 1024;

export class CodexAppServer {
  constructor({ bin, model, effort, serviceTier, sandbox, cwd, actionScript, actionSocket,
    actionNonce, onEvent }) {
    Object.assign(this, { bin, model, effort, serviceTier, sandbox, cwd, actionScript,
      actionSocket, actionNonce, onEvent });
    this.requests = new Map();
    this.nextId = 0;
    this.stdoutBuffer = "";
    this.threadId = undefined;
    this.active = undefined;
    this.closed = false;
  }

  async start() {
    if (this.process || this.closed) throw new Error("Codex app-server already started or closed");
    const args = ["app-server", "--listen", "stdio://",
      "-c", `model_reasoning_effort=${this.effort}`,
      "-c", 'mcp_servers.gelato_turn_actions.command="node"',
      "-c", `mcp_servers.gelato_turn_actions.args=${JSON.stringify([this.actionScript, "mcp"])}`,
      "-c", "mcp_servers.gelato_turn_actions.enabled=true",
      "-c", `mcp_servers.gelato_turn_actions.env_vars=${JSON.stringify([
        "GELATO_ACTION_SOCKET", "GELATO_ACTION_NONCE", "GELATO_ACTION_WORKDIR"])}`,
      "-c", 'mcp_servers.gelato_turn_actions.default_tools_approval_mode="approve"',
      "-c", "mcp_servers.gelato_turn_actions.tool_timeout_sec=135"];
    if (this.serviceTier) args.push("-c", `service_tier=${JSON.stringify(this.serviceTier)}`);
    const env = { ...process.env, GELATO_ACTION_SOCKET: this.actionSocket,
      GELATO_ACTION_NONCE: this.actionNonce, GELATO_ACTION_WORKDIR: this.cwd };
    delete env.GELATO_MODEL_TOKEN;
    delete env.GELATO_MODEL_API_KEY;
    this.process = spawn(this.bin, args, { cwd: this.cwd, env,
      stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", chunk => this.readOutput(chunk));
    // Drain stderr without logging model inputs, credentials, or tool results.
    this.process.stderr.on("data", () => {});
    this.exit = new Promise(resolve => {
      this.process.once("close", (code, signal) => {
        this.failAll(new Error(`Codex app-server exited (${code ?? signal})`));
        resolve();
      });
      this.process.once("error", error => {
        this.failAll(error);
        resolve();
      });
    });
    const startedAt = performance.now();
    await this.request("initialize", { clientInfo: {
      name: "gelato_codex_model", title: "Gelato Codex Model", version: "0.1.0"
    } });
    this.notify("initialized", {});
    const result = await this.request("thread/start", {
      model: this.model, cwd: this.cwd, approvalPolicy: "never",
      sandbox: this.sandbox, serviceName: "gelato_codex_model"
    });
    if (typeof result?.thread?.id !== "string" || !result.thread.id) {
      throw new Error("Codex app-server did not return a thread id");
    }
    this.threadId = result.thread.id;
    this.onEvent?.({ event: "ready", elapsedMs: Math.round(performance.now() - startedAt) });
  }

  send(message) {
    if (this.closed || !this.process?.stdin.writable) throw new Error("Codex app-server is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) { this.send({ method, params }); }

  request(method, params, timeoutMs = RPC_TIMEOUT) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      try { this.send({ id, method, params }); }
      catch (error) { this.requests.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  readOutput(chunk) {
    this.stdoutBuffer += chunk;
    let end;
    while ((end = this.stdoutBuffer.indexOf("\n")) !== -1) {
      if (end > MAX_OUTPUT_LINE) {
        this.failAll(new Error("Codex app-server output line too large"));
        this.process?.kill("SIGTERM");
        return;
      }
      const line = this.stdoutBuffer.slice(0, end).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(end + 1);
      if (!line) continue;
      try { this.handleMessage(JSON.parse(line)); }
      catch (error) {
        this.failAll(error);
        this.process?.kill("SIGTERM");
        return;
      }
    }
    if (this.stdoutBuffer.length > MAX_OUTPUT_LINE) {
      this.failAll(new Error("Codex app-server output line too large"));
      this.process?.kill("SIGTERM");
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") throw new Error("Invalid Codex response");
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message ?? "Codex RPC failed")));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      // An unanticipated approval or interactive request must fail closed.
      this.send({ id: message.id, error: { code: -32000,
        message: "Interactive requests are unavailable in this model endpoint" } });
      return;
    }
    const active = this.active;
    if (!active || message.params?.threadId !== this.threadId) return;
    if (message.method === "item/completed") {
      const item = message.params.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer" || !active.answer) active.answer = item.text;
      }
    }
    if (message.method === "turn/completed") {
      const turn = message.params.turn;
      if (!turn || (active.turnId && turn.id !== active.turnId)) return;
      active.turnId = turn.id;
      this.active = undefined;
      this.onEvent?.({ event: "turn_completed", status: turn.status,
        elapsedMs: Math.round(performance.now() - active.startedAt) });
      if (turn.status === "completed" && active.answer?.trim()) active.resolve(active.answer.trim());
      else active.reject(new Error(turn.error?.message ?? `Codex turn ${turn.status ?? "failed"}`));
    }
  }

  async runTurn(input) {
    if (this.active?.cancelRequested) {
      const prior = this.active;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Previous Codex turn did not stop")), 5000);
        prior.completion.then(resolve, resolve).finally(() => clearTimeout(timer));
      });
    }
    if (!this.threadId || this.active) throw new Error("Codex thread is unavailable or busy");
    const active = { turnId: undefined, answer: "", startedAt: performance.now() };
    active.completion = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    // A start failure can arrive before runTurn begins awaiting completion.
    void active.completion.catch(() => {});
    this.active = active;
    try {
      const result = await this.request("turn/start", {
        threadId: this.threadId, input, cwd: this.cwd,
        approvalPolicy: "never", model: this.model, effort: this.effort
      });
      if (typeof result?.turn?.id !== "string" || !result.turn.id) {
        throw new Error("Codex app-server did not return a turn id");
      }
      active.turnId = result.turn.id;
      if (active.cancelRequested) void this.interrupt();
      return await active.completion;
    } catch (error) {
      if (this.active === active) this.active = undefined;
      throw error;
    }
  }

  async interrupt() {
    const active = this.active;
    if (!active) return;
    active.cancelRequested = true;
    if (!active.turnId) return;
    try { await this.request("turn/interrupt", {
      threadId: this.threadId, turnId: active.turnId
    }, 5000); }
    catch { /* Closing the worker remains available to the caller. */ }
  }

  failAll(error) {
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    if (this.active) { this.active.reject(error); this.active = undefined; }
  }

  async close() {
    if (this.closed) return this.exit;
    if (!this.active && this.threadId && this.process?.exitCode === null) {
      try { await this.request("thread/delete", { threadId: this.threadId }, 5000); }
      catch { /* A failed cleanup must not leave the worker running. */ }
    }
    this.closed = true;
    this.failAll(new Error("Codex app-server closed"));
    if (this.process && this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      const timer = setTimeout(() => this.process?.kill("SIGKILL"), 5000);
      await this.exit;
      clearTimeout(timer);
    }
  }
}
