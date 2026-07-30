import { describe, it, expect } from "vitest";
import { splitSqlStatements } from "./db.js";

describe("splitSqlStatements", () => {
  it("keeps CREATE TABLE after leading comment lines", () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS a (id INT);

    -- Teacher interactions
    CREATE TABLE IF NOT EXISTS interaction_stamps (
      id VARCHAR(64) PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS stuck_reports (
      id VARCHAR(64) PRIMARY KEY
    );
`;
    const stmts = splitSqlStatements(sql);
    expect(stmts.length).toBe(3);
    expect(stmts[0]).toMatch(/CREATE TABLE IF NOT EXISTS a/i);
    expect(stmts[1]).toMatch(/CREATE TABLE IF NOT EXISTS interaction_stamps/i);
    expect(stmts[1]).not.toMatch(/^--/);
    expect(stmts[2]).toMatch(/CREATE TABLE IF NOT EXISTS stuck_reports/i);
  });

  it("drops pure comment chunks", () => {
    const sql = `
    -- only comment
    ;
    CREATE TABLE IF NOT EXISTS x (id INT);
`;
    const stmts = splitSqlStatements(sql);
    expect(stmts.length).toBe(1);
    expect(stmts[0]).toMatch(/CREATE TABLE IF NOT EXISTS x/i);
  });
});
