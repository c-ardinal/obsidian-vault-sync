interface Env {
    GOOGLE_CLIENT_ID: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const state = url.searchParams.get("state");

    if (!state) {
        return new Response("Missing 'state' parameter", { status: 400 });
    }

    const clientId = context.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return new Response("Internal server error", { status: 500 });
    }

    // Build callback URL on the same origin
    const callbackUrl = `${url.origin}/api/auth/callback`;

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/drive.file",
        state: state,
        access_type: "offline",
        prompt: "consent",
    });

    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return Response.redirect(googleAuthUrl, 302);
};
