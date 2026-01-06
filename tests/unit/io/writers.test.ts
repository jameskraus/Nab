import { Writable } from "node:stream";

import { expect, test } from "bun:test";

import { IdsWriter } from "@/io/writers/idsWriter";
import { JsonWriter } from "@/io/writers/jsonWriter";
import { TsvWriter } from "@/io/writers/tsvWriter";

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

test("JsonWriter writes pretty JSON with newline", () => {
  const capture = createCapture();
  const writer = new JsonWriter({ stdout: capture.stream });

  writer.write({ ok: true });

  expect(capture.output()).toBe('{\n  "ok": true\n}\n');
});

test("TsvWriter writes header and rows", () => {
  const capture = createCapture();
  const writer = new TsvWriter({ stdout: capture.stream });

  writer.write([
    { id: "a", count: 2 },
    { id: "b", count: 3 },
  ]);

  expect(capture.output()).toBe("count\tid\n2\ta\n3\tb\n");
});

test("IdsWriter writes newline-delimited ids", () => {
  const capture = createCapture();
  const writer = new IdsWriter({ stdout: capture.stream });

  writer.write(["a", "b"]);

  expect(capture.output()).toBe("a\nb\n");
});
