/**
 * Structured logging (FULLPLAN §52, audit H/M11 — Workers Logs is enabled in every scope).
 *
 * The codebase already emitted `console.error(JSON.stringify({ level, message, … }))` by hand in
 * a handful of places. This is the same line, written once, because the AI generation pipeline
 * needs it at **every stage** rather than only at the two ends: when a queued job silently does
 * nothing, the question an operator has is not "did it fail?" but "how far did it get?", and only
 * a per-stage trail answers that.
 *
 * Every line carries `pipeline` and `stage`, so a single Workers Logs filter
 * (`pipeline = "assessment_generation"`) replays one request end to end, and
 * `ai_request_id` stitches the HTTP leg to the queue leg — the two run in different
 * invocations and share no correlation id.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  /** The flow this line belongs to — `assessment_generation`, `knowledge_ingestion`, … */
  pipeline?: string;
  /** Where in that flow. Use the same vocabulary across the whole pipeline. */
  stage?: string;
  /** The `ai_requests.id` the client is polling. The join key across invocations. */
  ai_request_id?: string;
  correlation_id?: string;
  [key: string]: unknown;
}

const WRITERS: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/**
 * Emit one JSON line. Never throws: a logging failure must not be able to take down the request
 * it was describing — a circular value in `fields` would otherwise turn an observability call
 * into a 500.
 */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  let line: string;

  try {
    line = JSON.stringify({ level, message, ...fields });
  } catch {
    line = JSON.stringify({ level, message, log_serialization_failed: true });
  }

  WRITERS[level](line);
}

/**
 * A logger bound to one pipeline (and usually one `ai_request_id`), so call sites read as the
 * stage they are in rather than repeating the same three fields on every line.
 */
export function pipelineLogger(pipeline: string, base: LogFields = {}) {
  const emit =
    (level: LogLevel) =>
    (stage: string, fields: LogFields = {}): void => {
      log(level, `${pipeline}.${stage}`, { pipeline, stage, ...base, ...fields });
    };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    /** Narrow an unknown throw down to something worth putting in a log line or a DB column. */
    describeError,
  };
}

export type PipelineLogger = ReturnType<typeof pipelineLogger>;

/** `catch (error)` gives `unknown`; this is the one place that is turned into text. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
