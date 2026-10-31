import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZoomStage } from "./ZoomStage";

describe("ZoomStage", () => {
  const requestFullscreen = vi.fn().mockResolvedValue(undefined);
  const exitFullscreen = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    requestFullscreen.mockClear();
    exitFullscreen.mockClear();
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the browser for full screen on the stage", async () => {
    render(
      <ZoomStage label="Video call">
        <p>Face</p>
      </ZoomStage>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    expect(requestFullscreen).toHaveBeenCalledOnce();
    screen.getByText("Video call");
    screen.getByText("Face");
  });

  it("exits when already zoomed", async () => {
    const { container } = render(
      <ZoomStage label="Shared screen">
        <p>Prototype</p>
      </ZoomStage>,
    );
    const stage = container.querySelector("[data-testid='zoom-stage']");
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => stage,
    });
    document.dispatchEvent(new Event("fullscreenchange"));

    fireEvent.click(await screen.findByRole("button", { name: "Exit full screen" }));

    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});
