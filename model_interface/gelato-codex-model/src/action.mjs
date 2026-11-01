import { request } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

async function propose(turnId, capability, args) {
  if (!process.env.GELATO_ACTION_SOCKET || !process.env.GELATO_ACTION_NONCE
      || !process.env.GELATO_ACTION_WORKDIR) {
    throw new Error("Gelato action channel is unavailable in this turn");
  }
  if (typeof turnId !== "string" || !turnId || turnId.length > 128
      || typeof capability !== "string" || !capability || capability.length > 128
      || !args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Invalid action proposal");
  }
  const body = JSON.stringify({ nonce: process.env.GELATO_ACTION_NONCE,
    turnId, capability, args });
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath: process.env.GELATO_ACTION_SOCKET, path: "/propose",
      method: "POST", headers: { "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body) } }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { reject(new Error("Action result too large")); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(value.error ?? "Action refused"));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(130_000, () => req.destroy(new Error("Action result timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

if (process.argv[2] === "mcp") {
  const server = new McpServer({ name: "gelato-actions", version: "0.1.0" });
  const actionSchema = z.object({ turnId: z.string().min(1).max(128),
    capability: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()) });
  function attachResult(content, outcome) {
    const result = outcome.result;
    if (result && typeof result.dataBase64 === "string"
        && typeof result.mimeType === "string" && result.mimeType.startsWith("image/")) {
      const bytes = Buffer.from(result.dataBase64, "base64");
      if (bytes.length > 0 && bytes.length <= 600_000
          && bytes.toString("base64") === result.dataBase64) {
        content.push({ type: "image", mimeType: result.mimeType, data: result.dataBase64 });
      } else {
        result.mediaError = "Image omitted because its encoding or size was invalid";
      }
      delete result.dataBase64;
    }
  }
  server.registerTool("propose_action", {
    description: "Propose one capability action to the Gelato Controller and await the device outcome. The device may refuse it. Use screen.capture to observe the device.",
    inputSchema: actionSchema
  }, async ({ turnId, capability, args }) => {
    try {
      const outcome = await propose(turnId, capability, args);
      const content = [];
      attachResult(content, outcome);
      content.push({ type: "text", text: JSON.stringify(outcome) });
      return { content };
    } catch (error) {
      return { content: [{ type: "text", text: String(error.message ?? error) }], isError: true };
    }
  });
  server.registerTool("propose_actions", {
    description: "Run a short ordered sequence of Gelato action proposals, awaiting each device outcome and stopping on the first non-completed result. Useful for time-sensitive multi-tap gestures. Observe again after the sequence; never batch across an uncertain screen transition.",
    inputSchema: z.object({ actions: z.array(actionSchema.extend({
      pauseMs: z.number().int().min(0).max(500).optional()
    })).min(1).max(12) })
  }, async ({ actions }) => {
    try {
      if (actions.slice(0, -1).some(action => action.capability === "screen.capture")) {
        throw new Error("screen.capture may only be the final action in a sequence");
      }
      const content = [];
      const outcomes = [];
      for (const [index, action] of actions.entries()) {
        const outcome = await propose(action.turnId, action.capability, action.args);
        attachResult(content, outcome);
        outcomes.push({ index, ...outcome });
        if (outcome.status !== "completed") break;
        if (action.pauseMs) await new Promise(resolve => setTimeout(resolve, action.pauseMs));
      }
      content.push({ type: "text", text: JSON.stringify({ outcomes }) });
      return { content };
    } catch (error) {
      return { content: [{ type: "text", text: String(error.message ?? error) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
} else {
  const [turnId, capability, rawArgs = "{}"] = process.argv.slice(2);
  let args;
  try { args = JSON.parse(rawArgs); }
  catch { process.stderr.write("Action arguments must be JSON\n"); process.exit(2); }
  try {
    const outcome = await propose(turnId, capability, args);
    const media = outcome.result;
    if (media && typeof media.dataBase64 === "string" && typeof media.mimeType === "string"
        && media.mimeType.startsWith("image/")) {
      const bytes = Buffer.from(media.dataBase64, "base64");
      if (bytes.length > 0 && bytes.length <= 600_000
          && bytes.toString("base64") === media.dataBase64) {
        const suffix = media.mimeType === "image/png" ? ".png" : ".jpg";
        const imagePath = path.join(process.env.GELATO_ACTION_WORKDIR,
          `frame-${outcome.proposalId}${suffix}`);
        writeFileSync(imagePath, bytes, { mode: 0o600 });
        delete media.dataBase64;
        media.imagePath = imagePath;
      }
    }
    process.stdout.write(JSON.stringify(outcome) + "\n");
  } catch (error) {
    process.stderr.write(String(error.message ?? error) + "\n");
    process.exitCode = 2;
  }
}
