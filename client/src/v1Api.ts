import type { components, paths } from "./generated/meridian-api";
import type { ZodType } from "zod";
import {
  AnnualRevenueSchema,
  CloseAccountingPeriodResponseSchema,
  ComboDiscountSchema,
  CustomerPageSchema,
  CustomerRevenueSchema,
  InvoicePageSchema,
  InvoiceSchema,
  IssueTenantApiKeyResponseSchema,
  OrderPageSchema,
  OrderSchema,
  PaymentPageSchema,
  PaymentApplicationReversalSchema,
  PaymentSchema,
  ProductPageSchema,
  QuarterRevenueSchema,
  RateSchema,
  RevokeTenantApiKeyResponseSchema,
  TransmissionSchema,
  ValidationErrorResponseSchema,
  ProblemDetailsSchema,
} from "@meridian/contracts";

/** HTTP methods represented by the generated v1 OpenAPI contract. */
export type V1HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type V1Path = keyof paths;

type Defined<T> = Exclude<T, undefined>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OperationFor<Path extends V1Path, Method extends V1HttpMethod> = paths[Path][Method] extends {
  readonly responses: unknown;
}
  ? paths[Path][Method]
  : never;

export type V1MethodForPath<Path extends V1Path> = {
  [Method in V1HttpMethod]: OperationFor<Path, Method> extends never ? never : Method;
}[V1HttpMethod];
type OperationKey = {
  [Path in V1Path]: {
    [Method in V1HttpMethod]: OperationFor<Path, Method> extends never ? never : `${Method} ${Path}`;
  }[V1HttpMethod];
}[V1Path];

type RuntimeResponseSchema = {
  readonly status: number;
  readonly errorStatuses: readonly number[];
  readonly schema: ZodType;
};

type ResponseSchema<Operation> = {
  readonly status: SuccessStatus<Operation>;
  readonly errorStatuses: readonly ErrorStatus<Operation>[];
  readonly schema: ZodType<SuccessData<Operation>>;
};
type OperationForKey<Key extends OperationKey> = Key extends `${infer Method} ${infer Path}`
  ? Path extends V1Path
    ? Method extends V1HttpMethod
      ? OperationFor<Path, Method>
      : never
    : never
  : never;
type ResponseSchemaMap = {
  readonly [Key in OperationKey]: ResponseSchema<OperationForKey<Key>>;
};

function successResponse<Status extends number, Output, ErrorStatuses extends readonly number[]>(
  status: Status,
  errorStatuses: ErrorStatuses,
  schema: ZodType<Output>,
) {
  return { status, errorStatuses, schema };
}

/**
 * Runtime schemas are deliberately complete: `satisfies` makes a generated
 * route/method addition fail the client typecheck until its untrusted success
 * representation has a browser-safe Zod validator.
 */
