import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it, vi } from "vitest";
import { CommandService } from "../../server-sdk/core/src/commandService.js";
import type { AgentGateway } from "../../server-sdk/core/src/gateway.js";
import { envelope, imagePacket } from "../../server-sdk/core/src/protocol.js";
import type { ProtocolEnvelope } from "../../server-sdk/core/src/types.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(root, "test/fixtures/protocol");

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function contractValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  (formatsModule.default as unknown as FormatsPlugin)(ajv);
  const schemaDirectory = join(root, "device-sdk/schemas");
  for (const name of readdirSync(schemaDirectory).filter((value) => value.endsWith(".json")).sort()) {
    ajv.addSchema(json<AnySchema>(join(schemaDirectory, name)), name);
  }
  const modelSchema = json<AnySchema>(join(root, "model_interface/schemas/model-event.schema.json"));
  ajv.addSchema(modelSchema, "model-event.schema.json");
  return ajv;
}

function requireValidator(ajv: Ajv2020, id: string): ValidateFunction {
  const validator = ajv.getSchema(id);
  if (!validator) throw new Error(`Schema ${id} was not registered`);
  return validator;
}

describe("Gelato protocol contracts", () => {
  it("compiles every schema with all references resolved", () => {
    const ajv = contractValidator();
    const expected = [
      "agent-descriptor", "capability", "command", "envelope", "input", "observation",
      "preflight", "reply", "snapshot", "stream-offer", "model-event"
    ];
    for (const name of expected) {
      expect(requireValidator(ajv, `urn:gelato:v1:${name}`), name).toBeTypeOf("function");
    }
  });

  it("accepts one maintained fixture for every device schema", () => {
    const ajv = contractValidator();
    const fixtures = json<Record<string, unknown>>(join(fixtureRoot, "valid-device.json"));
    expect(Object.keys(fixtures).sort()).toEqual([
      "agent-descriptor", "capability", "command", "envelope", "input", "observation",
      "preflight", "reply", "snapshot", "stream-offer"
    ]);
    for (const [name, value] of Object.entries(fixtures)) {
      const validate = requireValidator(ajv, `urn:gelato:v1:${name}`);
      expect(validate(value), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("rejects maintained invalid device fixtures", () => {
    const ajv = contractValidator();
    const fixtures = json<Array<{ schema: string; name: string; value: unknown }>>(
      join(fixtureRoot, "invalid-device.json")
    );
    for (const fixture of fixtures) {
      const validate = requireValidator(ajv, `urn:gelato:v1:${fixture.schema}`);
      expect(validate(fixture.value), `${fixture.schema}/${fixture.name} unexpectedly passed`).toBe(false);
    }
  });

  it("accepts all model event types and rejects boundary violations", () => {
    const ajv = contractValidator();
    const validate = requireValidator(ajv, "urn:gelato:v1:model-event");
    const valid = json<unknown[]>(join(fixtureRoot, "valid-model-events.json"));
    const invalid = json<Array<{ name: string; value: unknown }>>(
      join(fixtureRoot, "invalid-model-events.json")
    );
    expect(new Set(valid.map((value) => (value as { type: string }).type)).size).toBe(13);
    for (const event of valid) {
      expect(validate(event), ajv.errorsText(validate.errors)).toBe(true);
    }
    for (const fixture of invalid) {
      expect(validate(fixture.value), `${fixture.name} unexpectedly passed`).toBe(false);
    }
  });

  it("validates runtime-generated envelopes and command bodies", async () => {
    const ajv = contractValidator();
    const validateEnvelope = requireValidator(ajv, "urn:gelato:v1:envelope");
    const validateCommand = requireValidator(ajv, "urn:gelato:v1:command");
    expect(validateEnvelope(envelope("lease.renew", {})), ajv.errorsText(validateEnvelope.errors)).toBe(true);

    class Gateway extends EventEmitter {
      send = vi.fn<(deviceId: string, value: ProtocolEnvelope) => void>();
    }
    const gateway = new Gateway();
    const commands = new CommandService(gateway as unknown as AgentGateway, {
      resolve: () => ({ name: "screen.capture", version: 1 })
    } as never);
    const pending = commands.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand001",
      capability: "screen.capture",
      arguments: {},
      idempotency: "read-only"
    });
    const generated = gateway.send.mock.calls[0][1];
    expect(validateEnvelope(generated), ajv.errorsText(validateEnvelope.errors)).toBe(true);
    expect(validateCommand(generated.body), ajv.errorsText(validateCommand.errors)).toBe(true);
    gateway.emit("command.result", { ...generated, type: "command.result", body: {} });
    await pending;

    const packet = imagePacket(7, Buffer.from("jpeg"), { sourceTimeS: 1.25 });
    expect(packet.timing).toMatchObject({ type: "stream.frame", sequence: 7, sourceTimeS: 1.25 });
    expect(packet.binary.readUInt32BE(0)).toBe(7);
  });

  it("requires fixture review when protocol specifications or schemas change", () => {
    const expected = json<Record<string, string>>(join(fixtureRoot, "contract-revision.json"));
    for (const [file, digest] of Object.entries(expected)) {
      const actual = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
      expect(actual, `${file} changed; review protocol fixtures and update contract-revision.json`).toBe(digest);
    }
  });
});
