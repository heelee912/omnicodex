// TypeScript 7's package root intentionally exposes only version metadata.
// Keep the project's TS 7 compiler while using the stable TS 5.9 compiler API
// under an explicit runtime alias for parsing Codex's published declarations.
import * as ts from "typescript-legacy";

export type JsonSchema = Record<string, unknown>;

const OPEN_FALLBACK_KEY = "x-omnicodex-open-fallback";
const DIAGNOSTICS_KEY = "x-omnicodex-typescript-diagnostics";
const VIRTUAL_LIB_FILE = "omnicodex-schema-lib.d.ts";
const VIRTUAL_LIB_SOURCE = `
interface ReadonlyArray<T> { readonly [index: number]: T; readonly length: number; }
interface Array<T> extends ReadonlyArray<T> { [index: number]: T; length: number; }
interface Promise<T> {}
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Record<K extends PropertyKey, T> = { [P in K]: T };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends PropertyKey> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T & {};
type PropertyKey = string | number | symbol;
`;

interface SchemaContext {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly resolving: ReadonlySet<ts.Type>;
}

/**
 * Reconstructs the public input schema from the exact TypeScript declaration
 * Codex publishes in a nested tool description. ALL_TOOLS exposes no separate
 * JSON Schema for these processless nested tools.
 *
 * The compiler resolves local aliases, interfaces, enums, mapped/utility
 * types, generic substitutions and readonly wrappers before projection. A
 * future construct that cannot be projected stays callable through an open
 * schema carrying the exact source and a machine-readable diagnostic; it is
 * never silently narrowed to an empty object contract.
 */
