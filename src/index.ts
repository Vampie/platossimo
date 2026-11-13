import { chooseMove } from "./move.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return Response.json({ apiversion: "1", color: "#22c55e", head: "gamer", tail: "nr-booster", version: "1.0.0" });
    }
    if (request.method === "POST" && pathname === "/move") {
      return Response.json({ move: chooseMove(await request.json()), shout: "Bazinga!!!" });
    }
    if (request.method === "POST" && (pathname === "/start" || pathname === "/end")) {
      return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  },
};
