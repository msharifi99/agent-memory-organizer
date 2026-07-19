import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

import { createCloudflareAccessAuthenticator } from "../src/mcp/auth.ts";

test("Cloudflare Access JWT authentication verifies signature, team issuer, audience, and expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  const issuer = "https://owner.cloudflareaccess.com";
  const audience = "memory-mcp-audience";
  const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
  const authenticate = createCloudflareAccessAuthenticator({
    teamDomain: "owner.cloudflareaccess.com",
    audience,
    keyResolver,
  });

  const makeToken = (overrides: { issuer?: string; audience?: string; expiresIn?: string } = {}) =>
    new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("owner-subject")
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(privateKey);

  const requestFor = (token?: string) =>
    ({
      headers: token ? { "cf-access-jwt-assertion": token } : {},
    }) as IncomingMessage;

  const valid = await authenticate(requestFor(await makeToken()));
  assert.deepEqual(valid, { subject: "owner-subject" });
  assert.equal(await authenticate(requestFor()), undefined);
  assert.equal(
    await authenticate(requestFor(await makeToken({ audience: "wrong-audience" }))),
    undefined,
  );
  assert.equal(
    await authenticate(requestFor(await makeToken({ issuer: "https://other.cloudflareaccess.com" }))),
    undefined,
  );
  assert.equal(
    await authenticate(requestFor(await makeToken({ expiresIn: "0s" }))),
    undefined,
  );
  const { privateKey: wrongPrivateKey } = await generateKeyPair("RS256");
  const wrongSignature = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("owner-subject")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(wrongPrivateKey);
  assert.equal(await authenticate(requestFor(wrongSignature)), undefined);
  assert.equal(await authenticate(requestFor("not-a-jwt")), undefined);
});
