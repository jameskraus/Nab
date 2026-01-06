import { Writable } from "node:stream";

import { expect, test } from "bun:test";

import { formatDate } from "@/io/formatters";
import { column, fieldColumn } from "@/io/table/columns";
import { TableWriter } from "@/io/table/tableWriter";

function createCapture() {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    output: () => data,
  };
}

test("formatDate preserves string dates and normalizes Date objects", () => {
  expect(formatDate("2026-01-04")).toBe("2026-01-04");
  expect(formatDate(new Date("2026-01-04T12:00:00Z"))).toBe("2026-01-04");
  expect(formatDate(null)).toBe("");
});

test("column helpers build table columns", () => {
  const c1 = fieldColumn<{ id: string }>("id");
  const c2 = column<{ id: string }>("Identifier", (row) => row.id, { align: "right" });

  expect(c1.header).toBe("id");
  expect(c2.header).toBe("Identifier");
  expect(c2.align).toBe("right");
});

test("TableWriter renders a padded table", () => {
  const capture = createCapture();
  const writer = new TableWriter<{ id: string; date: string; count: number }>({
    stdout: capture.stream,
  });

  writer.write({
    columns: [
      fieldColumn("id", { header: "ID" }),
      column("Date", (row) => formatDate(row.date)),
      column("Count", (row) => row.count, { align: "right" }),
    ],
    rows: [
      { id: "a", date: "2026-01-04", count: 2 },
      { id: "bb", date: "2026-01-05", count: 12 },
    ],
  });

  expect(capture.output()).toBe(
    "ID  Date        Count\n" +
      "--  ----------  -----\n" +
      "a   2026-01-04      2\n" +
      "bb  2026-01-05     12\n",
  );
});
