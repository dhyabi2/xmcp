import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  hashNanoStateBlock,
  nanoAddressToPublicKey,
  publicKeyToNanoAddress,
  type NanoRpc,
  type NanoStateBlock,
} from "../src/nano.js";
import {
  nanoBlockPaymentPayload,
  nanoPaymentPayload,
  payment,
  planNanoPayment,
  x402Provider,
  type NanoPaymentPlan,
} from "../src/index.js";
import { x402Registry } from "../src/registry.js";
import type { X402Config } from "../src/types.js";

// The payer side of `payload.block`: the wallet signs the send the plan
// describes and the server publishes it. The block is checked against the
// plan before it leaves the client.

const WALLET =
  "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const PAYER = publicKeyToNanoAddress("EF".repeat(32));
const RAW_PER_XNO = 10n ** 30n;
const PRICE_RAW = (RAW_PER_XNO / 100n).toString(); // 0.01 XNO
const CAP_RAW = (RAW_PER_XNO / 10n).toString(); // 0.1 XNO
const PREVIOUS_BALANCE = 5n * RAW_PER_XNO;

let hashCounter = 0;
function newHash(): string {
  hashCounter += 1;
  return (0x0bbb0000 + hashCounter)
    .toString(16)
    .toUpperCase()
    .padStart(64, "0");
}

/** What a wallet would sign for the plan (the signature is not checked here) */
function signedSend(
  plan: NanoPaymentPlan,
  change: Partial<NanoStateBlock> & { sent?: bigint } = {}
): NanoStateBlock {
  const { sent = BigInt(plan.amountRaw), ...fields } = change;
  return {
    type: "state",
    account: PAYER,
    previous: newHash(),
    representative: plan.representative ?? PAYER,
    balance: (PREVIOUS_BALANCE - sent).toString(),
    link: nanoAddressToPublicKey(plan.payTo)!,
    link_as_account: plan.payTo,
    signature: "AB".repeat(64),
    work: "0123456789abcdef",
    ...fields,
  };
}

/** A node that publishes one block and then reports it confirmed */
function nodeFor(state: { block?: NanoStateBlock; published: unknown[] }) {
  const rpc: NanoRpc = async (body) => {
    const block = state.block;
    if (!block) return { error: "Block not found" };
    const hash = hashNanoStateBlock(block);
    if (body.action === "process") {
      state.published.push(JSON.parse(body.block));
      return { hash };
    }
    if (body.hash === hash && state.published.length > 0) {
      return {
        block_account: block.account,
        amount: (PREVIOUS_BALANCE - BigInt(block.balance)).toString(),
        balance: block.balance,
        confirmed: "true",
        subtype: "send",
        contents: { ...block },
      };
    }
    if (body.hash === block.previous) {
      return {
        block_account: block.account,
        balance: PREVIOUS_BALANCE.toString(),
        confirmed: "true",
        subtype: "receive",
        contents: { type: "state", balance: PREVIOUS_BALANCE.toString() },
      };
    }
    return { error: "Block not found" };
  };
  return rpc;
}

function callTool(
  middleware: ReturnType<typeof x402Provider>,
  paymentMeta?: unknown
): Promise<{ nextCalled: boolean; body: any; context?: unknown }> {
  return new Promise((resolve) => {
    const result: { nextCalled: boolean; body: any; context?: unknown } = {
      nextCalled: false,
      body: undefined,
    };
    const req = {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "nano-block-payer-tool",
          arguments: {},
          ...(paymentMeta !== undefined
            ? { _meta: { "x402/payment": paymentMeta } }
            : {}),
        },
      },
    } as unknown as Request;
    const res = {
      status() {
        return res;
      },
      json(body: unknown) {
        result.body = body;
        resolve(result);
      },
      end(chunk: string) {
        result.body = JSON.parse(chunk);
        resolve(result);
      },
    } as unknown as Response;
    const next: NextFunction = () => {
      result.nextCalled = true;
      result.context = payment();
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })
      );
    };
    middleware(req, res, next);
  });
}

x402Registry.register("nano-block-payer-tool", {
  network: "nano",
  price: 0.01,
});

function server(nano: Partial<NonNullable<X402Config["nano"]>>) {
  const state: { block?: NanoStateBlock; published: unknown[] } = {
    published: [],
  };
  const middleware = x402Provider({
    wallet: EVM_WALLET,
    nano: { wallet: WALLET, rpc: nodeFor(state), ...nano },
  });
  return { middleware, state };
}

