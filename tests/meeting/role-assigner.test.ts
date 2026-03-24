import { describe, it, expect } from "vitest";
import { assignRoles } from "../../src/meeting/role-assigner.js";

describe("assignRoles", () => {
  it("assigns pro/con for 2 participants", () => {
    const result = assignRoles(2);
    expect(result).toEqual([
      { label: "A", role: "pro" },
      { label: "B", role: "con" },
    ]);
  });

  it("assigns pro/con/arbiter for 3 participants", () => {
    const result = assignRoles(3);
    expect(result).toEqual([
      { label: "A", role: "pro" },
      { label: "B", role: "con" },
      { label: "C", role: "arbiter" },
    ]);
  });

  it("distributes roles for 4 participants", () => {
    const result = assignRoles(4);
    expect(result).toHaveLength(4);
    expect(result.filter(r => r.role === "pro")).toHaveLength(1);
    expect(result.filter(r => r.role === "con")).toHaveLength(2);
    expect(result.filter(r => r.role === "arbiter")).toHaveLength(1);
  });

  it("uses custom names when provided", () => {
    const result = assignRoles(2, ["Alice", "Bob"]);
    expect(result[0].label).toBe("Alice");
    expect(result[1].label).toBe("Bob");
  });

  it("generates A,B,C,D,E labels by default", () => {
    const result = assignRoles(5);
    expect(result.map(r => r.label)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("throws for count < 2", () => {
    expect(() => assignRoles(1)).toThrow();
  });
});
