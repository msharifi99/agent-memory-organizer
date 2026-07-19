import type { IncomingMessage } from "node:http";

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

import type { AccessIdentity } from "./server.ts";

export type CloudflareAccessAuthOptions = {
  teamDomain: string;
  audience: string;
  keyResolver?: JWTVerifyGetKey;
};

function normalizedTeamDomain(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function createCloudflareAccessAuthenticator(
  options: CloudflareAccessAuthOptions,
): (request: IncomingMessage) => Promise<AccessIdentity | undefined> {
  const teamDomain = normalizedTeamDomain(options.teamDomain);
  const issuer = `https://${teamDomain}`;
  const keyResolver =
    options.keyResolver ??
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (request) => {
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string" || !assertion) return undefined;

    try {
      const { payload } = await jwtVerify(assertion, keyResolver, {
        issuer,
        audience: options.audience,
      });
      if (typeof payload.sub !== "string" || !payload.sub) return undefined;
      return { subject: payload.sub };
    } catch {
      return undefined;
    }
  };
}
