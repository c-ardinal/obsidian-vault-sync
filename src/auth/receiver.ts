import { Notice } from "obsidian";

/**
 * A temporary HTTP server to receive the OAuth2 callback on Desktop.
 */
export async function startReceiverServer(port: number, state: string): Promise<string> {
    const http = require("http");

    return new Promise((resolve, reject) => {
        const server = http.createServer((req: any, res: any) => {
            const url = new URL(req.url, `http://localhost:${port}`);
            const code = url.searchParams.get("code");
            const receivedState = url.searchParams.get("state");

            if (receivedState !== state) {
                res.writeHead(400);
                res.end("Invalid state parameter.");
                return;
            }

            if (code) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<h1>Authentication Successful!</h1><p>You can close this window now.</p>");
                resolve(code);
            } else {
                res.writeHead(400);
                res.end("Authorization code not found.");
                reject(new Error("No code found"));
            }

            // Close server immediately after receiving the first request
            res.on("finish", () => {
                server.close();
            });
        });

        server.listen(port, "127.0.0.1", () => {
            console.log(`Auth receiver listening on port ${port}`);
        });

        server.on("error", (err: any) => {
            reject(err);
        });

        // Timeout after 60 seconds
        setTimeout(() => {
            server.close();
            reject(new Error("Authentication timed out"));
        }, 60 * 1000);
    });
}