const responseSchemas = {
  "post /accounting-periods/close": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 500] as const, CloseAccountingPeriodResponseSchema),
  "get /customers": successResponse(200, [400, 401, 413, 500] as const, CustomerPageSchema),
  "get /invoices": successResponse(200, [400, 401, 403, 413, 500] as const, InvoicePageSchema),
  "get /invoices/{id}": successResponse(200, [400, 401, 403, 404, 413, 500] as const, InvoiceSchema),
  "put /invoices/{id}": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 422, 428, 500] as const, InvoiceSchema),
  "patch /invoices/{id}": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 422, 428, 500] as const, InvoiceSchema),
  "post /invoices/{id}/post": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 422, 500] as const, InvoiceSchema),
  "post /invoices/{id}/send": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 500] as const, InvoiceSchema),
  "post /invoices/transmissions/{transmissionId}/refresh": successResponse(200, [400, 401, 403, 404, 413, 500] as const, TransmissionSchema),
  "get /orders": successResponse(200, [400, 401, 403, 413, 500] as const, OrderPageSchema),
  "post /orders": successResponse(200, [400, 401, 403, 404, 413, 422, 500] as const, OrderSchema),
  "get /orders/{id}": successResponse(200, [400, 401, 403, 404, 413, 500] as const, OrderSchema),
  "put /orders/{id}": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 422, 428, 500] as const, OrderSchema),
  "patch /orders/{id}": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 422, 428, 500] as const, OrderSchema),
  "post /orders/{id}/invoice": successResponse(200, [400, 401, 403, 404, 409, 413, 422, 500] as const, InvoiceSchema),
  "get /payments": successResponse(200, [400, 401, 403, 413, 500] as const, PaymentPageSchema),
  "post /payments": successResponse(200, [400, 401, 403, 404, 413, 422, 500] as const, PaymentSchema),
  "get /payments/{id}": successResponse(200, [400, 401, 403, 404, 413, 500] as const, PaymentSchema),
  "post /payments/{id}/applications/{applicationId}/reversals": successResponse(201, [400, 401, 403, 404, 409, 412, 413, 422, 500] as const, PaymentApplicationReversalSchema),
  "post /payments/{id}/apply": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 422, 500] as const, PaymentSchema),
  "get /products": successResponse(200, [400, 401, 413, 500] as const, ProductPageSchema),
  "get /rates": successResponse(200, [400, 401, 404, 413, 500] as const, RateSchema.array()),
  "get /rates/{id}": successResponse(200, [400, 401, 404, 413, 500] as const, RateSchema),
  "put /rates/{id}": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 428, 500] as const, RateSchema),
  "patch /rates/{id}": successResponse(200, [400, 401, 403, 404, 409, 412, 413, 428, 500] as const, RateSchema),
  "get /rates/combos": successResponse(200, [400, 401, 404, 413, 500] as const, ComboDiscountSchema.array()),
  "post /rates/combos": successResponse(200, [400, 401, 403, 404, 409, 413, 422, 500] as const, ComboDiscountSchema),
  "get /reports/annual-revenue": successResponse(200, [400, 401, 403, 413, 500] as const, AnnualRevenueSchema.array()),
  "get /reports/revenue-by-customer": successResponse(200, [400, 401, 403, 413, 500] as const, CustomerRevenueSchema.array()),
  "get /reports/revenue-by-quarter": successResponse(200, [400, 401, 403, 413, 500] as const, QuarterRevenueSchema.array()),
  "post /tenant-api-keys": successResponse(201, [400, 401, 403, 409, 413, 500] as const, IssueTenantApiKeyResponseSchema),
  "post /tenant-api-keys/revoke": successResponse(200, [400, 401, 403, 404, 409, 413, 500] as const, RevokeTenantApiKeyResponseSchema),
} satisfies ResponseSchemaMap;

type ExactErrorStatusSet<Key extends OperationKey> = [
  Exclude<(typeof responseSchemas)[Key]["errorStatuses"][number], ErrorStatus<OperationForKey<Key>>>,
  Exclude<ErrorStatus<OperationForKey<Key>>, (typeof responseSchemas)[Key]["errorStatuses"][number]>,
] extends [never, never]
  ? true
  : false;
type Assert<T extends true> = T;
/** Compile-time drift guard: every documented non-2xx response appears exactly once. */
export type V1ErrorStatusRegistryIsCurrent = Assert<
  { [Key in OperationKey]: ExactErrorStatusSet<Key> }[OperationKey]
>;

type ParametersFor<Operation> = Operation extends { readonly parameters: infer Parameters }
  ? Parameters
  : never;
type ParameterGroup<Operation, Group extends "path" | "query" | "header"> = ParametersFor<Operation> extends infer Parameters
  ? Parameters extends { readonly [Key in Group]?: infer Value }
    ? Defined<Value>
    : never
  : never;

type HasRequiredKeys<Value> = [Value] extends [never]
  ? false
  : keyof Value extends never
    ? false
    : {} extends Pick<Value, keyof Value>
      ? false
      : true;

type ParameterInput<Operation> = Simplify<
  (ParameterGroup<Operation, "path"> extends never
    ? {}
    : HasRequiredKeys<ParameterGroup<Operation, "path">> extends true
      ? { readonly path: ParameterGroup<Operation, "path"> }
      : { readonly path?: ParameterGroup<Operation, "path"> }) &
    (ParameterGroup<Operation, "query"> extends never
      ? {}
      : HasRequiredKeys<ParameterGroup<Operation, "query">> extends true
        ? { readonly query: ParameterGroup<Operation, "query"> }
        : { readonly query?: ParameterGroup<Operation, "query"> }) &
    (ParameterGroup<Operation, "header"> extends never
      ? {}
      : HasRequiredKeys<ParameterGroup<Operation, "header">> extends true
        ? { readonly header: ParameterGroup<Operation, "header"> }
        : { readonly header?: ParameterGroup<Operation, "header"> })
>;

type JsonRequestBody<Operation> = Operation extends {
  readonly requestBody: { readonly content: { readonly "application/json": infer Body } };
}
  ? Body
  : never;

