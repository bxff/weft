import { expect, test } from "bun:test";
import { startCloud } from "../src/server";

test("hosted pairing requires and records the active terms for the signed-in account", async () => {
  const previousDev = process.env.CLOUD_DEV_USER;
  const previousTerms = process.env.WEFT_REQUIRE_HOSTED_TERMS;
  process.env.CLOUD_DEV_USER = "1";
  process.env.WEFT_REQUIRE_HOSTED_TERMS = "1";
  const cloud = startCloud({ port: 0 });
  try {
    const endpoint = `http://127.0.0.1:${cloud.port}/api/pair`;
    const headers = { authorization: "Bearer dev:terms-user", "content-type": "application/json" };
    const policy = await fetch(endpoint, { headers });
    const { termsVersion } = await policy.json();
    expect(termsVersion).toBe("2026-11-27");
    expect(policy.headers.get("cache-control")).toBe("private, no-store");
    const pair = (body: object) => fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    for (const body of [{}, { acceptedTermsVersion: "2026-11-26" }]) {
      const response = await pair(body);
      expect(response.status).toBe(428);
      expect(await response.json()).toMatchObject({ termsVersion, termsAccepted: false });
    }
    expect(cloud.store.listDeviceTokens("terms-user")).toHaveLength(0);
    const result = await pair({ acceptedTermsVersion: termsVersion });
    expect(result.status).toBe(200);
    const { token } = await result.json();
    expect(cloud.store.userForDeviceToken(token)).toBe("terms-user");
    expect(cloud.store.hasAcceptedHostedTerms("terms-user", termsVersion)).toBe(true);
    expect(await (await fetch(endpoint, { headers })).json()).toEqual({ termsVersion, termsAccepted: true });
    expect((await pair({})).status).toBe(200);
    expect(await (await fetch(endpoint, { headers: { authorization: "Bearer dev:other-user" } })).json())
      .toEqual({ termsVersion, termsAccepted: false });
    expect((await fetch(endpoint, { method: "POST", headers: { "x-device-token": token } })).status).toBe(403);
  } finally {
    cloud.stop();
    if (previousDev === undefined) delete process.env.CLOUD_DEV_USER;
    else process.env.CLOUD_DEV_USER = previousDev;
    if (previousTerms === undefined) delete process.env.WEFT_REQUIRE_HOSTED_TERMS;
    else process.env.WEFT_REQUIRE_HOSTED_TERMS = previousTerms;
  }
});

test("password self-hosted pairing is unaffected even if the hosted flag is set", async () => {
  const previousPassword = process.env.WEFT_PASSWORD;
  const previousTerms = process.env.WEFT_REQUIRE_HOSTED_TERMS;
  process.env.WEFT_PASSWORD = "terms-test-password";
  process.env.WEFT_REQUIRE_HOSTED_TERMS = "1";
  const cloud = startCloud({ port: 0 });
  try {
    const base = `http://127.0.0.1:${cloud.port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "terms-test-password" }),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json();
    const headers = { authorization: `Bearer ${token}` };
    expect(await (await fetch(`${base}/api/pair`, { headers })).json())
      .toEqual({ termsVersion: null, termsAccepted: true });
    expect((await fetch(`${base}/api/pair`, { method: "POST", headers })).status).toBe(200);
  } finally {
    cloud.stop();
    if (previousPassword === undefined) delete process.env.WEFT_PASSWORD;
    else process.env.WEFT_PASSWORD = previousPassword;
    if (previousTerms === undefined) delete process.env.WEFT_REQUIRE_HOSTED_TERMS;
    else process.env.WEFT_REQUIRE_HOSTED_TERMS = previousTerms;
  }
});
