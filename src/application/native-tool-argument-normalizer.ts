const OPTIONAL_NATIVE_SETTING_OVERRIDE_NAMES = new Set([
  "model",
  "modelProvider",
  "provider",
  "providerId",
  "thinking",
  "reasoningEffort",
  "reasoning_effort",
]);

/**
 * ChatGPT may serialize an unselected optional text field as an empty string.
 * For native model/settings overrides that changes the meaning from "inherit"
 * to an invalid explicit name. Remove only known setting fields that the
 * advertised schema marks optional; every other argument remains untouched.
 */
export function omitBlankOptionalNativeSettingOverrides<T>(
  inputSchema: unknown,
  argumentsValue: T,
): T {
  if (!isObject(argumentsValue) || !isObject(inputSchema)) return argumentsValue;
  const contracts = rootObjectContracts(inputSchema, inputSchema, new Set());
  if (contracts.length === 0) return argumentsValue;

  const removable = [...OPTIONAL_NATIVE_SETTING_OVERRIDE_NAMES].filter((name) => {
    const definingContracts = contracts.filter(
      (contract) => Object.hasOwn(contract.properties, name) || contract.required.has(name),
    );
    return (
      definingContracts.length > 0 &&
      definingContracts.every((contract) => !contract.required.has(name))
    );
  });
  if (removable.length === 0) return argumentsValue;

  let changed = false;
  const normalized = { ...argumentsValue } as Record<string, unknown>;
  for (const name of removable) {
    const value = normalized[name];
    if (typeof value === "string" && value.trim().length === 0) {
      delete normalized[name];
      changed = true;
    }
  }
  return (changed ? normalized : argumentsValue) as T;
}

interface RootObjectContract {
  readonly properties: Record<string, unknown>;
  readonly required: ReadonlySet<string>;
}

function rootObjectContracts(
  schema: Record<string, unknown>,
  document: Record<string, unknown>,
  references: Set<string>,
): RootObjectContract[] {
  let contracts: RootObjectContract[] = [ownRootObjectContract(schema)];

  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    if (!references.has(schema.$ref)) {
      const target = localReferenceTarget(document, schema.$ref);
      if (isObject(target)) {
        contracts = mergeContractSets(
          rootObjectContracts(target, document, new Set([...references, schema.$ref])),
          contracts,
        );
      }
    }
  }

  const allOf = Array.isArray(schema.allOf) ? schema.allOf.filter(isObject) : [];
  for (const fragment of allOf) {
    contracts = mergeContractSets(contracts, rootObjectContracts(fragment, document, references));
  }

  for (const keyword of ["oneOf", "anyOf"] as const) {
    const variants = Array.isArray(schema[keyword]) ? schema[keyword].filter(isObject) : [];
    if (variants.length === 0) continue;
    contracts = mergeContractSets(
      contracts,
      variants.flatMap((variant) => rootObjectContracts(variant, document, references)),
    );
  }

  return contracts;
}

function ownRootObjectContract(schema: Record<string, unknown>): RootObjectContract {
  return {
    properties: isObject(schema.properties) ? schema.properties : {},
    required: new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [],
    ),
  };
}

function mergeContractSets(
  left: readonly RootObjectContract[],
  right: readonly RootObjectContract[],
): RootObjectContract[] {
  return left.flatMap((leftContract) =>
    right.map((rightContract) => ({
      properties: { ...leftContract.properties, ...rightContract.properties },
      required: new Set([...leftContract.required, ...rightContract.required]),
    })),
  );
}

function localReferenceTarget(document: Record<string, unknown>, reference: string): unknown {
  let current: unknown = document;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    current = current[key];
  }
  return current;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