type ParameterOption<Operation> = HasRequiredKeys<ParameterInput<Operation>> extends true
  ? { readonly params: ParameterInput<Operation> }
  : { readonly params?: ParameterInput<Operation> };

type RequestOptions<Operation> = Simplify<
  ParameterOption<Operation> &
    { readonly signal?: AbortSignal } &
    (JsonRequestBody<Operation> extends never
      ? { readonly body?: never }
      : { readonly body: JsonRequestBody<Operation> })
>;

type RequestOptionArguments<Operation> = {} extends RequestOptions<Operation>
  ? readonly [options?: NoInfer<RequestOptions<Operation>>]
  : readonly [options: NoInfer<RequestOptions<Operation>>];

type ResponsesFor<Operation> = Operation extends { readonly responses: infer Responses }
  ? Responses
  : never;
type SuccessStatus<Operation> = Extract<
  keyof ResponsesFor<Operation>,
  200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226
>;
type SuccessData<Operation> = ResponsesFor<Operation>[SuccessStatus<Operation>] extends {
  readonly content: { readonly "application/json": infer Data };
}
  ? Data
  : never;
type ErrorStatus<Operation> = Extract<
  Exclude<keyof ResponsesFor<Operation>, SuccessStatus<Operation>>,
  number
>;
type ContentData<Response> = Response extends { readonly content: infer Content }
  ? Content extends object
    ? Content[keyof Content]
    : never
  : never;
type ErrorData<Operation> = ContentData<ResponsesFor<Operation>[ErrorStatus<Operation>]>;
type ContractProblem<Operation> = [Operation] extends [never]
  ? components["schemas"]["ProblemDetails"]
  : Extract<ErrorData<Operation>, components["schemas"]["ProblemDetails"]>;
type ContractValidationError<Operation> = [Operation] extends [never]
  ? components["schemas"]["ValidationError"]
  : Extract<ErrorData<Operation>, components["schemas"]["ValidationError"]>;
type ContractErrorStatus<Operation> = [Operation] extends [never] ? number : ErrorStatus<Operation>;

export type V1Success<Operation> = {
  readonly ok: true;
  readonly status: SuccessStatus<Operation>;
  /** The original response headers, retained for callers that need other contract headers. */
  readonly headers: Headers;
  readonly requestId: string | null;
  readonly etag: string | null;
  readonly link: string | null;
  readonly nextLink: string | null;
  readonly data: SuccessData<Operation>;
};

export type V1ProblemError<Operation = never> = {
  readonly kind: "problem";
  readonly status: ContractErrorStatus<Operation>;
  readonly headers: Headers;
  readonly requestId: string | null;
  readonly problem: ContractProblem<Operation>;
};

export type V1ValidationError<Operation = never> = {
  readonly kind: "validation";
  readonly status: ContractErrorStatus<Operation>;
  readonly headers: Headers;
  readonly requestId: string | null;
  readonly validation: ContractValidationError<Operation>;
};

export type V1ProtocolError = {
  readonly kind: "protocol";
  readonly status: number;
  readonly headers: Headers;
  readonly requestId: string | null;
  readonly phase: "success" | "error";
  readonly reason:
    | "empty-success"
    | "non-json-success"
    | "malformed-json-success"
    | "invalid-success"
    | "non-json-error"
    | "malformed-json-error"
    | "unexpected-error-json"
    | "problem-status-mismatch"
    | "unexpected-error-status"
    | "unexpected-success-status";
};

export type V1NetworkError = {
  readonly kind: "network";
  readonly message: "Network request failed";
};

export type V1AbortError = {
  readonly kind: "aborted";
  readonly message: "Request aborted";
};

export type V1RequestError = {
  readonly kind: "request";
  readonly reason: "missing-path-parameter" | "invalid-base-url";
};

export type V1Error<Operation = never> =
  | V1ProblemError<Operation>
  | V1ValidationError<Operation>
  | V1ProtocolError
  | V1NetworkError
  | V1AbortError
  | V1RequestError;
export type V1Result<Operation> = V1Success<Operation> | { readonly ok: false; readonly error: V1Error<Operation> };

export type V1Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateV1ClientOptions = {
  readonly baseUrl?: string;
  readonly fetch?: V1Fetch;
};

export type V1Client = {
  request<Path extends V1Path, Method extends V1MethodForPath<Path>>(
    path: Path,
    method: Method,
    ...options: RequestOptionArguments<OperationFor<NoInfer<Path>, NoInfer<Method>>>
  ): Promise<V1Result<OperationFor<Path, Method>>>;
};