export function inputSchemaFromToolDescription(
  toolName: string,
  description: string,
): JsonSchema | undefined {
  const sourceText = typescriptSources(description).join("\n");
  if (sourceText.length === 0) return undefined;

  const fileName = `omnicodex-${toolName.replace(/\W/g, "_")}.ts`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    noLib: true,
    strict: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === fileName || candidate === VIRTUAL_LIB_FILE,
    readFile: (candidate) =>
      candidate === fileName
        ? sourceText
        : candidate === VIRTUAL_LIB_FILE
          ? VIRTUAL_LIB_SOURCE
          : undefined,
    getSourceFile: (candidate, languageVersion) => {
      const text =
        candidate === fileName
          ? sourceText
          : candidate === VIRTUAL_LIB_FILE
            ? VIRTUAL_LIB_SOURCE
            : undefined;
      return text === undefined
        ? undefined
        : ts.createSourceFile(candidate, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => VIRTUAL_LIB_FILE,
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram({ rootNames: [VIRTUAL_LIB_FILE, fileName], options, host });
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) {
    return openFallbackFromSource(
      "source_unavailable",
      "TypeScript did not return the published declaration source",
      sourceText,
      "SourceFile",
    );
  }

  const checker = program.getTypeChecker();
  const parameterTypes = toolParameterTypes(toolName, sourceFile, checker);
  if (parameterTypes.kind === "parameterless") return emptyObjectSchema();
  if (parameterTypes.kind === "missing") {
    return withCompilerDiagnostics(
      openFallbackFromSource(
        "tool_declaration_not_found",
        `No typed declaration for ${toolName} was found`,
        sourceText,
        "SourceFile",
      ),
      program,
      sourceFile,
    );
  }

  const context: SchemaContext = { checker, sourceFile, resolving: new Set() };
  const schemas = parameterTypes.values.map((type) => schemaForType(type, context));
  return withCompilerDiagnostics(unionOfSchemas(schemas), program, sourceFile);
}

function typescriptSources(description: string): string[] {
  const fences = [...description.matchAll(/```(?:ts|typescript)\s*\r?\n([\s\S]*?)```/gi)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
  if (fences.length > 0) return fences;
  const declaration = description.slice(description.indexOf("declare const tools:"));
  return declaration.startsWith("declare const tools:") ? [declaration] : [];
}

function toolParameterTypes(
  toolName: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
):
  | { readonly kind: "found"; readonly values: readonly ts.Type[] }
  | { readonly kind: "parameterless" }
  | { readonly kind: "missing" } {
  const types: ts.Type[] = [];
  let parameterless = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) &&
      propertyName(node.name, sourceFile) === toolName
    ) {
      const parameter = node.parameters[0];
      if (parameter === undefined) parameterless = true;
      else if (parameter.type !== undefined)
        types.push(checker.getTypeFromTypeNode(parameter.type));
      return;
    }
    if (
      ts.isPropertySignature(node) &&
      propertyName(node.name, sourceFile) === toolName &&
      node.type !== undefined
    ) {
      const signatures = checker.getSignaturesOfType(
        checker.getTypeFromTypeNode(node.type),
        ts.SignatureKind.Call,
      );
      for (const signature of signatures) {
        const parameter = signature.getParameters()[0];
        if (parameter === undefined) parameterless = true;
        else {
          types.push(
            checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration ?? node),
          );
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (types.length > 0) return { kind: "found", values: types };
  return parameterless ? { kind: "parameterless" } : { kind: "missing" };
}

function schemaForType(type: ts.Type, context: SchemaContext): JsonSchema {
  const flags = type.flags;
  if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return {};
  if ((flags & ts.TypeFlags.Never) !== 0) return { not: {} };
  if ((flags & ts.TypeFlags.String) !== 0) return { type: "string" };
  if ((flags & ts.TypeFlags.Number) !== 0) return { type: "number" };
  if ((flags & ts.TypeFlags.Boolean) !== 0) return { type: "boolean" };
  if ((flags & ts.TypeFlags.Null) !== 0) return { type: "null" };
  if ((flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
    return openFallback(type, context, "non_json_undefined", "undefined has no JSON value");
  }
  if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
    return { const: (type as ts.StringLiteralType).value };
  }
  if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return { const: (type as ts.NumberLiteralType).value };
  }
  if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return { const: intrinsicBooleanValue(type, context.checker) };
  }
  if ((flags & ts.TypeFlags.BigIntLiteral) !== 0 || (flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    return openFallback(
      type,
      context,
      "non_json_primitive",
      "The TypeScript primitive has no lossless JSON representation",
    );
  }
  if ((flags & ts.TypeFlags.Union) !== 0) {
    const members = (type as ts.UnionType).types.filter(
      (member) => (member.flags & ts.TypeFlags.Undefined) === 0,
    );
    const values = members.map(literalValue);
    if (values.every((entry) => entry.matched)) {
      const literalValues = values.map((entry) => entry.value);
      if (
        literalValues.length === 2 &&
        literalValues.includes(true) &&
        literalValues.includes(false)
      ) {
        return { type: "boolean" };
      }
      return { enum: literalValues };
    }
    return unionOfSchemas(members.map((member) => schemaForType(member, context)));
  }
  if ((flags & ts.TypeFlags.Intersection) !== 0) {
    const members = (type as ts.IntersectionType).types;
    if (members.every((member) => (member.flags & ts.TypeFlags.Object) !== 0)) {
      return objectSchema(type, context);
    }
    return { allOf: members.map((member) => schemaForType(member, context)) };
  }
  if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = context.checker.getBaseConstraintOfType(type);
    return constraint === undefined
      ? openFallback(type, context, "unbound_type_parameter", "Generic type is not bound")
      : schemaForType(constraint, context);
  }
  if ((flags & ts.TypeFlags.TemplateLiteral) !== 0) {
    return withOpenFallback(
      { type: "string" },
      type,
      context,
      "template_literal_approximated",
      "Template literal constraints are represented as an open string",
    );
  }
  if ((flags & ts.TypeFlags.NonPrimitive) !== 0) {
    return { type: "object", additionalProperties: true };
  }
  if ((flags & ts.TypeFlags.Object) !== 0) {
    if (context.checker.isTupleType(type)) return tupleSchema(type, context);
    if (context.checker.isArrayType(type)) {
      const element = context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      return { type: "array", items: element === undefined ? {} : schemaForType(element, context) };
    }
    return objectSchema(type, context);
  }
  return openFallback(
    type,
    context,
    "unsupported_type",
    `Unsupported resolved TypeScript flags ${flags}`,
  );
}

function objectSchema(type: ts.Type, context: SchemaContext): JsonSchema {
  if (context.resolving.has(type)) {
    return openFallback(
      type,
      context,
      "recursive_type_reference",
      "Recursive branch remains open for lossless native arguments",
    );
  }
  const resolving = new Set(context.resolving);
  resolving.add(type);
  const child = { ...context, resolving };
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const property of context.checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = context.checker.getTypeOfSymbolAtLocation(
      property,
      declaration ?? context.sourceFile,
    );
    const base = schemaForType(propertyType, child);
    const description = symbolDescription(property, context.checker, context.sourceFile);
    properties[property.getName()] = description === undefined ? base : { ...base, description };
    if ((property.flags & ts.SymbolFlags.Optional) === 0) required.push(property.getName());
  }

  const stringIndex = context.checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndex = context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  const indexSchemas = [stringIndex, numberIndex]
    .filter((entry): entry is ts.Type => entry !== undefined)
    .map((entry) => schemaForType(entry, child));
  const callSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (
    Object.keys(properties).length === 0 &&
    indexSchemas.length === 0 &&
    callSignatures.length > 0
  ) {
    return openFallback(
      type,
      context,
      "non_json_function",
      "Function values have no lossless JSON representation",
    );
  }
  const additionalProperties =
    indexSchemas.length === 0
      ? false
      : indexSchemas.length === 1
        ? (indexSchemas[0] ?? true)
        : { allOf: indexSchemas };
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties,
  };
}

