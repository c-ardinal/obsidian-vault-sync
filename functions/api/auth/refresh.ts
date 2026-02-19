interface Env {
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
}

function getCorsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("Origin") || "";
    // Only allow same-origin or Obsidian (capacitor/electron, no Origin header)
    const allowed = !origin || origin === new URL(request.url).origin;
    return {
        "Access-Control-Allow-Origin": allowed ? origin || "*" : "null",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}

// Handle CORS preflight
export const onRequestOptions: PagesFunction<Env> = async (context) => {
    return new Response(null, { status: 204, headers: getCorsHeaders(context.request) });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const clientId = context.env.GOOGLE_CLIENT_ID;
    const clientSecret = context.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
            status: 500,
            headers: { ...getCorsHeaders(context.request), "Content-Type": "application/json" },
        });
    }

    let refreshToken: string;
    try {
        const requestBody: any = await context.request.json();
        refreshToken = requestBody.refresh_token;
    } catch {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
            status: 400,
            headers: { ...getCorsHeaders(context.request), "Content-Type": "application/json" },
        });
    }

    if (!refreshToken) {
        return new Response(JSON.stringify({ error: "Missing refresh_token" }), {
            status: 400,
            headers: { ...getCorsHeaders(context.request), "Content-Type": "application/json" },
        });
    }

    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const tokenData: any = await tokenResponse.json();

    if (!tokenResponse.ok) {
        return new Response(
            JSON.stringify({
                error: tokenData.error || "token_refresh_failed",
                error_description: tokenData.error_description,
            }),
            {
                status: tokenResponse.status,
                headers: { ...getCorsHeaders(context.request), "Content-Type": "application/json" },
            },
        );
    }

    return new Response(
        JSON.stringify({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || undefined,
            expires_in: tokenData.expires_in,
        }),
        {
            status: 200,
            headers: { ...getCorsHeaders(context.request), "Content-Type": "application/json" },
        },
    );
};
