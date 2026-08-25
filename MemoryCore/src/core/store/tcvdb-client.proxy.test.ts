import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("TcvdbClient module loading", () => {
  it("preserves Node environment-proxy routing for global fetch", async () => {
    let requestedUrl: string | undefined;
    let connectAuthority: string | undefined;
    let tunneledRequestLine: string | undefined;
    const proxy = createServer((request, response) => {
      requestedUrl = request.url;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("routed-through-env-proxy");
    });
    proxy.on("connect", (request, socket) => {
      connectAuthority = request.url;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (data) => {
        tunneledRequestLine = data.toString("utf8").split("\r\n", 1)[0];
        socket.end([
          "HTTP/1.1 200 OK",
          "Content-Type: text/plain",
          "Content-Length: 24",
          "Connection: close",
          "",
          "routed-through-env-proxy",
        ].join("\r\n"));
      });
    });
    servers.push(proxy);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");

    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected proxy to listen on a TCP port");
    }

    const targetUrl = "http://memory-core-proxy-test.invalid/health";
    const childScript = `
      await import("./src/core/store/tcvdb-client.ts");
      const response = await fetch(${JSON.stringify(targetUrl)});
      process.stdout.write(await response.text(), () => process.exit(0));
    `;
    const { ALL_PROXY: _allProxy, all_proxy: _lowerAllProxy, ...inheritedEnv } = process.env;
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childScript,
    ], {
      cwd: process.cwd(),
      env: {
        ...inheritedEnv,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: `http://127.0.0.1:${address.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const [exitCode] = await once(child, "close") as [number | null];

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toBe("routed-through-env-proxy");
    expect(requestedUrl ?? connectAuthority).toBe(
      requestedUrl ? targetUrl : "memory-core-proxy-test.invalid:80",
    );
    if (connectAuthority) {
      expect(tunneledRequestLine).toBe("GET /health HTTP/1.1");
    }
  });

  it("keeps TCVDB HTTP requests working after dispatcher preservation", async () => {
    let receivedMethod: string | undefined;
    let receivedAuthorization: string | undefined;
    let receivedBody = "";
    const tcvdb = createServer((request, response) => {
      receivedMethod = request.method;
      receivedAuthorization = request.headers.authorization;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { receivedBody += chunk; });
      request.on("end", () => {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Connection": "close",
        });
        response.end(JSON.stringify({ code: 0, msg: "ok", databases: ["lab"] }));
      });
    });
    servers.push(tcvdb);
    tcvdb.listen(0, "127.0.0.1");
    await once(tcvdb, "listening");

    const address = tcvdb.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCVDB test server to listen on a TCP port");
    }

    const { TcvdbClient } = await import("./tcvdb-client.js");
    const client = new TcvdbClient({
      url: `http://127.0.0.1:${address.port}`,
      username: "tester",
      apiKey: "test-key",
      database: "lab",
      timeout: 2_000,
    });

    const result = await client.request<{ databases: string[] }>("/database/list", { probe: true });

    expect(result.databases).toEqual(["lab"]);
    expect(receivedMethod).toBe("POST");
    expect(receivedAuthorization).toBe("Bearer account=tester&api_key=test-key");
    expect(receivedBody).toBe('{"probe":true}');
  });
});
