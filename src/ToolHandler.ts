/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParsedArguments} from './config/ConfigParser.js';
import type {McpContext} from './McpContext.js';
import type {McpPage} from './McpPage.js';
import {McpResponse} from './McpResponse.js';
import {SlimMcpResponse} from './SlimMcpResponse.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import type {CallToolResult, Mutex} from './third_party/index.js';
import {zod} from './third_party/index.js';
import {labels} from './tools/categories.js';
import {categoryToFlagName} from './config/category-options.js';
import type {
  DefinedPageTool,
  DevToolsData,
  FileVerificationOption,
  ToolDefinition,
} from './tools/ToolDefinition.js';
import {isAvailableInMode, isSlimTool} from './tools/ToolDefinition.js';
import {logger} from './utils/logger.js';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {isLocalhost} from './utils/url.js';

/**
 * Upper bound on how long a tool call may wait to acquire the browser
 * (connect/launch and McpContext initialization). A connect attempt on a
 * half-open socket can hang without ever failing; this bound turns that into
 * a clear error and abandons the attempt so the next call starts fresh.
 *
 * This does not bound the tool's own work. A slow but valid call (a long
 * `wait_for` timeout, an `evaluate_script` awaiting a slow promise, a
 * Lighthouse audit) must finish on its own terms without the browser being
 * closed underneath it. A transport that dies mid-call is detected by the
 * WebSocket keep-alive configured in BrowserManager#connect(), which rejects
 * the in-flight CDP calls and fires `disconnected`.
 */
export const TOOL_CALL_TIMEOUT_MS = 60_000;

class ToolCallTimeoutError extends Error {}

function buildDisabledMessage(
  toolName: string,
  flag: string,
  categoryLabel?: string,
): string {
  const reason = categoryLabel
    ? `is in category ${categoryLabel} which`
    : `requires ${flag.startsWith('--experimental') ? 'experimental feature' : 'flag'} ${flag} and`;

  return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}

function getToolStatusInfo(
  tool: ToolDefinition | DefinedPageTool,
  serverArgs: ParsedArguments,
): {disabled: boolean; reason?: string; unavailableInMode?: boolean} {
  if (!isAvailableInMode(tool, serverArgs)) {
    return {
      disabled: true,
      unavailableInMode: true,
      reason: isSlimTool(tool)
        ? `Tool ${tool.name} is only available with --slim.`
        : `Tool ${tool.name} is not available with --slim.`,
    };
  }

  const category = tool.annotations.category;
  if (category) {
    const flag = categoryToFlagName(category);
    if (!serverArgs[flag]) {
      return {
        disabled: true,
        reason: buildDisabledMessage(tool.name, `--${flag}`, labels[category]),
      };
    }
  }

  for (const condition of tool.annotations.conditions || []) {
    if (!serverArgs[condition]) {
      return {
        disabled: true,
        reason: buildDisabledMessage(tool.name, `--${condition}`),
      };
    }
  }

  return {disabled: false};
}

function isPageScopedTool(
  tool: ToolDefinition | DefinedPageTool,
): tool is DefinedPageTool {
  return 'pageScoped' in tool && tool.pageScoped === true;
}

async function validateAndResolvePathOrUrl(
  filePathOrUrl: string,
  context: McpContext,
): Promise<string | undefined> {
  if (filePathOrUrl.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(filePathOrUrl);
    if (url.protocol === 'file:') {
      return pathToFileURL(await context.validatePath(fileURLToPath(url))).href;
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      return filePathOrUrl;
    }
  } catch {
    // Suppress parsing errors for regular file paths.
  }
  return await context.validatePath(filePathOrUrl);
}

function isLocalBrowser(context: McpContext): boolean {
  if (context.browser.process()) {
    return true;
  }
  const wsEndpoint = context.browser.wsEndpoint();
  if (wsEndpoint && isLocalhost(wsEndpoint)) {
    return true;
  }
  return false;
}

function shouldValidateFile(
  option: FileVerificationOption | undefined,
  isLocal: boolean,
): boolean {
  if (option === true) {
    return true;
  }
  if (typeof option === 'object' && option !== null) {
    if (isLocal) {
      return Boolean(option.local);
    }
    return Boolean(option.remote);
  }
  return false;
}