function tupleSchema(type: ts.Type, context: SchemaContext): JsonSchema {
  const typeArguments = context.checker.getTypeArguments(type as ts.TypeReference);
  const target = (
    type as ts.TypeReference & {
      readonly target?: { readonly elementFlags?: readonly ts.ElementFlags[] };
    }
  ).target;
  const elementFlags = target?.elementFlags ?? typeArguments.map(() => ts.ElementFlags.Required);
  const prefixItems: JsonSchema[] = [];
  let minItems = 0;
  let items: JsonSchema | undefined;
  for (const [index, element] of typeArguments.entries()) {
    const flag = elementFlags[index] ?? ts.ElementFlags.Required;
    if ((flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0) {
      items = schemaForType(element, context);
      continue;
    }
    prefixItems.push(schemaForType(element, context));
    if ((flag & ts.ElementFlags.Optional) === 0) minItems += 1;
  }
  return {
    type: "array",
    prefixItems,
    minItems,
    ...(items === undefined ? { maxItems: prefixItems.length } : { items }),
  };
}

function literalValue(type: ts.Type): { readonly matched: boolean; readonly value?: unknown } {
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return { matched: true, value: (type as ts.StringLiteralType).value };
  }
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return { matched: true, value: (type as ts.NumberLiteralType).value };
  }
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    const intrinsicName = (type as ts.Type & { readonly intrinsicName?: string }).intrinsicName;
    return intrinsicName === "true"
      ? { matched: true, value: true }
      : intrinsicName === "false"
        ? { matched: true, value: false }
        : { matched: false };
  }
  if ((type.flags & ts.TypeFlags.Null) !== 0) return { matched: true, value: null };
  return { matched: false };
}

function intrinsicBooleanValue(type: ts.Type, checker: ts.TypeChecker): boolean {
  const value = literalValue(type);
  if (value.matched && typeof value.value === "boolean") return value.value;
  return checker.typeToString(type) === "true";
}

function unionOfSchemas(schemas: readonly JsonSchema[]): JsonSchema {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0] ?? {};
  return { anyOf: schemas };
}

function propertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return ts.isComputedPropertyName(name)
    ? undefined
    : name.getText(sourceFile).replace(/^["']|["']$/g, "") || undefined;
}

function symbolDescription(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): string | undefined {
  const jsDoc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (jsDoc.length > 0) return jsDoc;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined) return undefined;
  const prefix = declaration
    .getFullText(sourceFile)
    .slice(0, -declaration.getText(sourceFile).length);
  const comments = [...prefix.matchAll(/^\s*\/\/\s?(.*?)\s*$/gm)].map((match) => match[1] ?? "");
  return comments.join(" ").trim() || undefined;
}

function withCompilerDiagnostics(
  schema: JsonSchema,
  program: ts.Program,
  sourceFile: ts.SourceFile,
): JsonSchema {
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
  if (diagnostics.length === 0) return schema;
  return {
    ...schema,
    [DIAGNOSTICS_KEY]: diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      category: ts.DiagnosticCategory[diagnostic.category],
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      start: diagnostic.start,
      length: diagnostic.length,
      source:
        diagnostic.start === undefined || diagnostic.length === undefined
          ? sourceFile.text
          : sourceFile.text.slice(diagnostic.start, diagnostic.start + diagnostic.length),
    })),
  };
}

function openFallback(
  type: ts.Type,
  context: SchemaContext,
  code: string,
  message: string,
): JsonSchema {
  return {
    [OPEN_FALLBACK_KEY]: {
      code,
      message,
      type: context.checker.typeToString(
        type,
        undefined,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
      ),
    },
  };
}

function withOpenFallback(
  schema: JsonSchema,
  type: ts.Type,
  context: SchemaContext,
  code: string,
  message: string,
): JsonSchema {
  return { ...schema, ...openFallback(type, context, code, message) };
}

function openFallbackFromSource(
  code: string,
  message: string,
  source: string,
  nodeKind: string,
): JsonSchema {
  return {
    [OPEN_FALLBACK_KEY]: { code, message, nodeKind, source },
  };
}

function emptyObjectSchema(): JsonSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}
