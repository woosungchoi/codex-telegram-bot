import test from "node:test";
import assert from "node:assert/strict";
import { workerInputReceipt } from "../src/worker/input_receipt.js";

test("worker admission is distinct from native input acceptance and ambiguous terminal input", () => {
  assert.equal(workerInputReceipt({ status: "accepted" }), "unsent");
  assert.equal(workerInputReceipt({ status: "running" }), "not_checked");
  assert.equal(workerInputReceipt({ status: "running", inputReceipt: { status: "sending" } }), "pending");
  assert.equal(workerInputReceipt({ status: "failed", inputReceipt: { status: "sending" } }), "uncertain");
  assert.equal(workerInputReceipt({ status: "cancelled" }), "uncertain");
  assert.equal(workerInputReceipt({ status: "running", inputReceipt: { status: "unrecognized" } }), "uncertain");
  for (const status of ["accepted", "confirmed"]) {
    assert.equal(workerInputReceipt({ status: "running", inputReceipt: { status } }), "accepted");
    assert.equal(workerInputReceipt({ status: "failed", inputReceipt: { status } }), "accepted");
  }
  assert.equal(workerInputReceipt({ status: "completed" }), "recovered");
});
