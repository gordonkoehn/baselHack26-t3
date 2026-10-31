import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InterviewScript } from "./InterviewScript";

afterEach(cleanup);

describe("InterviewScript", () => {
  it("shows the questions with progress, and ticking moves it forward and back", () => {
    render(<InterviewScript questions={["First?", "Second?"]} />);

    screen.getByText("0 of 2");
    const first = screen.getByRole("checkbox", { name: "First?" });

    fireEvent.click(first);
    screen.getByText("1 of 2");

    fireEvent.click(first);
    screen.getByText("0 of 2");
  });

  it("renders nothing without questions", () => {
    const { container } = render(<InterviewScript questions={[]} />);

    expect(container.firstChild).toBeNull();
  });
});