type RuntimeParameters = {
  readonly path?: Record<string, string | number | boolean | undefined>;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly header?: Record<string, string | number | boolean | undefined>;
};

type RuntimeOptions = {
  readonly params?: RuntimeParameters;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
};

function normalizeBaseUrl(baseUrl: string): string | null {
  if (
    baseUrl.length === 0 ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    /\/{2,}$/u.test(baseUrl)
  ) {
    return null;
  }
  if (baseUrl.startsWith("/")) return baseUrl.startsWith("//") ? null : baseUrl.replace(/\/$/u, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return baseUrl.replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function encodePathTemplate(path: string, values: RuntimeParameters["path"]): string | null {
  let hasMissingValue = false;
  const encoded = path.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      hasMissingValue = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  return hasMissingValue ? null : encoded;
}

function appendQuery(url: string, query: RuntimeParameters["query"]): string {
  if (query === undefined) return url;
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) search.append(name, String(value));
  }
  const encoded = search.toString();
  return encoded.length === 0 ? url : `${url}?${encoded}`;
}

function requestHeaders(values: RuntimeParameters["header"], hasJsonBody: boolean): Headers {
  const headers = new Headers();
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) headers.set(name, String(value));
    }
  }
  if (hasJsonBody) headers.set("Content-Type", "application/json");
  return headers;
}

function hasResponseSchema(key: string): key is keyof typeof responseSchemas {
  return Object.hasOwn(responseSchemas, key);
}

function responseSchema(path: string, method: string): RuntimeResponseSchema | undefined {
  const key = `${method} ${path}`;
  return hasResponseSchema(key) ? responseSchemas[key] : undefined;
}

function contentType(response: Response): string | null {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function isJsonContentType(value: string | null): boolean {
  return value === "application/json" || value?.endsWith("+json") === true;
}

type LinkValue = { readonly target: string; readonly parameters: string };

function linkValues(header: string): readonly LinkValue[] {
  const values: LinkValue[] = [];
  let start = 0;
  let inQuotes = false;
  let inAngle = false;
  let escaped = false;
  for (let index = 0; index <= header.length; index += 1) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && inQuotes) {
      escaped = true;
    } else if (character === '"' && !inAngle) {
      inQuotes = !inQuotes;
    } else if (character === "<" && !inQuotes) {
      inAngle = true;
    } else if (character === ">" && !inQuotes) {
      inAngle = false;
    }
    if (index === header.length || (character === "," && !inQuotes && !inAngle)) {
      const part = header.slice(start, index).trim();
      start = index + 1;
      const match = /^<([^>]*)>\s*(.*)$/u.exec(part);
      if (match !== null) values.push({ target: match[1] ?? "", parameters: match[2] ?? "" });
    }
  }
  return values;
}

/** Returns the RFC 8288 `rel=next` target without changing the raw Link header. */
export function parseNextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const value of linkValues(header)) {
    const relations = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/giu;
    for (const relation of value.parameters.matchAll(relations)) {
      const names = (relation[1] ?? relation[2] ?? "").split(/\s+/u);
      if (names.some((name) => name.toLowerCase() === "next")) return value.target;
    }
  }
  return null;
}

function responseMetadata(response: Response) {
  const link = response.headers.get("link");
  return {
    headers: response.headers,
    requestId: response.headers.get("x-request-id"),
    etag: response.headers.get("etag"),
    link,
    nextLink: parseNextLink(link),
  };
}

function protocolError(
  response: Response,
  phase: V1ProtocolError["phase"],
  reason: V1ProtocolError["reason"],
): { readonly ok: false; readonly error: V1ProtocolError } {
  const metadata = responseMetadata(response);
  return {
    ok: false,
    error: { kind: "protocol", status: response.status, phase, reason, ...metadata },
  };
}

function isExpectedSuccessStatus<Operation>(
  status: number,
  schema: RuntimeResponseSchema | undefined,
): status is SuccessStatus<Operation> {
  return schema?.status === status;
}

function isExpectedErrorStatus<Operation>(
  status: number,
  schema: RuntimeResponseSchema | undefined,
): status is ErrorStatus<Operation> {
  return schema?.errorStatuses.includes(status) === true;
}

type RuntimeValidationResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false };

function validateSuccess(
  schema: RuntimeResponseSchema | undefined,
  value: unknown,
): RuntimeValidationResult {
  const result = schema?.schema.safeParse(value);
  return result?.success ? { success: true, data: result.data } : { success: false };
}

