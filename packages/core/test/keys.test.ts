import { expect, test } from "bun:test";
import { decodeInput } from "../src/keys.ts";
import fixtures from "../../../test/fixtures/keys.json";

// The same fixtures drive relay/keys_test.go, so the two decoders cannot drift.
test.each(fixtures.cases.map((c) => [JSON.stringify(c.in), c] as const))(
  "decodeInput %s",
  (_label, c) => {
    expect(decodeInput(c.in)).toEqual(c.out as never);
  },
);