async function validateToolFiles(
  tool: ToolDefinition | DefinedPageTool,
  params: Record<string, unknown>,
  context: McpContext,
): Promise<void> {
  const isLocal = isLocalBrowser(context);
  for (const [key, option] of Object.entries(tool.verifyFilesSchema)) {
    if (shouldValidateFile(option, isLocal)) {
      const val = params[key];
      if (typeof val === 'string') {
        params[key] = await validateAndResolvePathOrUrl(val, context);
      } else if (Array.isArray(val)) {
        const updated: unknown[] = [];
        for (const item of val) {
          if (typeof item === 'string') {
            const resolved = await validateAndResolvePathOrUrl(item, context);
            if (resolved !== undefined) {
              updated.push(resolved);
            }
          } else {
            throw new Error(
              'Unexpected non-string value as a file path or URL',
            );
          }
        }
        params[key] = updated;
      }
    }
  }
}

function toInputJsonSchema(schema: zod.ZodType): unknown {
  return zod.toJSONSchema(schema, {io: 'input', unrepresentable: 'any'});
}

export class ToolHandler {
  #tool: ToolDefinition | DefinedPageTool;
  #serverArgs: ParsedArguments;
  #inputSchema: zod.ZodRawShape = {};
  #registeredInputSchema: zod.ZodObject<zod.ZodRawShape, zod.core.$strict> = zod
    .object({})
    .strict();
  #inputJsonSchema: ReturnType<typeof toInputJsonSchema> = toInputJsonSchema(
    this.#registeredInputSchema,
  );
  /**
   * Incremented whenever an update changes the input schema the client sees.
   */
  #schemaVersion = 0;
  #validatedParamsVersion = new WeakMap<Record<string, unknown>, number>();
  #disabled = false;
  #disabledReason?: string;

  constructor(
    tool: ToolDefinition | DefinedPageTool,
    serverArgs: ParsedArguments,
    private readonly getContext: () => Promise<McpContext>,
    private readonly toolMutex: Mutex,
    private readonly abandonPendingBrowserAttemptOnTimeout: () => void,
  ) {
    this.#tool = tool;
    this.#serverArgs = serverArgs;
    this.update(tool, serverArgs);
  }

  get inputSchema(): zod.ZodRawShape {
    return this.#inputSchema;
  }

  get registeredInputSchema(): zod.ZodObject<
    zod.ZodRawShape,
    zod.core.$strict
  > {
    return this.#registeredInputSchema;
  }

  /**
   * Whether the tool is hidden from the client.
   */
  get disabled(): boolean {
    return this.#disabled;
  }

  /**
   * Whether calls to the tool are executed. Unlike `disabled`, this is false
   * for tools that stay listed with --viaCli but only return an error.
   */
  get callable(): boolean {
    return this.#disabledReason === undefined;
  }

  /**
   * Replaces the tool definition and arguments. Callers must hold the tool
   * mutex, so calls that are already waiting for it run with the new state.
   * Returns true if the tool listing visible to the client changed.
   */
  update(
    tool: ToolDefinition | DefinedPageTool,
    serverArgs: ParsedArguments,
  ): boolean {
    const previousTool = this.#tool;
    const previousDisabled = this.#disabled;
    const {disabled, reason, unavailableInMode} = getToolStatusInfo(
      tool,
      serverArgs,
    );
    this.#tool = tool;
    this.#serverArgs = serverArgs;
    this.#disabledReason = reason;
    this.#disabled =
      disabled && (Boolean(unavailableInMode) || !serverArgs.viaCli);
    const nextInputSchema = zod.object(tool.schema).strict();
    const nextInputJsonSchema = toInputJsonSchema(nextInputSchema);
    const schemaChanged = !isDeepStrictEqual(
      this.#inputJsonSchema,
      nextInputJsonSchema,
    );
    if (schemaChanged) {
      this.#schemaVersion++;
    }
    const schemaVersion = this.#schemaVersion;
    const registeredInputSchema = nextInputSchema.check(ctx => {
      this.#validatedParamsVersion.set(ctx.value, schemaVersion);
    });
    const listingChanged =
      schemaChanged ||
      previousDisabled !== this.#disabled ||
      previousTool.description !== tool.description ||
      !isDeepStrictEqual(previousTool.annotations, tool.annotations);
    this.#inputSchema = tool.schema;
    this.#registeredInputSchema = registeredInputSchema;
    this.#inputJsonSchema = nextInputJsonSchema;
    return listingChanged;
  }

  /**
   * Releases state owned by this tool.
   */
  async releaseState(context: McpContext): Promise<void> {
    await this.#tool.releaseState?.(context);
  }

  /**
   * Races a promise against TOOL_CALL_TIMEOUT_MS, calling onTimeout() if the
   * timer wins. The loser of the race is left running — there is no way to
   * cancel a pending connect/launch — but since nothing is left awaiting it,
   * it cannot block subsequent tool calls.
   */
  async #raceWithTimeout<T>(
    promise: Promise<T>,
    onTimeout: () => void,
  ): Promise<T> {
    const timeoutError = new ToolCallTimeoutError(
      `Tool "${this.#tool.name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms waiting for the browser connection to be established. The connection attempt will be retried automatically on the next tool call.`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), TOOL_CALL_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch (err) {
      if (err === timeoutError) {
        onTimeout();
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  handle = async (
    validatedParams: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const schemaVersionAtCall =
      this.#validatedParamsVersion.get(validatedParams) ?? this.#schemaVersion;
    using guard = await this.toolMutex.acquire();

    if (this.#disabledReason) {
      return {
        content: [
          {
            type: 'text',
            text: this.#disabledReason,
          },
        ],
        isError: true,
      };
    }

    const tool = this.#tool;
    const serverArgs = this.#serverArgs;
    if (schemaVersionAtCall !== this.#schemaVersion) {
      // The tool was updated while this call waited for the mutex, so the
      // params were validated against the previous schema.
      return {
        content: [
          {
            type: 'text',
            text: `The input schema of tool ${tool.name} changed because the server configuration was reloaded. List the tools again and retry the call with the new parameters.`,
          },
        ],
        isError: true,
      };
    }
    const params = validatedParams;

    const startTime = Date.now();
    let success = false;
    let devToolsData: DevToolsData | undefined;
    let pageUrl: string | undefined;
    try {
      logger?.(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
      // ensureBrowser() has no cancellation mechanism, so this timeout only
      // stops us from waiting — the attempt itself keeps running abandoned.
      // abandonPendingBrowserAttemptOnTimeout() tells BrowserManager to
      // discard that attempt if it succeeds later instead of handing it to a
      // subsequent caller — see BrowserManager#abandonPendingAttempt()'s doc
      // comment for the full mechanism.
      const context = await this.#raceWithTimeout(this.getContext(), () =>
        this.abandonPendingBrowserAttemptOnTimeout(),
      );
      logger?.(`${tool.name} context: resolved`);
      const response = isSlimTool(tool)
        ? new SlimMcpResponse(serverArgs)
        : new McpResponse(serverArgs);

      response.setRedactNetworkHeaders(serverArgs.redactNetworkHeaders);
      if (context.consumeReconnectNotice()) {
        response.setReconnectNotice();
      }
      let page: McpPage | undefined;
      try {
        await validateToolFiles(tool, params, context);
        if (isPageScopedTool(tool)) {
          const pageId =
            typeof params.pageId === 'number' ? params.pageId : undefined;
          page =
            serverArgs.pageIdRouting &&
            pageId !== undefined &&
            !isSlimTool(tool)
              ? context.getPageById(pageId)
              : context.getSelectedMcpPage();
          await page?.init();
          response.setPage(page);
          if (tool.blockedByDialog) {
            page.throwIfDialogOpen();
          }
          await tool.handler(
            {
              params,
              page,
            },
            response,
            context,
          );
        } else {
          await tool.handler(
            {
              params,
            },
            response,
            context,
          );
        }
      } catch (err) {
        response.setError(err);
      }
      devToolsData = await context.getDevToolsData(page);
      pageUrl = context.getSelectedMcpPageUrl(page);
      // --experimentalDataFormat takes precedence over the legacy
      // --experimentalToonFormat.
      const dataFormat =
        serverArgs.experimentalDataFormat ??
        (serverArgs.experimentalToonFormat ? 'toon' : 'default');
      const {content, structuredContent} = await response.handle(
        context,
        dataFormat,
      );
      const result: CallToolResult & {
        structuredContent?: Record<string, unknown>;
      } = {
        content,
      };
      if (response.error) {
        result.isError = true;
      }
      success = true;
      if (serverArgs.experimentalStructuredContent) {
        result.structuredContent = structuredContent as Record<string, unknown>;
      }
      return result;
    } catch (err) {
      logger?.(`${tool.name} error:`, err, err?.stack);
      let errorText = err && 'message' in err ? err.message : String(err);
      if ('cause' in err && err.cause) {
        errorText += `\nCause: ${err.cause.message}`;
      }
      return {
        content: [
          {
            type: 'text',
            text: errorText,
          },
        ],
        isError: true,
      };
    } finally {
      void ClearcutLogger.get()?.logToolInvocation({
        toolName: tool.name,
        params,
        schema: tool.schema,
        success,
        latencyMs: Date.now() - startTime,
        devToolsData,
        pageUrl,
      });
    }
  };
}
