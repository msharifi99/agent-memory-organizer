const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== CHALLENGE_PATH) {
      return new Response("Not found", {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return new Response(env.CHALLENGE_TOKEN, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
