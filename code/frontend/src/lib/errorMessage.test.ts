import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { errorMessage } from "./errorMessage";

const networkFailure = new TypeError("Failed to fetch");

describe("errorMessage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [401, "This needs the team link with the passcode. Ask in Discord."],
    [422, "The input was rejected: boom"],
    [429, "boom"],
    [502, "The model's answer couldn't be used. Try again."],
    [503, "The persona service is temporarily unavailable. Try again in a moment."],
    [404, "Unexpected error 404: boom"],
  ])("explains a %i the same way in every build", (status, message) => {
    for (const nodeEnv of ["production", "development"]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      expect(errorMessage(new ApiError(status, "boom"))).toBe(message);
    }
  });

  describe("in a production build", () => {
    it("asks the user to check their connection when the request never got an answer", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(errorMessage(networkFailure)).toBe("Couldn't connect. Check your connection and try again.");
    });

    it.each([500, 504])("tells the user to try again after a %i", (status) => {
      vi.stubEnv("NODE_ENV", "production");
      expect(errorMessage(new ApiError(status, "boom"))).toBe(
        `The persona service is temporarily unavailable (${status}). Try again in a moment.`,
      );
    });
  });

  describe("in a development build", () => {
    it("points at the local backend when the request never got an answer", () => {
      vi.stubEnv("NODE_ENV", "development");
      expect(errorMessage(networkFailure)).toBe("Backend not reachable. Is `make dev` running?");
    });

    // The Next proxy answers 500 when the backend process isn't running.
    it.each([500, 504])("points at the local backend after a %i", (status) => {
      vi.stubEnv("NODE_ENV", "development");
      expect(errorMessage(new ApiError(status, "boom"))).toBe(`Backend not reachable (${status}). Is \`make dev\` running?`);
    });
  });
});
