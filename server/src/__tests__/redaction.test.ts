import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts bare token and CF-Access-Client-* keys (NOR-4845)", () => {
    const input = {
      headers: {
        "x-openclaw-token": "wss-bearer-abc",
        "X-Openclaw-Auth": "legacy-token",
        "CF-Access-Client-Id": "cf-client-id-value",
        "CF-Access-Client-Secret": "cf-client-secret-value",
        token: "bare-token-value",
        "content-type": "application/json",
      },
      devicePrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
      safeField: "ok",
    };

    const result = sanitizeRecord(input);

    expect(result.headers).toEqual({
      "x-openclaw-token": REDACTED_EVENT_VALUE,
      "X-Openclaw-Auth": REDACTED_EVENT_VALUE,
      "CF-Access-Client-Id": REDACTED_EVENT_VALUE,
      "CF-Access-Client-Secret": REDACTED_EVENT_VALUE,
      token: REDACTED_EVENT_VALUE,
      "content-type": "application/json",
    });
    expect(result.devicePrivateKeyPem).toBe(REDACTED_EVENT_VALUE);
    expect(result.safeField).toBe("ok");
  });
});
