// Private MCP frontend inherited by native children. It has no credentials or VM address.
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createInterface } from "node:readline";

function relay(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params, executionId: randomUUID() });
    const req = request(
      {
        socketPath: process.env.RAKAZO_CODEX_TOOL_SOCKET,
        path: "/tools",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 16 * 1024 * 1024) req.destroy(new Error("Tool result too large"));
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error("Tool unavailable");
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        serverInfo: { name: "rakazo", version: "0.1.0" },
        capabilities: { tools: {} },
      };
    } else if (message.method === "ping") result = {};
    else if (["tools/list", "tools/call"].includes(message.method)) {
      result = await relay(message.method, message.params ?? {});
    } else throw new Error("Unsupported MCP method");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch {
    if (message?.id !== undefined)
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "The scoped Rakazo tool connection is unavailable" },
        })}\n`,
      );
  }
}
