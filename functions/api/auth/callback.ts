interface Env {
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error");

    if (error) {
        return new Response(renderErrorPage(error), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }

    if (!code) {
        return new Response(renderErrorPage("No authorization code received"), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }

    // Determine mode from state prefix:
    //   "p:..." = proxy mode (server-side token exchange)
    //   "d:..." = direct/client-credentials mode (pass code to plugin)
    const isDirectMode = state.startsWith("d:");

    if (isDirectMode) {
        // Client-credentials mode: pass code directly to Obsidian plugin
        const obsidianParams = new URLSearchParams({
            code: code,
            state: state,
        });
        const obsidianUri = `obsidian://vault-sync-auth?${obsidianParams.toString()}`;

        return new Response(renderRedirectPage(obsidianUri, code), {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store, no-cache",
            },
        });
    }

    // Proxy mode: exchange code for tokens server-side
    const clientId = context.env.GOOGLE_CLIENT_ID;
    const clientSecret = context.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return new Response("Server misconfiguration", { status: 500 });
    }

    const callbackUrl = `${url.origin}/api/auth/callback`;

    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl,
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const tokenData: any = await tokenResponse.json();

    if (tokenData.error) {
        const errorMsg = tokenData.error_description || tokenData.error;
        return new Response(renderErrorPage(errorMsg), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    const obsidianParams = new URLSearchParams({
        access_token: accessToken,
        refresh_token: refreshToken || "",
        state: state,
    });
    const obsidianUri = `obsidian://vault-sync-auth?${obsidianParams.toString()}`;

    return new Response(renderRedirectPage(obsidianUri), {
        status: 200,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache",
        },
    });
};

function renderRedirectPage(obsidianUri: string, authCode?: string): string {
    const escapedUri = obsidianUri
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const jsUri = JSON.stringify(obsidianUri);

    const codeSection = authCode
        ? `<p style="margin-top: 20px; font-size: 0.9em; opacity: 0.8">Still not working? Copy this code and paste it into the plugin settings:</p>
           <code style="background:#202225; padding:4px 8px; border-radius:4px; font-family:monospace; display:block; margin:10px 0; word-break:break-all;">${authCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`
        : "";

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VaultSync Authentication</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1e1e1e; color: #dcddde; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
        .container { background: #2f3136; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); max-width: 400px; width: 90%; }
        h1 { margin-bottom: 1rem; }
        p { margin-bottom: 1.5rem; line-height: 1.5; }
        .button { background: #5865f2; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; font-weight: bold; display: inline-block; transition: background 0.2s; }
        .button:hover { background: #4752c4; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Authentication Successful</h1>
        <div id="status">Redirecting to Obsidian...</div>
        <div id="manual-section" style="display:none; margin-top: 1.5rem;">
            <p>If Obsidian doesn't open automatically, click the button below:</p>
            <a id="open-btn" href="${escapedUri}" class="button">Open Obsidian</a>
            ${codeSection}
        </div>
    </div>
    <script>
        var uri = ${jsUri};
        window.location.href = uri;
        setTimeout(function() {
            document.getElementById('manual-section').style.display = 'block';
        }, 2000);
    </script>
</body>
</html>`;
}

function renderErrorPage(errorMessage: string): string {
    const escapedMsg = errorMessage
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VaultSync Authentication Failed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1e1e1e; color: #dcddde; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
        .container { background: #2f3136; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); max-width: 400px; width: 90%; }
        h1 { margin-bottom: 1rem; }
        .error { color: #f04747; margin-top: 1rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Authentication Failed</h1>
        <p class="error">${escapedMsg}</p>
        <p>Please close this window and try again from Obsidian.</p>
    </div>
</body>
</html>`;
}
