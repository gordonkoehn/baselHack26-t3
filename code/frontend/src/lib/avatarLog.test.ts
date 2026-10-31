import { describe, expect, it, vi } from "vitest";
import { logAvatarFailure, safeCause } from "./avatarLog";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl";

describe("safeCause", () => {
  it.each([
    "ERROR: INVALID_FACE_ID",
    "ERROR: SESSION_TOKEN_EXPIRED",
    "RATE LIMIT EXCEEDED",
    "CLOSING: maximum session length reached",
    "Websocket Failed",
    "Connection Timed Out",
    "invalid token",
  ])("keeps a plain cause: %s", (cause) => {
    expect(safeCause(cause)).toBe(cause);
  });

  it("names the error type of an exception", () => {
    expect(safeCause(new Error("Too Many Retry Attempts Failed to connect"))).toBe(
      "Error: Too Many Retry Attempts Failed to connect",
    );
  });

  it.each([
    ["URL with a token", `LiveKit join failed: could not connect to wss://x.livekit.cloud/rtc?access_token=${JWT}`, JWT],
    ["bare JWT", `failed with ${JWT}`, JWT],
    ["labelled value", "ERROR: session_token: abc123", "abc123"],
    ["labelled value, no space", "api_key:abc123 was refused", "abc123"],
    ["assignment", "x-simli-api-key=abc123 was refused", "abc123"],
    ["bearer header", "Authorization: Bearer abc123", "abc123"],
    ["long key", "refused key 0123456789abcdef0123", "0123456789abcdef0123"],
    ["join details", '{"livekit_url": "wss://x", "livekit_token": "abc123"}', "abc123"],
  ])("hides a secret: %s", (_name, cause, secret) => {
    expect(safeCause(cause)).not.toContain(secret);
    expect(safeCause(new Error(cause))).not.toContain(secret);
  });

  it("keeps the readable part next to a hidden secret", () => {
    expect(safeCause(`LiveKit join failed: bad wss://x?access_token=${JWT}`)).toBe("LiveKit join failed: bad [redacted]");
  });

  it("withholds SDP entirely", () => {
    const sdp = "v=0\r\no=- 123 2 IN IP4 203.0.113.7\r\na=ice-pwd:abc123";
    for (const cause of [sdp, `{"type":"answer","sdp":"${sdp}"}`]) {
      expect(safeCause(cause)).toBe("[withheld: connection details]");
    }
  });

  it("never stringifies an unknown shape", () => {
    expect(safeCause({ token: "abc123" })).toBe("no readable message (object)");
  });

  it("caps the length and handles empty text", () => {
    expect(safeCause("word ".repeat(200)).length).toBeLessThanOrEqual(201);
    expect(safeCause(" ")).toBe("no message");
  });
});

describe("logAvatarFailure", () => {
  it("writes one console error line with the stable prefix", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logAvatarFailure("off", "ERROR: INVALID_FACE_ID");
    expect(error.mock.calls).toEqual([["[avatar] off: ERROR: INVALID_FACE_ID"]]);
  });
});