function isValidatedSuccess<Operation>(
  result: RuntimeValidationResult,
): result is { readonly success: true; readonly data: SuccessData<Operation> } {
  return result.success;
}

function isContractProblem<Operation>(value: unknown): value is ContractProblem<Operation> {
  return ProblemDetailsSchema.safeParse(value).success;
}

function isContractValidationError<Operation>(value: unknown): value is ContractValidationError<Operation> {
  return ValidationErrorResponseSchema.safeParse(value).success;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
  );
}

async function decode<Operation>(
  response: Response,
  schema: RuntimeResponseSchema | undefined,
): Promise<V1Result<Operation>> {
  const type = contentType(response);
  if (response.ok) {
    if (!isExpectedSuccessStatus<Operation>(response.status, schema)) {
      return protocolError(response, "success", "unexpected-success-status");
    }
    if (!isJsonContentType(type)) return protocolError(response, "success", "non-json-success");

    let text: string;
    try {
      text = await response.text();
    } catch {
      return protocolError(response, "success", "malformed-json-success");
    }
    if (text.trim().length === 0) return protocolError(response, "success", "empty-success");
    try {
      const parsed = JSON.parse(text) as unknown;
      const validated = validateSuccess(schema, parsed);
      if (!isValidatedSuccess<Operation>(validated)) {
        return protocolError(response, "success", "invalid-success");
      }
      return {
        ok: true,
        status: response.status,
        ...responseMetadata(response),
        data: validated.data,
      };
    } catch {
      return protocolError(response, "success", "malformed-json-success");
    }
  }

  if (!isExpectedErrorStatus<Operation>(response.status, schema)) {
    return protocolError(response, "error", "unexpected-error-status");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return protocolError(response, "error", "malformed-json-error");
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return protocolError(response, "error", isJsonContentType(type) ? "malformed-json-error" : "non-json-error");
  }

  const metadata = responseMetadata(response);
  if (isContractProblem<Operation>(data) && data.status === response.status) {
    return {
      ok: false,
      error: {
        kind: "problem",
        status: response.status,
        problem: data,
        ...metadata,
      },
    };
  }
  if (isContractProblem<Operation>(data)) return protocolError(response, "error", "problem-status-mismatch");
  if (isContractValidationError<Operation>(data)) {
    return {
      ok: false,
      error: {
        kind: "validation",
        status: response.status,
        validation: data,
        ...metadata,
      },
    };
  }
  return protocolError(response, "error", "unexpected-error-json");
}

/**
 * Contract-derived v1 HTTP client. It deliberately has no response generic:
 * the allowed route, method, arguments, and successful payload all come from
 * `paths` generated from the OpenAPI document.
 */
class V1ClientImplementation implements V1Client {
  constructor(
    private readonly baseUrl: string | null,
    private readonly fetchImpl: V1Fetch,
  ) {}

  async request<Path extends V1Path, Method extends V1MethodForPath<Path>>(
    path: Path,
    method: Method,
    ...requestOptions: RequestOptionArguments<OperationFor<NoInfer<Path>, NoInfer<Method>>>
  ): Promise<V1Result<OperationFor<Path, Method>>> {
    const options = requestOptions[0] as RuntimeOptions | undefined;
    if (this.baseUrl === null) {
      return { ok: false, error: { kind: "request", reason: "invalid-base-url" } };
    }
    const encodedPath = encodePathTemplate(path, options?.params?.path);
    if (encodedPath === null) {
      return { ok: false, error: { kind: "request", reason: "missing-path-parameter" } };
    }
    const hasJsonBody = options?.body !== undefined;
    const url = appendQuery(
      `${this.baseUrl}${encodedPath}`,
      options?.params?.query,
    );
    try {
      const response = await this.fetchImpl(url, {
        method: method.toUpperCase(),
        headers: requestHeaders(options?.params?.header, hasJsonBody),
        body: hasJsonBody ? JSON.stringify(options.body) : undefined,
        signal: options?.signal,
      });
      return decode<OperationFor<Path, Method>>(response, responseSchema(path, method));
    } catch (error: unknown) {
      if (isAbortError(error, options?.signal)) {
        return { ok: false, error: { kind: "aborted", message: "Request aborted" } };
      }
      return { ok: false, error: { kind: "network", message: "Network request failed" } };
    }
  }
}

export function createV1Client({ baseUrl = "/api/v1", fetch: fetchImpl = globalThis.fetch }: CreateV1ClientOptions = {}): V1Client {
  return new V1ClientImplementation(normalizeBaseUrl(baseUrl), fetchImpl);
}
