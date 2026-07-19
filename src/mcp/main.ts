import { scrubSecretText } from "../memory-system/vault.ts";
import { startMemoryMcpService } from "./runtime.ts";

try {
  const { server, runtime } = await startMemoryMcpService();
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "server_started",
      host: runtime.host,
      port: runtime.port,
    })}\n`,
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "server_stopping",
      })}\n`,
    );
    server.close((error) => {
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: error ? "error" : "info",
          event: "server_stopped",
          outcome: error ? "error" : "success",
          ...(error
            ? {
                error_name: error.name,
                error_message: scrubSecretText(error.message),
              }
            : {}),
        })}\n`,
      );
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "startup_failed",
      code: "startup_failed",
      message: "MCP server failed to start.",
      ...(error instanceof Error
        ? {
            error_name: error.name,
            error_message: scrubSecretText(error.message),
          }
        : { error_type: typeof error }),
    })}\n`,
  );
  process.exitCode = 1;
}