test("a bound v2 offer is paid with a signed block the server publishes", async () => {
  const { middleware, state } = server({
    x402Version: 2,
    requireBinding: true,
  });
  const unpaid = await callTool(middleware);
  const plan = await planNanoPayment(unpaid.body.result, {
    maxAmountRaw: CAP_RAW,
    allowedPayees: [WALLET],
  });
  assert.ok(plan.representative);

  const block = signedSend(plan);
  state.block = block;
  const { payment: meta, blockHash } = nanoBlockPaymentPayload(plan, block, {
    previousBalanceRaw: PREVIOUS_BALANCE,
  });
  assert.equal(blockHash, hashNanoStateBlock(block));
  assert.deepEqual((meta as any).payload, { block, orderId: plan.orderId });
  assert.equal((meta as any).x402Version, 2);

  const paid = await callTool(middleware, meta);
  assert.equal(paid.nextCalled, true);
  assert.deepEqual(state.published, [block]);
  assert.deepEqual(paid.context, {
    payer: PAYER,
    amount: PRICE_RAW,
    network: "nano:mainnet",
    asset: "XNO",
    transactionHash: blockHash,
    toolName: "nano-block-payer-tool",
  });

  // The same block, by itself or by its hash, does not pay a second call
  const replay = await callTool(middleware, meta);
  assert.equal(replay.nextCalled, false);
  assert.match(replay.body.result.structuredContent.error, /already/i);
  const byHash = await callTool(
    middleware,
    nanoPaymentPayload(plan, blockHash)
  );
  assert.equal(byHash.nextCalled, false);
  assert.equal(state.published.length, 1);
});

test("a v1 offer is paid with a signed block in v1", async () => {
  const { middleware, state } = server({});
  const unpaid = await callTool(middleware);
  const plan = await planNanoPayment(unpaid.body.result, {
    maxAmountRaw: CAP_RAW,
  });
  assert.equal(plan.x402Version, 1);

  const block = signedSend(plan);
  state.block = block;
  const { payment: meta } = nanoBlockPaymentPayload(plan, block, {
    previousBalanceRaw: PREVIOUS_BALANCE.toString(),
  });
  assert.deepEqual(meta, {
    x402Version: 1,
    scheme: "exact",
    network: "nano",
    payload: { block },
  });
  const paid = await callTool(middleware, meta);
  assert.equal(paid.nextCalled, true);
});

test("nanoBlockPaymentPayload refuses a block that is not the plan", async () => {
  const bound = await planNanoPayment(
    {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "nano:mainnet",
          amount: PRICE_RAW,
          payTo: WALLET,
          asset: "XNO",
          extra: { binding: "xno-binding/v1/rep", orderId: "c".repeat(32) },
        },
      ],
    },
    { maxAmountRaw: CAP_RAW }
  );
  const options = { previousBalanceRaw: PREVIOUS_BALANCE };
  const refuse = (
    block: unknown,
    pattern: RegExp,
    opts: { previousBalanceRaw: unknown } = options
  ) =>
    assert.throws(
      () => nanoBlockPaymentPayload(bound, block, opts as typeof options),
      pattern
    );

  // The plan itself passes
  nanoBlockPaymentPayload(bound, signedSend(bound), options);

  const other = publicKeyToNanoAddress("01".repeat(32));
  refuse(
    signedSend(bound, {
      link: nanoAddressToPublicKey(other)!,
      link_as_account: other,
    }),
    /does not pay/
  );
  refuse(signedSend(bound, { sent: BigInt(PRICE_RAW) + 1n }), /exactly/);
  refuse(signedSend(bound, { sent: BigInt(PRICE_RAW) - 1n }), /exactly/);
  // A balance above the previous one is a receive, not a send
  refuse(signedSend(bound, { sent: -1n }), /exactly/);
  refuse(signedSend(bound, { representative: PAYER }), /not bound/);
  refuse(signedSend(bound, { previous: "0".repeat(64) }), /opens an account/);
  refuse(signedSend(bound, { type: "send" } as never), /Not a signed/);
  refuse(signedSend(bound, { work: "" }), /Not a signed/);
  refuse(signedSend(bound, { link_as_account: other }), /Not a signed/);
  refuse("not a block", /Not a signed/);
  refuse(signedSend(bound), /previousBalanceRaw/, { previousBalanceRaw: "-1" });
  refuse(signedSend(bound), /previousBalanceRaw/, {
    previousBalanceRaw: "1.5",
  });
  refuse(signedSend(bound), /previousBalanceRaw/, {
    previousBalanceRaw: 5,
  });
});

test("an unbound plan takes the wallet's own representative", async () => {
  const plan = await planNanoPayment(
    {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "nano:mainnet",
          amount: PRICE_RAW,
          payTo: WALLET,
        },
      ],
    },
    { maxAmountRaw: CAP_RAW }
  );
  const block = signedSend(plan, {
    representative: publicKeyToNanoAddress("02".repeat(32)),
  });
  const { payment: meta } = nanoBlockPaymentPayload(plan, block, {
    previousBalanceRaw: PREVIOUS_BALANCE,
  });
  assert.deepEqual((meta as any).payload, { block });
});
