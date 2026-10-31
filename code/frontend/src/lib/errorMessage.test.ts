import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it.each([
    [401, "This needs the team link with the passcode. Ask in Discord."],
    [422, "The input was rejected: boom"],
    [429, "boom"],
    [502, "The model's answer couldn't be used. Try again."],
    [503, "The persona service is temporarily unavailable. Try again in a moment."],
    // The Next proxy answers 500 when the backend process isn't running.
    [500, "Backend not reachable (500). Is `make dev` running?"],
    [504, "Backend not reachable (504). Is `make dev` running?"],
    [404, "Unexpected error 404: boom"],
  ])("explains a %i", (status, message) => {
    expect(errorMessage(new ApiError(status, "boom"))).toBe(message);
  });

  it("treats anything that is not an API answer as an unreachable backend", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe("Backend not reachable. Is `make dev` running?");
  });
});
